/**
 * Every effect, measured against the ffmpeg filter it was ported from.
 *
 * Reading a filter's source and rewriting it is not proof that the rewrite is
 * the same filter. This runs the real thing — the same input samples through
 * `ffmpeg -af <filter>` with the same options — and compares the output sample
 * for sample. A port that is subtly wrong (a sign, an off-by-one in a delay
 * line, a coefficient convention) shows up here as an error orders of magnitude
 * above float noise, which reading cannot catch.
 *
 * The suite skips itself when ffmpeg is not on PATH, so CI, which has no
 * ffmpeg, stays green while a developer with one gets the real comparison.
 * `test/effects.test.ts` covers behaviour that does not need it.
 *
 * Two known, deliberate divergences are worked around rather than papered over:
 * the ±1 output clamp this project drops (so the fixture stays well inside full
 * scale, where no filter would clamp anyway), and the tails that aecho and
 * chorus flush past end-of-input (so only the overlapping samples are read).
 */
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { EFFECTS, type EffectSpec } from '../src/audio/effect-registry';
import { createPcm, frameCount, type Pcm } from '../src/audio/pcm';

const RATE = 44100;
const FRAMES = RATE / 2;

function hasFfmpeg(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * The fixture: two uncorrelated tones per channel plus a click.
 *
 * The tones give the frequency-shaping filters something with content either
 * side of every corner they place; the difference between the channels is what
 * the stereo filters act on, so an identical pair would hide a mistake in them;
 * and the click excites every delay line and IIR at a known instant. Peak is
 * 0.5, which keeps the whole thing clear of the ±1 clamp.
 */
function fixture(): Pcm {
  const pcm = createPcm(2, FRAMES, RATE);
  for (let i = 0; i < FRAMES; i++) {
    const t = i / RATE;
    pcm.channels[0][i] =
      0.28 * Math.sin(2 * Math.PI * 220 * t) + 0.16 * Math.sin(2 * Math.PI * 3300 * t);
    pcm.channels[1][i] =
      0.24 * Math.sin(2 * Math.PI * 330 * t) + 0.13 * Math.sin(2 * Math.PI * 5100 * t);
  }
  pcm.channels[0][1000] = 0.5;
  pcm.channels[1][1200] = -0.5;
  return pcm;
}

function toInterleaved(pcm: Pcm): Buffer {
  const frames = frameCount(pcm);
  const out = Buffer.allocUnsafe(frames * pcm.channels.length * 4);
  let offset = 0;
  for (let i = 0; i < frames; i++) {
    for (const channel of pcm.channels) {
      out.writeFloatLE(channel[i], offset);
      offset += 4;
    }
  }
  return out;
}

function fromInterleaved(buffer: Buffer, channels: number): Float32Array[] {
  const frames = Math.floor(buffer.length / (4 * channels));
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  let offset = 0;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      out[c][i] = buffer.readFloatLE(offset);
      offset += 4;
    }
  }
  return out;
}

function runFfmpeg(input: Buffer, chain: string): Float32Array[] {
  const stdout = execFileSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 'f32le',
      '-ar', String(RATE),
      '-ac', '2',
      '-i', 'pipe:0',
      '-af', chain,
      '-f', 'f32le',
      '-ar', String(RATE),
      '-ac', '2',
      'pipe:1',
    ],
    { input, maxBuffer: 256 * 1024 * 1024 },
  );
  return fromInterleaved(stdout, 2);
}

interface Divergence {
  maxAbsolute: number;
  relativeRms: number;
  frames: number;
}

