/**
 * Effects, ported from the ffmpeg filters they are named after.
 *
 * There is no ffmpeg here — nothing in this project links or ships it — so each
 * of these is the filter's algorithm rewritten against `Pcm`. Every one was
 * written from the corresponding file in `libavfilter`, named in the comment
 * above it, and the option names, defaults and ranges in `effect-registry.ts`
 * come from the same `AVOption` tables. Where this deviates, the comment says
 * so and why.
 *
 * Two deviations apply throughout:
 *
 *   Output is not clipped. Several of these filters clamp to ±1 on the way out
 *   because their sample format demands it. This editor keeps float headroom
 *   all the way to export — the same reason `dsp.applyGain` does not clamp —
 *   so a boost followed by Normalise recovers instead of baking in distortion.
 *   Where clipping is an *option* of the filter rather than a format
 *   constraint, as in crystalizer, it is kept and exposed.
 *
 *   Filter state starts cold at the beginning of the selection. A delay line or
 *   an IIR applied to part of a track has nothing to prime itself with, so the
 *   first few milliseconds ramp up from silence, and the tail that would have
 *   continued past the end of the selection is not written. That is inherent to
 *   a range-limited edit, not a defect in the port.
 *
 * Like everything in `dsp.ts`, each function takes a `Pcm` and returns a new
 * one without mutating its input.
 */
import {
  df1State,
  highPass,
  lowPass,
  lowPassSlope,
  lowShelf,
  normalizeDcGain,
  runDf1,
  runTdf2,
  tdf2State,
} from './biquad';
import { type Pcm, type Range, clampRange, clonePcm } from './pcm';

/** ffmpeg designs every plain highpass and lowpass in these filters at Q = 0.707. */
const RBJ_Q = 0.707;

export type EffectValues = Readonly<Record<string, number>>;

// ------------------------------------------------------------------ C helpers

/**
 * C's `round`, which breaks ties away from zero. `Math.round` breaks them
 * towards +∞, so the two disagree on every negative half — which in a
 * bit-crusher is every other quantisation step.
 */