function compare(mine: Float32Array[], theirs: Float32Array[]): Divergence {
  const frames = Math.min(mine[0].length, theirs[0].length);
  let worst = 0;
  let errorEnergy = 0;
  let signalEnergy = 0;

  for (let c = 0; c < mine.length; c++) {
    for (let i = 0; i < frames; i++) {
      const difference = mine[c][i] - theirs[c][i];
      worst = Math.max(worst, Math.abs(difference));
      errorEnergy += difference * difference;
      signalEnergy += theirs[c][i] * theirs[c][i];
    }
  }
  return {
    maxAbsolute: worst,
    relativeRms: signalEnergy > 0 ? Math.sqrt(errorEnergy / signalEnergy) : Math.sqrt(errorEnergy),
    frames,
  };
}

/**
 * The ffmpeg filter chain each effect's defaults correspond to.
 *
 * Written out longhand rather than generated, so a wrong default in the
 * registry cannot quietly agree with a wrong argument here.
 */
const CHAINS: Record<string, string> = {
  bass: 'bass=f=100:width_type=q:w=0.5:g=6:precision=f64',
  crystalizer: 'crystalizer=i=2:c=1',
  aexciter: 'aexciter=level_in=1:level_out=1:amount=1:drive=8.5:blend=0:freq=7500:ceil=9999',
  asubboost:
    'asubboost=dry=1:wet=1:boost=2:decay=0:feedback=0.9:cutoff=100:slope=0.5:delay=20',
  telephone: 'highpass=f=300:precision=f64,lowpass=f=3000:precision=f64,volume=1.3',
  acrusher:
    'acrusher=level_in=1:level_out=1:bits=8:mix=0.5:mode=lin:dc=1:aa=0.5:samples=1:lfo=0:lforange=20:lforate=0.3',
  asoftclip: 'asoftclip=type=tanh:threshold=1:output=1:param=1:oversample=1',
  aecho: 'aecho=0.6:0.3:500:0.5',
  aphaser: 'aphaser=in_gain=0.4:out_gain=0.74:delay=3:decay=0.4:speed=0.5:type=t',
  chorus: 'chorus=0.7:0.9:55|60:0.4|0.32:0.25|0.4:2|1.3',
  flanger:
    'flanger=delay=0:depth=2:regen=0:width=71:speed=0.5:shape=sinusoidal:phase=25:interp=linear',
  tremolo: 'tremolo=f=5:d=0.5',
  apulsator:
    'apulsator=level_in=1:level_out=1:mode=sine:amount=1:offset_l=0:offset_r=0.5:width=1:timing=hz:hz=2',
  haas:
    'haas=level_in=1:level_out=1:side_gain=1:middle_source=mid:middle_phase=0:left_delay=2.05:left_balance=-1:left_gain=1:left_phase=0:right_delay=2.12:right_balance=1:right_gain=1:right_phase=1',
  stereowiden: 'stereowiden=delay=20:feedback=0.3:crossfeed=0.3:drymix=0.8',
  crossfeed: 'crossfeed=strength=0.2:range=0.5:slope=0.5:level_in=0.9:level_out=1:block_size=0',
  declick: 'adeclick=w=55:o=75:a=2:t=2:b=2:m=add',
  agate:
    'agate=level_in=1:mode=downward:threshold=0.125:range=0.06125:ratio=2:attack=20:release=250:makeup=1:knee=2.828427125:detection=rms:link=average',
  // Defaults are 0 dB — a true no-op both sides, so this only proves the two
  // sides agree on doing nothing; the meaningful check is in VARIANTS below.
  equalizer: 'equalizer=f=1000:width_type=q:w=1:g=0',
};

/**
 * Settings the defaults do not reach.
 *
 * Defaults exercise one path through each filter. Modes, curves and the
 * branches that only switch on off-default — aexciter's ceiling filter above
 * 10 kHz, acrusher's logarithmic scale and its LFO, asoftclip's oversampling —
 * are where a port is most likely to be wrong and least likely to be noticed.
 */
const VARIANTS: { id: string; label: string; values: Record<string, number>; chain: string }[] = [
  {
    id: 'bass',
    label: 'cut, high Q, higher corner',
    values: { frequency: 240, width: 1.4, gain: -9 },
    chain: 'bass=f=240:width_type=q:w=1.4:g=-9:precision=f64',
  },
  {
    id: 'crystalizer',
    label: 'negative intensity, no clip',
    values: { intensity: -3.5, clip: 0 },
    chain: 'crystalizer=i=-3.5:c=0',
  },
  {
    id: 'aexciter',
    label: 'ceiling filter engaged above 10 kHz',
    values: { levelIn: 1.5, levelOut: 0.8, amount: 3, drive: 2, blend: 5, freq: 3000, ceil: 12000 },
    chain: 'aexciter=level_in=1.5:level_out=0.8:amount=3:drive=2:blend=5:freq=3000:ceil=12000',
  },
  {
    id: 'asubboost',
    label: 'decaying tail, deeper boost',
    values: {
      dry: 0.8,
      wet: 0.9,
      boost: 6,
      decay: 0.5,
      feedback: 0.7,
      cutoff: 60,
      slope: 0.2,
      delay: 45,
    },
    chain: 'asubboost=dry=0.8:wet=0.9:boost=6:decay=0.5:feedback=0.7:cutoff=60:slope=0.2:delay=45',
  },
  {
    id: 'acrusher',
    label: 'logarithmic scale',
    values: { mode: 1, bits: 4, dc: 2, aa: 0.8 },
    chain:
      'acrusher=level_in=1:level_out=1:bits=4:mix=0.5:mode=log:dc=2:aa=0.8:samples=1:lfo=0:lforange=20:lforate=0.3',
  },
  {
    id: 'acrusher',
    label: 'sample hold swept by the LFO',
    values: { samples: 12, lfo: 1, lfoRange: 40, lfoRate: 3, mix: 1 },
    chain:
      'acrusher=level_in=1:level_out=1:bits=8:mix=1:mode=lin:dc=1:aa=0.5:samples=12:lfo=1:lforange=40:lforate=3',
  },
  ...(['Hard', 'Atan', 'Cubic', 'Exp', 'Alg', 'Quintic', 'Sin', 'Erf'] as const).map(
    (curve, offset) => ({
      id: 'asoftclip',
      label: `${curve.toLowerCase()} curve`,
      // Index 0 is Hard; the rest follow in registry order, so Atan is 2.
      values: { type: offset === 0 ? 0 : offset + 1, threshold: 0.4, output: 1.2, param: 1.7 },
      chain: `asoftclip=type=${curve.toLowerCase()}:threshold=0.4:output=1.2:param=1.7:oversample=1`,
    }),
  ),
  {
    id: 'asoftclip',
    label: 'four times oversampled',
    values: { type: 1, threshold: 0.3, output: 1, param: 1, oversample: 4 },
    chain: 'asoftclip=type=tanh:threshold=0.3:output=1:param=1:oversample=4',
  },
  {
    id: 'aecho',
    label: 'three repeats',
    values: { inGain: 0.7, outGain: 0.4, delay: 120, decay: 0.5, repeats: 3 },
    chain: 'aecho=0.7:0.4:120|240|360:0.5|0.25|0.125',
  },
  {
    id: 'aphaser',
    label: 'sinusoidal sweep',
    values: { inGain: 0.6, outGain: 0.9, delay: 4.5, decay: 0.7, speed: 1.5, type: 1 },
    chain: 'aphaser=in_gain=0.6:out_gain=0.9:delay=4.5:decay=0.7:speed=1.5:type=s',
  },
  {
    id: 'chorus',
    label: 'one voice',
    values: { voices: 1, inGain: 0.6, outGain: 0.8, delay1: 40, decay1: 0.5, speed1: 0.9, depth1: 3 },
    chain: 'chorus=0.6:0.8:40:0.5:0.9:3',
  },
  {
    id: 'chorus',
    label: 'three voices',
    values: { voices: 3 },
    chain: 'chorus=0.7:0.9:55|60|75:0.4|0.32|0.3:0.25|0.4|0.6:2|1.3|2.5',
  },
  {
    id: 'flanger',
    label: 'triangular sweep, quadratic interpolation, regeneration',
    values: { delay: 3, depth: 6, regen: 40, width: 90, speed: 2, shape: 1, phase: 60, interp: 1 },
    chain:
      'flanger=delay=3:depth=6:regen=40:width=90:speed=2:shape=triangular:phase=60:interp=quadratic',
  },
  {
    id: 'flanger',
    label: 'negative regeneration',
    values: { delay: 1, depth: 4, regen: -55, width: 80, speed: 3, shape: 0, phase: 0, interp: 0 },
    chain: 'flanger=delay=1:depth=4:regen=-55:width=80:speed=3:shape=sinusoidal:phase=0:interp=linear',
  },
  {
    id: 'tremolo',
    label: 'full depth at a rate with no rounding tie',
    values: { frequency: 7.3, depth: 1 },
    chain: 'tremolo=f=7.3:d=1',
  },
  ...(['triangle', 'square', 'sawup', 'sawdown'] as const).map((mode, index) => ({
    id: 'apulsator',
    label: `${mode} shape`,
    values: { mode: index + 1, amount: 0.8, offsetL: 0.2, offsetR: 0.7, width: 1.4, hz: 6 },
    chain: `apulsator=level_in=1:level_out=1:mode=${mode}:amount=0.8:offset_l=0.2:offset_r=0.7:width=1.4:timing=hz:hz=6`,
  })),
  {
    id: 'haas',
    label: 'side as the middle source, phases flipped',
    values: {
      middleSource: 3,
      middlePhase: 1,
      leftDelay: 8.4,
      rightDelay: 1.1,
      leftPhase: 1,
      rightPhase: 0,
      leftBalance: 0.3,
      rightBalance: -0.6,
      sideGain: 1.8,
      leftGain: 0.7,
      rightGain: 1.4,
    },
    chain:
      'haas=level_in=1:level_out=1:side_gain=1.8:middle_source=side:middle_phase=1:left_delay=8.4:left_balance=0.3:left_gain=0.7:left_phase=1:right_delay=1.1:right_balance=-0.6:right_gain=1.4:right_phase=0',
  },
  {
    id: 'haas',
    label: 'left channel as the middle source',
    values: { middleSource: 0 },
    chain:
      'haas=level_in=1:level_out=1:side_gain=1:middle_source=left:middle_phase=0:left_delay=2.05:left_balance=-1:left_gain=1:left_phase=0:right_delay=2.12:right_balance=1:right_gain=1:right_phase=1',
  },
  {
    id: 'stereowiden',
    // 10 ms is a whole number of samples at 44.1 kHz on purpose. ffmpeg 6.1
    // truncates the delay length where upstream rounds it, so at a delay that
    // is not a whole number of samples the two differ by one sample and this
    // comparison would be measuring the version, not the port. `effects.test.ts`
    // pins the rounding directly.
    label: 'heavy widening at a whole number of samples',
    values: { delay: 10, feedback: 0.8, crossfeed: 0.7, drymix: 0.5 },
    chain: 'stereowiden=delay=10:feedback=0.8:crossfeed=0.7:drymix=0.5',
  },
  {
    id: 'crossfeed',
    label: 'strong, narrow, steep',
    values: { strength: 0.85, range: 0.15, slope: 0.9, levelIn: 0.7, levelOut: 0.95 },
    chain:
      'crossfeed=strength=0.85:range=0.15:slope=0.9:level_in=0.7:level_out=0.95:block_size=0',
  },
  {
    id: 'telephone',
    label: 'narrower band, louder',
    values: { highpass: 500, lowpass: 2400, volume: 2 },
    chain: 'highpass=f=500:precision=f64,lowpass=f=2400:precision=f64,volume=2',
  },
  {
    id: 'declick',
    label: 'overlap-save reconstruction',
    values: { method: 1 },
    chain: 'adeclick=w=55:o=75:a=2:t=2:b=2:m=save',
  },
  {
    id: 'declick',
    label: 'shorter window, higher order, more sensitive',
    values: { window: 30, overlap: 60, arOrder: 8, threshold: 1.2, burst: 1 },
    chain: 'adeclick=w=30:o=60:a=8:t=1.2:b=1:m=add',
  },
  {
    id: 'agate',
    label: 'upward, peak detection, maximum link',
    values: { mode: 1, detection: 0, link: 1, threshold: 0.3, ratio: 4, attack: 5, release: 80 },
    chain: 'agate=level_in=1:mode=upward:threshold=0.3:range=0.06125:ratio=4:attack=5:release=80:makeup=1:knee=2.828427125:detection=peak:link=maximum',
  },
  {
    id: 'agate',
    label: 'no knee, fast release, makeup gain',
    values: { knee: 1, release: 20, makeup: 2, threshold: 0.2 },
    chain: 'agate=level_in=1:mode=downward:threshold=0.2:range=0.06125:ratio=2:attack=20:release=20:makeup=2:knee=1:detection=rms:link=average',
  },
  {
    id: 'equalizer',
    label: 'boost a low band with a wide Q',
    values: { frequency: 200, width: 2, gain: 9 },
    chain: 'equalizer=f=200:width_type=q:w=2:g=9:precision=f64',
  },
  {
    id: 'equalizer',
    label: 'narrow cut in the high end',
    values: { frequency: 6000, width: 0.3, gain: -12 },
    chain: 'equalizer=f=6000:width_type=q:w=0.3:g=-12:precision=f64',
  },
];