function cRound(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/**
 * C's `lrint` under the default rounding mode, which breaks ties to even.
 *
 * `Math.round` breaks them upward, and the difference is not academic: a
 * tremolo at 5 Hz on a 44.1 kHz track sizes its table from 8820.5, so the two
 * disagree by one sample per cycle and the modulation drifts out of phase over
 * the length of a track.
 */
function lrint(value: number): number {
  const rounded = Math.round(value);
  if (Math.abs(value % 1) !== 0.5) return rounded;
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

/** ffmpeg's `FFSIGN`, which is −1 at zero rather than 0. */
function ffSign(value: number): number {
  return value > 0 ? 1 : -1;
}

/** `av_clipd`: comparison-based, so a NaN passes straight through, as in C. */
function clipD(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * `MOD(a, b)` from af_aecho.c, af_chorus.c and af_aphaser.c: one conditional
 * subtraction, which is only correct because every argument is below `2b`.
 */
function mod(a: number, b: number): number {
  return a >= b ? a - b : a;
}

/**
 * The error function, for asoftclip's `erf` curve. C has `erff`; JavaScript has
 * no erf at all, so this is Abramowitz & Stegun 7.1.26 (Handbook of
 * Mathematical Functions, NBS Applied Mathematics Series 55), whose stated
 * maximum absolute error is 1.5 × 10⁻⁷ — below the resolution of 24-bit audio.
 */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * z);
  const poly =
    t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return sign * (1 - poly * Math.exp(-z * z));
}

type WaveShape = 'sin' | 'tri';

/**
 * `ff_generate_wave_table` from libavfilter/generate_wave_table.c, which
 * aphaser, chorus and flanger all build their modulation from.
 *
 * `integer` reproduces the rounding those filters get from asking for an S32
 * table: add half with the sign and truncate, which is round-half-away-from-
 * zero. flanger asks for floats and skips it.
 */
function generateWaveTable(
  shape: WaveShape,
  size: number,
  min: number,
  max: number,
  phase: number,
  integer: boolean,
): Float64Array {
  const table = new Float64Array(size);
  const phaseOffset = Math.trunc((phase / Math.PI / 2) * size + 0.5);

  for (let i = 0; i < size; i++) {
    const point = (i + phaseOffset) % size;
    let d: number;

    if (shape === 'sin') {
      d = (Math.sin((point / size) * 2 * Math.PI) + 1) / 2;
    } else {
      d = (point * 2) / size;
      // Integer division in the C, so the quarter is a floor.
      switch (Math.floor((4 * point) / size)) {
        case 0:
          d = d + 0.5;
          break;
        case 1:
        case 2:
          d = 1.5 - d;
          break;
        default:
          d = d - 1.5;
          break;
      }
    }

    d = d * (max - min) + min;
    table[i] = integer ? Math.trunc(d + (d < 0 ? -0.5 : 0.5)) : d;
  }
  return table;
}

/** Clones `pcm` and hands the caller the range to write into. */
function prepare(pcm: Pcm, range: Range): { out: Pcm; start: number; end: number } {
  const { start, end } = clampRange(pcm, range);
  return { out: clonePcm(pcm), start, end };
}

// ------------------------------------------------------------------ af_bass

/**
 * `bass` — libavfilter/af_biquads.c.
 *
 * A low shelf in direct form I, which is that filter's default transform. Its
 * `poles` and `width_type` options are left at ffmpeg's defaults (2 and
 * QFACTOR); `normalize` is off there by default, so no DC correction is
 * applied here either.
 */
export function bass(pcm: Pcm, range: Range, p: EffectValues): Pcm {
  const { out, start, end } = prepare(pcm, range);
  const filter = lowShelf(pcm.sampleRate, p.frequency, p.gain, p.width, 'q', 'bass');

  for (let c = 0; c < pcm.channels.length; c++) {
    const source = pcm.channels[c];
    const target = out.channels[c];
    const state = df1State();
    for (let i = start; i < end; i++) target[i] = runDf1(filter, source[i], state);
  }
  return out;
}

// ------------------------------------------------------------ af_crystalizer

/**
 * `crystalizer` — libavfilter/af_crystalizer.c.
 *
 * `y = x + (x − x₋₁) · i`. A first-order differentiator added back to the
 * signal, so it lifts whatever changes fastest. Note the spelling: ffmpeg's
 * filter has one `l`.
 *
 * A negative intensity is not that filter with a negative coefficient. ffmpeg
 * dispatches on the sign (`s->filter[mult >= 0][clip]`) and a negative one
 * selects the *inverse* recursion, `y = (x − y₋₁·i) / (1 − i)`, which feeds its
 * own output back rather than the input — it undoes a crystalizer instead of
 * applying a reversed one. Either way the state is stored before clipping, so
 * the clamp cannot feed back into the filter.
 */
export function crystalizer(pcm: Pcm, range: Range, p: EffectValues): Pcm {
  const { out, start, end } = prepare(pcm, range);
  const intensity = p.intensity;
  const clip = p.clip >= 0.5;
  const inverse = intensity < 0;
  const scale = 1 / (1 - intensity);

  for (let c = 0; c < pcm.channels.length; c++) {
    const source = pcm.channels[c];
    const target = out.channels[c];
    let previous = 0;
    for (let i = start; i < end; i++) {
      const current = source[i];
      let value: number;
      if (inverse) {
        value = (current - previous * intensity) * scale;
        previous = value;
      } else {
        value = current + (current - previous) * intensity;
        previous = current;
      }
      if (clip) value = clipD(value, -1, 1);
      target[i] = value;
    }
  }
  return out;
}

// -------------------------------------------------------------- af_acrusher

interface SampleReducer {
  target: number;
  real: number;
  samples: number;
  last: number;
}

/**
 * `acrusher` — libavfilter/af_acrusher.c.
 *
 * Two reductions in series: sample-rate reduction (hold the last value for
 * `samples` input samples, with a fractional accumulator so non-integer rates
 * work) and bit reduction, in a linear or logarithmic scale, with an
 * anti-aliasing term that softens the step edges rather than rounding hard.
 */
export function acrusher(pcm: Pcm, range: Range, p: EffectValues): Pcm {
  const { out, start, end } = prepare(pcm, range);
  const channels = pcm.channels.length;

  const levelIn = p.levelIn;
  const levelOut = p.levelOut;
  const mix = p.mix;
  const logarithmic = p.mode >= 0.5;
  const useLfo = p.lfo >= 0.5;

  const dc = p.dc;
  const idc = 1 / dc;
  const coeff = Math.pow(2, p.bits) - 1;
  const sqr = Math.sqrt(coeff / 2);
  const aa = p.aa;
  const aa1 = (1 - aa) / 2;

  // The LFO sweeps the sample-hold length between two bounds that are pushed
  // back inside [1, 250] without changing the width of the sweep.
  const radius = p.lfoRange / 2;
  let smin = Math.max(p.samples - radius, 1);
  const under = p.samples - radius - smin;
  let smax = Math.min(p.samples + radius, 250);
  const over = p.samples + radius - smax;
  smax -= under;
  smin -= over;
  const sdiff = smax - smin;

  const lfoStep = p.lfoRate / pcm.sampleRate;
  let lfoPhase = 0;

  let samples = p.samples;
  let hold = cRound(samples);

  const factor = (y: number, k: number): number =>
    0.5 * (Math.sin((Math.PI * (Math.abs(y - k) - aa1)) / aa - Math.PI / 2) + 1);

  const bitreduction = (input: number): number => {
    // Add DC: an asymmetric scaling that shifts where the quantisation steps
    // land relative to zero, then is undone on the way out.
    let value = input > 0 ? input * dc : input * idc;
    let y: number;
    let k: number;

    if (!logarithmic) {
      y = value * coeff;
      k = cRound(y);
      if (k - aa1 <= y && y <= k + aa1) {
        k /= coeff;
      } else if (y > k + aa1) {
        k = k / coeff + ((k + 1) / coeff - k / coeff) * factor(y, k);
      } else {
        k = k / coeff - (k / coeff - (k - 1) / coeff) * factor(y, k);
      }
    } else {
      y = sqr * Math.log(Math.abs(value)) + sqr * sqr;
      k = cRound(y);
      if (value === 0) {
        k = 0;
      } else if (k - aa1 <= y && y <= k + aa1) {
        k = (value / Math.abs(value)) * Math.exp(k / sqr - sqr);
      } else if (y > k + aa1) {
        const x = Math.exp(k / sqr - sqr);
        k = ffSign(value) * (x + (Math.exp((k + 1) / sqr - sqr) - x) * factor(y, k));
      } else {
        const x = Math.exp(k / sqr - sqr);
        k = (value / Math.abs(value)) * (x - (x - Math.exp((k - 1) / sqr - sqr)) * factor(y, k));
      }
    }

    k += (value - k) * mix;
    value = k > 0 ? k * idc : k * dc;
    return value;
  };

  const reducers: SampleReducer[] = Array.from({ length: channels }, () => ({
    target: 0,
    real: 0,
    samples: 0,
    last: 0,
  }));

  const samplereduction = (sr: SampleReducer, input: number): number => {
    sr.samples++;
    if (sr.samples >= hold) {
      sr.target += samples;
      sr.real += hold;
      if (sr.target + samples >= sr.real + 1) {
        sr.last = input;
        sr.target = 0;
        sr.real = 0;
      }
      sr.samples = 0;
    }
    return sr.last;
  };

  for (let i = start; i < end; i++) {
    if (useLfo) {
      // lfo_get: phase is scaled by the pulse width (fixed at 1 here, as
      // acrusher never sets it), wrapped, and read as a sine at amount 0.5.
      let phs = Math.min(100, lfoPhase);
      if (phs > 1) phs %= 1;
      const value = Math.sin(phs * 2 * Math.PI) * 0.5;
      samples = smin + sdiff * (value + 0.5);
      hold = Math.round(samples);
    }

    for (let c = 0; c < channels; c++) {
      const dry = pcm.channels[c][i];
      const sample = mix * samplereduction(reducers[c], dry * levelIn) + dry * (1 - mix) * levelIn;
      out.channels[c][i] = bitreduction(sample) * levelOut;
    }

    if (useLfo) {
      lfoPhase = Math.abs(lfoPhase + lfoStep);
      if (lfoPhase >= 1) lfoPhase %= 1;
    }
  }
  return out;
}

// -------------------------------------------------------------- af_aexciter

/**
 * `aexciter` — libavfilter/af_aexciter.c.
 *
 * Highpass the signal, push it through an asymmetric transfer curve whose
 * shape comes from `drive` and `blend`, DC-block the result, highpass again,
 * and add it back on top of the dry signal. The harmonics it generates all sit
 * above `freq`, which is what makes it read as air rather than as distortion.
 */
export function aexciter(pcm: Pcm, range: Range, p: EffectValues): Pcm {
  const { out, start, end } = prepare(pcm, range);
  const rate = pcm.sampleRate;

  const rdrive = 12 / p.drive;
  const rbdr = (rdrive / (10.5 - p.blend)) * (780 / 33);

  // `D` is a square root that treats anything under 1e-8 as zero, so a
  // negative radicand from an extreme drive cannot produce NaN.
  const d = (x: number): number => {
    const v = Math.abs(x);
    return v > 0.00000001 ? Math.sqrt(v) : 0;
  };
  const m = (x: number): number => (Math.abs(x) > 0.00000001 ? x : 0);

  const kpa = d(2 * (rdrive * rdrive) - 1) + 1;
  const kpb = (2 - kpa) / 2;
  const ap = (rdrive * rdrive - kpa + 1) / 2;
  const kc = kpa / d(2 * d(2 * (rdrive * rdrive) - 1) - 2 * rdrive * rdrive);

  const srct = (0.1 * rate) / (0.1 * rate + 1);
  const sq = kc * kc + 1;
  const knb = (-1 * rbdr) / d(sq);
  const kna = (2 * kc * rbdr) / d(sq);
  const an = (rbdr * rbdr) / sq;
  const imr = 2 * knb + d(2 * kna + 4 * an - 1);
  const pwrq = 2 / (imr + 1);

  const hp = highPass(rate, p.freq, RBJ_Q);
  const lp = lowPass(rate, p.ceil, RBJ_Q);
  const useCeiling = p.ceil >= 10000;

  const amount = p.amount;
  const levelIn = p.levelIn;
  const levelOut = p.levelOut;

  for (let c = 0; c < pcm.channels.length; c++) {
    const source = pcm.channels[c];
    const target = out.channels[c];
    const hw = [tdf2State(), tdf2State(), tdf2State(), tdf2State()];
    const lw = [tdf2State(), tdf2State()];
    let prevMed = 0;
    let prevOut = 0;

    for (let i = start; i < end; i++) {
      const dry = source[i];
      let proc = dry * levelIn;

      proc = runTdf2(hp, proc, hw[0]);
      proc = runTdf2(hp, proc, hw[1]);

      const med =
        proc >= 0
          ? (d(ap + proc * (kpa - proc)) + kpb) * pwrq
          : (d(an - proc * (kna + proc)) + knb) * pwrq * -1;

      // One-pole DC blocker, which is what keeps the asymmetric curve from
      // dragging the whole signal off centre.
      proc = srct * (med - prevMed + prevOut);
      prevMed = m(med);
      prevOut = m(proc);

      proc = runTdf2(hp, proc, hw[2]);
      proc = runTdf2(hp, proc, hw[3]);

      if (useCeiling) {
        proc = runTdf2(lp, proc, lw[0]);
        proc = runTdf2(lp, proc, lw[1]);
      }

      target[i] = (proc * amount + dry) * levelOut;
    }
  }
  return out;
}

// -------------------------------------------------------------- af_asoftclip

const SOFTCLIP_CURVES = ['hard', 'tanh', 'atan', 'cubic', 'exp', 'alg', 'quintic', 'sin', 'erf'] as const;

/**
 * Input frames per pass of the oversampled soft-clip path.
 *
 * One buffer over the whole selection would be the selection times the
 * oversampling factor: at 8× a five-minute stereo track wants the better part
 * of a gigabyte, which a phone answers by killing the tab. The only state that
 * has to survive a block boundary is the two biquads, so this is exactly
 * equivalent to processing it in one pass.
 */
const SOFTCLIP_BLOCK = 8192;

/**
 * `asoftclip` — libavfilter/af_asoftclip.c.
 *
 * Nine saturation curves, all applied to the signal scaled by 1/threshold and
 * scaled back by `output · threshold` afterwards.
 *
 * `oversample` is implemented as ffmpeg does it: zero-stuff, lowpass at the
 * original Nyquist, clip, lowpass again, decimate. Clipping generates
 * harmonics above Nyquist, and without the oversampled path those fold back
 * down as inharmonic aliases — audible as a metallic edge that gets worse the
 * higher the source content.
 */
export function asoftclip(pcm: Pcm, range: Range, p: EffectValues): Pcm {
  const { out, start, end } = prepare(pcm, range);
  const oversample = Math.max(1, Math.round(p.oversample));
  const threshold = p.threshold;
  const gain = p.output * threshold;
  const factor = 1 / threshold;
  const param = p.param;
  const scale = oversample > 1 ? oversample * 0.5 : 1;
  const curve = SOFTCLIP_CURVES[Math.round(p.type)] ?? 'tanh';

  const shape = (value: number): number => {
    const sample = value * factor;
    switch (curve) {
      case 'hard':
        return clipD(sample, -1, 1);
      case 'tanh':
        return Math.tanh(sample * param);
      case 'atan':
        return (2 / Math.PI) * Math.atan(sample * param);
      case 'cubic':
        return Math.abs(sample) >= 1.5 ? ffSign(sample) : sample - 0.1481 * Math.pow(sample, 3);
      case 'exp':
        return 2 / (1 + Math.exp(-2 * sample)) - 1;
      case 'alg':
        return sample / Math.sqrt(param + sample * sample);
      case 'quintic':
        return Math.abs(sample) >= 1.25 ? ffSign(sample) : sample - 0.08192 * Math.pow(sample, 5);
      case 'sin':
        return Math.abs(sample) >= Math.PI / 2 ? ffSign(sample) : Math.sin(sample);
      default:
        return erf(sample);
    }
  };

  const length = end - start;
  if (length <= 0) return out;

  // Cutoff at the original Nyquist, running at the oversampled rate.
  const antiAlias = normalizeDcGain(lowPass(pcm.sampleRate * oversample, pcm.sampleRate / 2, 0.8));
  const work = oversample > 1 ? new Float64Array(SOFTCLIP_BLOCK * oversample) : null;

  for (let c = 0; c < pcm.channels.length; c++) {
    const source = pcm.channels[c];
    const target = out.channels[c];

    if (!work) {
      for (let i = start; i < end; i++) target[i] = shape(source[i]) * gain;
      continue;
    }

    const up = tdf2State();
    const down = tdf2State();

    for (let base = start; base < end; base += SOFTCLIP_BLOCK) {
      const frames = Math.min(SOFTCLIP_BLOCK, end - base);
      const span = frames * oversample;

      for (let n = 0; n < frames; n++) {
        work[n * oversample] = source[base + n];
        for (let m = 1; m < oversample; m++) work[n * oversample + m] = 0;
      }

      for (let n = 0; n < span; n++) work[n] = runTdf2(antiAlias, work[n], up);
      for (let n = 0; n < span; n++) work[n] = shape(work[n]) * gain;
      for (let n = 0; n < span; n++) work[n] = runTdf2(antiAlias, work[n], down);

      for (let n = 0; n < frames; n++) target[base + n] = work[n * oversample] * scale;
    }
  }
  return out;
}

// -------------------------------------------------------------- af_asubboost

/**
 * `asubboost` — libavfilter/af_asubboost.c.
 *
 * A lowpassed copy of the signal is fed into a short delay line with decay and
 * feedback, which turns the band into a resonant tail rather than a flat
 * boost. The amount added back is levelled by a follower that backs off as the
 * dry signal gets loud, so it fills quiet passages without pushing loud ones
 * into the ceiling.
 */
export function asubboost(pcm: Pcm, range: Range, p: EffectValues): Pcm {
  const { out, start, end } = prepare(pcm, range);
  const band = lowPassSlope(pcm.sampleRate, p.cutoff, p.slope);
  const bufferSamples = Math.max(1, Math.trunc((pcm.sampleRate * p.delay) / 1000));

  const dry = p.dry;
  const wet = p.wet;
  const decay = p.decay;
  const feedback = p.feedback;
  const maxBoost = p.boost;
  // The follower's two rates: it opens slowly and closes quickly.
  const a = 0.00001;
  const b = 1 - a;

  for (let c = 0; c < pcm.channels.length; c++) {
    const source = pcm.channels[c];
    const target = out.channels[c];
    const buffer = new Float64Array(bufferSamples);
    const w = tdf2State();
    let follower = 0;
    let writePos = 0;

    for (let i = start; i < end; i++) {
      const input = source[i];
      const banded = runTdf2(band, input, w);

      buffer[writePos] = buffer[writePos] * decay + banded * feedback;
      const boost = clipD((1 - Math.abs(input * dry)) / Math.abs(buffer[writePos]), 0, maxBoost);
      follower = boost > follower ? follower * b + a * boost : follower * a + b * boost;
      follower = clipD(follower, 0, maxBoost);
      target[i] = (input * dry + follower * buffer[writePos]) * wet;

      if (++writePos >= bufferSamples) writePos = 0;
    }
  }
  return out;
}

// -------------------------------------------------------------- af_apulsator

const PULSATOR_MODES = ['sine', 'triangle', 'square', 'sawup', 'sawdown'] as const;

/**
 * `apulsator` — libavfilter/af_apulsator.c.
 *
 * One LFO per channel, offset from each other, multiplying the level. With the
 * default half-cycle offset between left and right it reads as auto-panning;
 * with both offsets equal it is a tremolo across the pair.
 *
 * Stereo only, as in ffmpeg, which forces a stereo layout on this filter.
 */
export function apulsator(pcm: Pcm, range: Range, p: EffectValues): Pcm {
  const { out, start, end } = prepare(pcm, range);
  const mode = PULSATOR_MODES[Math.round(p.mode)] ?? 'sine';
  const levelIn = p.levelIn;
  const levelOut = p.levelOut;
  const amount = p.amount;
  const pwidth = p.width;

  const frequency = p.hz;
  const step = frequency / pcm.sampleRate;

  const value = (phase: number, offset: number): number => {
    let phs = Math.min(100, phase / Math.min(1.99, Math.max(0.01, pwidth)) + offset);
    if (phs > 1) phs %= 1;
    switch (mode) {
      case 'triangle':
        if (phs > 0.75) return ((phs - 0.75) * 4 - 1) * amount;
        if (phs > 0.25) return (-4 * phs + 2) * amount;
        return phs * 4 * amount;
      case 'square':
        return (phs < 0.5 ? -1 : 1) * amount;
      case 'sawup':
        return (phs * 2 - 1) * amount;
      case 'sawdown':
        return (1 - phs * 2) * amount;
      default:
        return Math.sin(phs * 2 * Math.PI) * amount;
    }
  };

  const left = pcm.channels[0];
  const right = pcm.channels[1];
  let phase = 0;

  for (let i = start; i < end; i++) {
    const inL = left[i] * levelIn;
    const inR = right[i] * levelIn;

    const procL = inL * (value(phase, p.offsetL) * 0.5 + amount / 2);
    const procR = inR * (value(phase, p.offsetR) * 0.5 + amount / 2);

    out.channels[0][i] = (procL + inL * (1 - amount)) * levelOut;
    out.channels[1][i] = (procR + inR * (1 - amount)) * levelOut;

    phase = Math.abs(phase + step);
    if (phase >= 1) phase %= 1;
  }
  return out;
}

// ------------------------------------------------------------------ af_aecho

/**
 * `aecho` — libavfilter/af_aecho.c.
 *
 * ffmpeg takes free-form `delays` and `decays` lists. Sliders cannot express a
 * list, so `repeats` generates an evenly spaced train: delays of `delay`,
 * 2·`delay`, 3·`delay`… against decays of `decay`, `decay²`, `decay³`… That is
 * a subset of what the filter accepts, not a different algorithm — the same
 * settings written out as `aecho=in:out:d|2d|3d:k|k²|k³` produce this.
 *
 * The ±1 clamp on the way out is ffmpeg's sample format, not part of the
 * effect; see the deviations at the top of this file.
 */
export function aecho(pcm: Pcm, range: Range, p: EffectValues): Pcm {
  const { out, start, end } = prepare(pcm, range);
  const repeats = Math.max(1, Math.round(p.repeats));

  const taps: { samples: number; decay: number }[] = [];
  for (let n = 1; n <= repeats; n++) {
    taps.push({
      samples: Math.max(1, Math.trunc((p.delay * n * pcm.sampleRate) / 1000)),
      decay: Math.pow(p.decay, n),
    });
  }
  const maxSamples = taps.reduce((most, tap) => Math.max(most, tap.samples), 0);

  for (let c = 0; c < pcm.channels.length; c++) {
    const source = pcm.channels[c];
    const target = out.channels[c];
    const buffer = new Float64Array(maxSamples);
    let index = 0;

    for (let i = start; i < end; i++) {
      const input = source[i];
      let value = input * p.inGain;
      for (const tap of taps) {
        value += buffer[mod(index + maxSamples - tap.samples, maxSamples)] * tap.decay;
      }
      target[i] = value * p.outGain;
      buffer[index] = input;
      index = mod(index + 1, maxSamples);
    }
  }
  return out;
}

// ---------------------------------------------------------------- af_aphaser

/**
 * `aphaser` — libavfilter/af_aphaser.c.
 *
 * A feedback delay line whose read position is swept by a wave table, so the
 * comb it forms moves. All channels share one sweep, which is what keeps the
 * effect centred rather than smearing the image.
 */
export function aphaser(pcm: Pcm, range: Range, p: EffectValues): Pcm {
  const { out, start, end } = prepare(pcm, range);
  const channels = pcm.channels.length;

  const delayLength = Math.max(1, Math.trunc((p.delay * 0.001 * pcm.sampleRate) + 0.5));
  const modulationLength = Math.max(1, Math.trunc(pcm.sampleRate / p.speed + 0.5));
  const modulation = generateWaveTable(
    p.type >= 0.5 ? 'sin' : 'tri',
    modulationLength,
    1,
    delayLength,
    Math.PI / 2,
    true,
  );

  const buffer = new Float64Array(delayLength * channels);
  let delayPos = 0;
  let modulationPos = 0;

  for (let i = start; i < end; i++) {
    const readBase = mod(delayPos + modulation[modulationPos], delayLength) * channels;
    delayPos = mod(delayPos + 1, delayLength);
    const writeBase = delayPos * channels;

    for (let c = 0; c < channels; c++) {
      const v = pcm.channels[c][i] * p.inGain + buffer[readBase + c] * p.decay;
      buffer[writeBase + c] = v;
      out.channels[c][i] = v * p.outGain;
    }

    modulationPos = mod(modulationPos + 1, modulationLength);
  }
  return out;
}

// ----------------------------------------------------------------- af_chorus

const CHORUS_VOICE_KEYS = [
  { delay: 'delay1', decay: 'decay1', speed: 'speed1', depth: 'depth1' },
  { delay: 'delay2', decay: 'decay2', speed: 'speed2', depth: 'depth2' },
  { delay: 'delay3', decay: 'decay3', speed: 'speed3', depth: 'depth3' },
] as const;

/**
 * `chorus` — libavfilter/af_chorus.c.
 *
 * Up to three delayed copies, each swept by its own sine at its own rate, added
 * back to the dry signal. Detuning each voice slightly differently is what
 * makes one source sound like several.
 *
 * ffmpeg takes parallel lists; here the number of voices is a count and each
 * voice gets its own four controls, which is the same thing a list expresses.
 */
export function chorus(pcm: Pcm, range: Range, p: EffectValues): Pcm {
  const { out, start, end } = prepare(pcm, range);
  const rate = pcm.sampleRate;
  const voiceCount = Math.min(CHORUS_VOICE_KEYS.length, Math.max(1, Math.round(p.voices)));

  const voices = CHORUS_VOICE_KEYS.slice(0, voiceCount).map((keys) => {
    const delay = p[keys.delay];
    const depth = p[keys.depth];
    const speed = p[keys.speed];
    const depthSamples = Math.trunc((depth * rate) / 1000);
    const length = Math.max(1, Math.trunc(rate / speed));
    return {
      decay: p[keys.decay],
      length,
      table: generateWaveTable('sin', length, 0, depthSamples, 0, true),
      span: Math.trunc(((delay + depth) * rate) / 1000),
    };
  });

  const maxSamples = Math.max(1, ...voices.map((voice) => voice.span));

  for (let c = 0; c < pcm.channels.length; c++) {
    const source = pcm.channels[c];
    const target = out.channels[c];
    const buffer = new Float64Array(maxSamples);
    const phase = new Int32Array(voices.length);
    let counter = 0;

    for (let i = start; i < end; i++) {
      const input = source[i];
      let value = input * p.inGain;

      for (let n = 0; n < voices.length; n++) {
        const voice = voices[n];
        value += buffer[mod(maxSamples + counter - voice.table[phase[n]], maxSamples)] * voice.decay;
        phase[n] = mod(phase[n] + 1, voice.length);
      }

      target[i] = value * p.outGain;
      buffer[counter] = input;
      counter = mod(counter + 1, maxSamples);
    }
  }
  return out;
}

// ---------------------------------------------------------------- af_flanger

/**
 * `flanger` — libavfilter/af_flanger.c.
 *
 * A swept delay of a few milliseconds mixed back with the dry signal, with
 * optional regeneration. The delay is fractional, so the read is interpolated —
 * linearly, or with the quadratic form, which holds up better at the extremes
 * of a deep sweep.
 *
 * The `phase` option offsets the sweep per channel; on a stereo track that is
 * what turns a flat flange into one that moves across the image.
 */
export function flanger(pcm: Pcm, range: Range, p: EffectValues): Pcm {
  const { out, start, end } = prepare(pcm, range);
  const rate = pcm.sampleRate;
  const channels = pcm.channels.length;

  // ffmpeg's init() rescales the percentage and millisecond options once,
  // before anything else touches them.
  const feedbackGain = p.regen / 100;
  const channelPhase = p.phase / 100;
  const delayMin = p.delay / 1000;
  const delayDepth = p.depth / 1000;
  const width = p.width / 100;
  const inGain = 1 / (1 + width);
  const delayGain = (width / (1 + width)) * (1 - Math.abs(feedbackGain));

  const maxSamples = Math.max(2, Math.trunc((delayMin + delayDepth) * rate + 2.5));
  const lfoLength = Math.max(1, Math.trunc(rate / p.speed));
  const lfo = generateWaveTable(
    p.shape >= 0.5 ? 'tri' : 'sin',
    lfoLength,
    Math.round(delayMin * rate),
    maxSamples - 2,
    3 * (Math.PI / 2),
    false,
  );

  const buffers = Array.from({ length: channels }, () => new Float64Array(maxSamples));
  const delayLast = new Float64Array(channels);
  const quadratic = p.interp >= 0.5;
  let bufferPos = 0;
  let lfoPos = 0;

  for (let i = start; i < end; i++) {
    bufferPos = (bufferPos + maxSamples - 1) % maxSamples;

    for (let c = 0; c < channels; c++) {
      const phaseOffset = Math.trunc(c * lfoLength * channelPhase + 0.5);
      const swept = lfo[(lfoPos + phaseOffset) % lfoLength];
      let intDelay = Math.trunc(swept);
      const fracDelay = swept - intDelay;
      const buffer = buffers[c];

      const input = pcm.channels[c][i];
      buffer[bufferPos] = input + delayLast[c] * feedbackGain;

      const delayed0 = buffer[(bufferPos + intDelay++) % maxSamples];
      let delayed1 = buffer[(bufferPos + intDelay++) % maxSamples];
      let delayed: number;

      if (!quadratic) {
        delayed = delayed0 + (delayed1 - delayed0) * fracDelay;
      } else {
        let delayed2 = buffer[(bufferPos + intDelay++) % maxSamples];
        delayed2 -= delayed0;
        delayed1 -= delayed0;
        const a = delayed2 * 0.5 - delayed1;
        const b = delayed1 * 2 - delayed2 * 0.5;
        delayed = delayed0 + (a * fracDelay + b) * fracDelay;
      }

      delayLast[c] = delayed;
      out.channels[c][i] = input * inGain + delayed * delayGain;
    }

    lfoPos = (lfoPos + 1) % lfoLength;
  }
  return out;
}

// ---------------------------------------------------------------- af_tremolo

/**
 * `tremolo` — libavfilter/af_tremolo.c.
 *
 * One period of the modulation is precomputed and indexed, which is why the
 * rate is quantised to a whole number of samples per cycle.
 */
export function tremolo(pcm: Pcm, range: Range, p: EffectValues): Pcm {
  const { out, start, end } = prepare(pcm, range);
  const offset = 1 - p.depth / 2;
  const size = Math.max(1, lrint(pcm.sampleRate / p.frequency + 0.5));
  const table = new Float64Array(size);

  for (let i = 0; i < size; i++) {
    const env = Math.sin(2 * Math.PI * (((p.frequency * i) / pcm.sampleRate + 0.25) % 1));
    table[i] = env * (1 - Math.abs(offset)) + offset;
  }

  let index = 0;
  for (let i = start; i < end; i++) {
    for (let c = 0; c < pcm.channels.length; c++) {
      out.channels[c][i] = pcm.channels[c][i] * table[index];
    }
    if (++index >= size) index = 0;
  }
  return out;
}

// -------------------------------------------------------------- af_crossfeed

/**
 * `crossfeed` — libavfilter/af_crossfeed.c.
 *
 * A low shelf applied to the side signal only. Cutting the low end of the side
 * makes bass progressively more mono, which is what removes the hard
 * left/right separation that makes headphones tiring.
 *
 * ffmpeg's default `block_size` of 0 selects the plain IIR path, which is what
 * this is; the block path only exists there to make the filter phase-linear.
 */
export function crossfeed(pcm: Pcm, range: Range, p: EffectValues): Pcm {
  const { out, start, end } = prepare(pcm, range);
  // A = 10^(strength · −30/40), i.e. up to 30 dB of shelf cut at full strength.
  const filter = lowShelf(
    pcm.sampleRate,
    (1 - p.range) * 2100,
    p.strength * -30,
    p.slope,
    'slope',
    'shelf',
  );

  const left = pcm.channels[0];
  const right = pcm.channels[1];
  const w = tdf2State();

  for (let i = start; i < end; i++) {
    const mid = (left[i] + right[i]) * p.levelIn * 0.5;
    const side = runTdf2(filter, (left[i] - right[i]) * p.levelIn * 0.5, w);
    out.channels[0][i] = (mid + side) * p.levelOut;
    out.channels[1][i] = (mid - side) * p.levelOut;
  }
  return out;
}

// -------------------------------------------------------------------- af_haas

const HAAS_SOURCES = ['left', 'right', 'mid', 'side'] as const;

/**
 * `haas` — libavfilter/af_haas.c.
 *
 * One mono source is delayed by two slightly different amounts, a couple of
 * milliseconds apart, and the two copies are panned against each other. Below
 * about 40 ms the ear fuses the pair into one event but takes its direction
 * from the earlier arrival, so the image widens without an audible echo.
 */
export function haas(pcm: Pcm, range: Range, p: EffectValues): Pcm {
  const { out, start, end } = prepare(pcm, range);
  const rate = pcm.sampleRate;

  // Power-of-two ring buffer, so the wrap is a mask as it is in the C.
  let size = 1;
  while (size < rate * 40 * 0.001) size <<= 1;
  const mask = size - 1;
  const buffer = new Float64Array(size);

  const delay0 = Math.trunc(p.leftDelay * 0.001 * rate);
  const delay1 = Math.trunc(p.rightDelay * 0.001 * rate);
  const phase0 = p.leftPhase >= 0.5 ? 1 : -1;
  const phase1 = p.rightPhase >= 0.5 ? 1 : -1;

  const balanceL0 = ((p.leftBalance + 1) / 2) * p.leftGain * phase0;
  const balanceR0 = (1 - (p.leftBalance + 1) / 2) * p.leftGain * phase0;
  const balanceL1 = ((p.rightBalance + 1) / 2) * p.rightGain * phase1;
  const balanceR1 = (1 - (p.rightBalance + 1) / 2) * p.rightGain * phase1;

  const source = HAAS_SOURCES[Math.round(p.middleSource)] ?? 'mid';
  const left = pcm.channels[0];
  const right = pcm.channels[1];
  let writePtr = 0;

  for (let i = start; i < end; i++) {
    let mid: number;
    switch (source) {
      case 'left':
        mid = left[i];
        break;
      case 'right':
        mid = right[i];
        break;
      case 'side':
        mid = (left[i] - right[i]) * 0.5;
        break;
      default:
        mid = (left[i] + right[i]) * 0.5;
        break;
    }

    mid *= p.levelIn;
    buffer[writePtr] = mid;

    const tap0 = buffer[(writePtr + size - delay0) & mask] * p.sideGain;
    const tap1 = buffer[(writePtr + size - delay1) & mask] * p.sideGain;
    if (p.middlePhase >= 0.5) mid = -mid;

    out.channels[0][i] = (mid + (tap0 * balanceL0 - tap1 * balanceL1)) * p.levelOut;
    out.channels[1][i] = (mid + (tap1 * balanceR1 - tap0 * balanceR0)) * p.levelOut;

    writePtr = (writePtr + 1) & mask;
  }
  return out;
}

// ------------------------------------------------------------ af_stereowiden

/**
 * `stereowiden` — libavfilter/af_stereowiden.c.
 *
 * Each channel has the opposite channel subtracted from it, plus a delayed
 * copy of the opposite channel. Subtracting the correlated part is what pushes
 * the image outwards; the delay is what keeps it from collapsing to a thin
 * phase trick.
 */
export function stereowiden(pcm: Pcm, range: Range, p: EffectValues): Pcm {
  const { out, start, end } = prepare(pcm, range);
  // `lrintf` in the C, so ties go to even here too. ffmpeg 6.1 and earlier
  // assign this to an int without rounding, truncating instead; upstream
  // changed it to round. This follows the current behaviour, which differs
  // from 6.1 by at most one sample of delay.
  const length = Math.max(1, lrint((p.delay * pcm.sampleRate) / 1000));
  const buffer = new Float64Array(length * 2);

  const left = pcm.channels[0];
  const right = pcm.channels[1];
  let cursor = 0;

  for (let i = start; i < end; i++) {
    const l = left[i];
    const r = right[i];
    if (cursor === buffer.length) cursor = 0;

    out.channels[0][i] = p.drymix * l - p.crossfeed * r - p.feedback * buffer[cursor + 1];
    out.channels[1][i] = p.drymix * r - p.crossfeed * l - p.feedback * buffer[cursor];

    buffer[cursor] = l;
    buffer[cursor + 1] = r;
    cursor += 2;
  }
  return out;
}

// ------------------------------------------------------------------ telephone

/**
 * Not an ffmpeg filter — the chain `highpass=f=300, lowpass=f=3000, volume=1.3`
 * written out as one effect. Both biquads take ffmpeg's own defaults for
 * everything the chain leaves unset: Q = 0.707, two poles, direct form I.
 *
 * 300–3000 Hz is the band a POTS line actually passed, which is why the result
 * sounds like a phone rather than merely like a filtered track.
 */
export function telephone(pcm: Pcm, range: Range, p: EffectValues): Pcm {
  const { out, start, end } = prepare(pcm, range);
  const high = highPass(pcm.sampleRate, p.highpass, RBJ_Q);
  const low = lowPass(pcm.sampleRate, p.lowpass, RBJ_Q);

  for (let c = 0; c < pcm.channels.length; c++) {
    const source = pcm.channels[c];
    const target = out.channels[c];
    const highState = df1State();
    const lowState = df1State();
    for (let i = start; i < end; i++) {
      target[i] = runDf1(low, runDf1(high, source[i], highState), lowState) * p.volume;
    }
  }
  return out;
}