describe.skipIf(!hasFfmpeg())('effects against ffmpeg', () => {
  const source = fixture();
  const input = toInterleaved(source);
  const range = { start: 0, end: FRAMES };

  /**
   * Both sides round to float32 on the way out, so exact equality is not the
   * bar — though most of these do in fact come back bit-identical, and the
   * worst case measured (flanger) is 1.1 × 10⁻⁶. The limit is an order of
   * magnitude above that and still four orders below anything audible, which
   * is enough to catch a difference in the algorithm rather than in rounding:
   * the two real defects this suite found — a table sized with `Math.round`
   * where ffmpeg uses `lrint`, and a missing branch for negative crystalizer
   * intensities — came in at 1.8 × 10⁻⁴ and 2.0 respectively.
   *
   * Where a chain names `precision=f64` it is because ffmpeg's biquads pick
   * their working precision from the input format and would otherwise run in
   * float32; matched precisions make those comparisons bit-exact.
   */
  const check = (name: string, mine: Float32Array[], theirs: Float32Array[], minFrames = FRAMES / 2): void => {
    const divergence = compare(mine, theirs);
    expect(divergence.frames, `${name}: too little overlap to compare`).toBeGreaterThan(minFrames);
    expect(divergence.maxAbsolute, `max |Δ| for ${name}`).toBeLessThan(1e-5);
    expect(divergence.relativeRms, `relative RMS error for ${name}`).toBeLessThan(1e-5);
    if (process.env.EFFECT_DIFF) {
      console.log(
        `${name.padEnd(52)} max|Δ|=${divergence.maxAbsolute.toExponential(2)} relRMS=${divergence.relativeRms.toExponential(2)}`,
      );
    }
  };

  it('has a chain for every registered effect', () => {
    expect(EFFECTS.map((effect) => effect.id).sort()).toEqual(Object.keys(CHAINS).sort());
  });

  for (const effect of EFFECTS satisfies readonly EffectSpec[]) {
    it(`matches ffmpeg for ${effect.id}`, () => {
      check(effect.id, effect.apply(source, range, effect.defaults).channels, runFfmpeg(input, CHAINS[effect.id]));
    });
  }

  for (const variant of VARIANTS) {
    it(`matches ffmpeg for ${variant.id}: ${variant.label}`, () => {
      const effect = EFFECTS.find((entry) => entry.id === variant.id);
      expect(effect, `no effect registered as ${variant.id}`).toBeDefined();
      const values = { ...effect!.defaults, ...variant.values };
      check(
        `${variant.id} (${variant.label})`,
        effect!.apply(source, range, values).channels,
        runFfmpeg(input, variant.chain),
      );
    });
  }

  /**
   * Burst fusion bridges a small gap between two nearby detections rather
   * than repairing them as two separate clicks. Neither VARIANTS nor the
   * shared fixture's own two clicks (one per channel, 200 samples apart) puts
   * two detections close enough together in one channel to exercise that
   * bridging, so this builds a fixture that does: two opposite-polarity
   * spikes 5 samples apart in channel 0, a clean control tone in channel 1.
   */
  it('matches ffmpeg when burst fusion bridges two close clicks', () => {
    const frames = 6000;
    const burstFixture = createPcm(2, frames, RATE);
    for (let i = 0; i < frames; i++) {
      const t = i / RATE;
      burstFixture.channels[0][i] = 0.3 * Math.sin(2 * Math.PI * 250 * t);
      burstFixture.channels[1][i] = 0.3 * Math.sin(2 * Math.PI * 410 * t);
    }
    burstFixture.channels[0][2000] = 0.9;
    burstFixture.channels[0][2005] = -0.9;

    const declickSpec = EFFECTS.find((entry) => entry.id === 'declick')!;
    const values = { ...declickSpec.defaults, burst: 5 };
    const mine = declickSpec.apply(burstFixture, { start: 0, end: frames }, values).channels;
    const theirs = runFfmpeg(toInterleaved(burstFixture), 'adeclick=w=55:o=75:a=2:t=2:b=5:m=add');
    check('declick (burst fusion across two close clicks)', mine, theirs, frames / 2);
  });

  /**
   * `declick` reads real audio outside its range for context (see its own doc
   * comment), which the whole-track comparisons above cannot exercise — there,
   * the range already covers the entire buffer, so the "outside" is only ever
   * the true, silent edge of the file. This proves the context-reading design
   * itself: extract a window/context/window-sized excerpt of the shared
   * fixture around a mid-file selection, run ffmpeg over that excerpt exactly
   * as `declick` runs over the equivalent slice of the full buffer, and
   * compare only the selection's own output. If the design is right, treating
   * "selection plus real neighbouring audio" as its own small file and
   * treating it as a slice of the full one must agree, because both are the
   * same computation.
   */
  it('matches ffmpeg on a mid-file selection using real surrounding context', () => {
    const declickSpec = EFFECTS.find((entry) => entry.id === 'declick')!;
    const values = declickSpec.defaults;
    const windowSize = Math.max(100, Math.trunc((RATE * values.window) / 1000));

    const selection = { start: 5000, end: 15000 };
    const excerptStart = selection.start - windowSize;
    const excerptEnd = selection.end + windowSize;
    expect(excerptStart).toBeGreaterThanOrEqual(0);
    expect(excerptEnd).toBeLessThanOrEqual(FRAMES);

    const excerpt: Pcm = {
      sampleRate: source.sampleRate,
      channels: source.channels.map((channel) => channel.slice(excerptStart, excerptEnd)),
    };
    const excerptRange = { start: selection.start - excerptStart, end: selection.end - excerptStart };

    const mine = declickSpec.apply(excerpt, excerptRange, values).channels.map((c) =>
      c.subarray(excerptRange.start, excerptRange.end),
    );
    const theirsFull = runFfmpeg(toInterleaved(excerpt), CHAINS.declick);
    const theirs = theirsFull.map((c) => c.subarray(excerptRange.start, excerptRange.end));

    check(
      'declick (mid-file selection, real context)',
      mine,
      theirs,
      (excerptRange.end - excerptRange.start) / 2,
    );
  });
});
