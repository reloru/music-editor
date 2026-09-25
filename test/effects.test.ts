/**
 * Effects behaviour that does not need ffmpeg, so CI covers it.
 *
 * `effects-ffmpeg.test.ts` is where the DSP is proved correct, against the real
 * filters; it skips itself without ffmpeg on PATH. This file covers the things
 * that comparison cannot: that the registry and the implementations agree, that
 * an effect confines itself to the selection and leaves its input alone, and
 * the two places where the port deliberately pins a behaviour that a reading of
 * one ffmpeg version alone would get wrong.
 */
import { describe, expect, it } from 'vitest';
import { EFFECTS, findEffect, formatParam, type ParamSpec } from '../src/audio/effect-registry';
import * as fx from '../src/audio/effects';
import { channelCount, createPcm, frameCount, type Pcm } from '../src/audio/pcm';

const RATE = 44100;

function fixture(frames = 8000, channels = 2): Pcm {
  const pcm = createPcm(channels, frames, RATE);
  for (let c = 0; c < channels; c++) {
    for (let i = 0; i < frames; i++) {
      const t = i / RATE;
      pcm.channels[c][i] = 0.35 * Math.sin(2 * Math.PI * (200 + 140 * c) * t);
    }
  }
  return pcm;
}

describe('effect registry', () => {
  it('gives every effect a unique id', () => {
    const ids = EFFECTS.map((effect) => effect.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('declares a control for every default, and a default for every control', () => {
    for (const effect of EFFECTS) {
      const declared = effect.params.map((param) => param.key).sort();
      const defaulted = Object.keys(effect.defaults).sort();
      expect(declared, `${effect.id} controls`).toEqual(defaulted);
    }
  });

  it('starts every effect inside its own control ranges', () => {
    for (const effect of EFFECTS) {
      for (const param of effect.params) {
        const value = effect.defaults[param.key];
        expect(Number.isFinite(value), `${effect.id}.${param.key} default`).toBe(true);
        if (param.kind === 'slider') {
          expect(value, `${effect.id}.${param.key} below min`).toBeGreaterThanOrEqual(param.min);
          expect(value, `${effect.id}.${param.key} above max`).toBeLessThanOrEqual(param.max);
        } else if (param.kind === 'choice') {
          expect(param.options[value], `${effect.id}.${param.key} selects nothing`).toBeDefined();
        } else {
          expect([0, 1]).toContain(value);
        }
      }
    }
  });

  it('finds effects by id', () => {
    expect(findEffect('tremolo')?.label).toBe('Tremolo');
    expect(findEffect('nope')).toBeUndefined();
  });

  it('formats a parameter for its readout', () => {
    const gain: ParamSpec = {
      kind: 'slider',
      key: 'gain',
      label: 'Gain',
      min: -24,
      max: 24,
      step: 0.5,
      unit: 'dB',
      decimals: 1,
    };
    expect(formatParam(gain, -6)).toBe('-6.0 dB');
    expect(formatParam({ kind: 'toggle', key: 'clip', label: 'Clip' }, 1)).toBe('On');
    expect(formatParam({ kind: 'toggle', key: 'clip', label: 'Clip' }, 0)).toBe('Off');
    expect(
      formatParam({ kind: 'choice', key: 'mode', label: 'Mode', options: ['Linear', 'Log'] }, 1),
    ).toBe('Log');
  });
});

describe('every effect', () => {
  const stereo = fixture();
  const whole = { start: 0, end: frameCount(stereo) };

  for (const effect of EFFECTS) {
    // `await` throughout this describe block, not just where declick is
    // reached: `effect.apply` returns `Pcm | Promise<Pcm>` because declick's
    // own reconstruction yields periodically (see the comment on `declick` in
    // effects.ts) rather than blocking the thread for as long as a long
    // track takes, and `await` on a plain, already-synchronous `Pcm` result
    // resolves immediately, so every other effect here is unaffected.
    it(`${effect.id} keeps the buffer's shape and produces finite samples`, async () => {
      const out = await effect.apply(stereo, whole, effect.defaults);
      expect(channelCount(out)).toBe(channelCount(stereo));
      expect(frameCount(out)).toBe(frameCount(stereo));
      expect(out.sampleRate).toBe(stereo.sampleRate);
      for (const channel of out.channels) {
        for (let i = 0; i < channel.length; i++) {
          expect(Number.isFinite(channel[i]), `${effect.id} sample ${i}`).toBe(true);
        }
      }
    });

    it(`${effect.id} does not mutate its input`, async () => {
      const source = fixture();
      const before = source.channels.map((channel) => Float32Array.from(channel));
      await effect.apply(source, whole, effect.defaults);
      for (let c = 0; c < before.length; c++) {
        expect(Array.from(source.channels[c])).toEqual(Array.from(before[c]));
      }
    });

    it(`${effect.id} touches nothing outside the range`, async () => {
      const source = fixture();
      const range = { start: 2000, end: 5000 };
      const out = await effect.apply(source, range, effect.defaults);

      for (let c = 0; c < out.channels.length; c++) {
        for (let i = 0; i < range.start; i++) {
          expect(out.channels[c][i], `${effect.id} wrote before the range`).toBe(source.channels[c][i]);
        }
        for (let i = range.end; i < frameCount(out); i++) {
          expect(out.channels[c][i], `${effect.id} wrote after the range`).toBe(source.channels[c][i]);
        }
      }
    });
  }

  it('changes something inside the range', async () => {
    // A no-op at its defaults would pass every check above, so assert the
    // opposite too: each effect audibly does something out of the box.
    //
    // `equalizer` is the one deliberate exception: it is a dial-in tool with
    // no automatic target, so 0 dB of gain — a genuine no-op, not a rounding
    // artefact — is the only honest default, the same way the Gain sheet
    // defaults to 0 dB. Every other effect is expected to do something.
    for (const effect of EFFECTS.filter((entry) => entry.id !== 'equalizer')) {
      const out = await effect.apply(stereo, whole, effect.defaults);
      let changed = false;
      for (let c = 0; c < out.channels.length && !changed; c++) {
        for (let i = 0; i < frameCount(out); i++) {
          if (Math.abs(out.channels[c][i] - stereo.channels[c][i]) > 1e-6) {
            changed = true;
            break;
          }
        }
      }
      expect(changed, `${effect.id} is a no-op at its defaults`).toBe(true);
    }
  });

  it('marks exactly the effects ffmpeg restricts to a stereo layout', () => {
    const stereoOnly = EFFECTS.filter((effect) => effect.stereoOnly).map((effect) => effect.id);
    expect(stereoOnly.sort()).toEqual(['apulsator', 'crossfeed', 'haas', 'stereowiden']);
  });

  it('runs the mono-safe effects on a mono track', async () => {
    const mono = fixture(4000, 1);
    const range = { start: 0, end: frameCount(mono) };
    for (const effect of EFFECTS.filter((entry) => !entry.stereoOnly)) {
      const out = await effect.apply(mono, range, effect.defaults);
      expect(channelCount(out), `${effect.id} on mono`).toBe(1);
      expect(frameCount(out), `${effect.id} on mono`).toBe(frameCount(mono));
    }
  });
});

describe('behaviours pinned against a single ffmpeg version', () => {
  /**
   * ffmpeg 6.1 truncates stereowiden's delay length where upstream rounds it,
   * so a comparison against 6.1 alone cannot decide this. 7 ms at 44.1 kHz is
   * 308.7 samples: rounding gives 309, truncating 308.
   */
  it('rounds stereowiden’s delay length rather than truncating it', () => {
    const frames = 2000;
    const pcm = createPcm(2, frames, RATE);
    pcm.channels[0][0] = 1;

    const out = fx.stereowiden(
      pcm,
      { start: 0, end: frames },
      { delay: 7, feedback: 1, crossfeed: 0, drymix: 0 },
    );

    // The impulse in the left channel reaches the right output through the
    // delay line, so where it lands names the length the filter chose.
    let landed = -1;
    for (let i = 0; i < frames; i++) {
      if (Math.abs(out.channels[1][i]) > 0.5) {
        landed = i;
        break;
      }
    }
    expect(landed).toBe(309);
  });

  /**
   * A negative intensity selects ffmpeg's inverse recursion, which feeds its
   * own output back. Hand-computed here from the two-line filter body so the
   * distinction survives without ffmpeg present.
   */
  it('runs crystalizer’s inverse recursion for a negative intensity', () => {
    const frames = 4;
    const pcm = createPcm(1, frames, RATE);
    pcm.channels[0].set([0.5, 0.25, -0.125, 0]);

    const out = fx.crystalizer(pcm, { start: 0, end: frames }, { intensity: -1, clip: 0 });

    // scale = 1/(1 − i) = 0.5; y = (x − y₋₁·i)·scale = (x + y₋₁)·0.5.
    const expected: number[] = [];
    let previous = 0;
    for (const x of [0.5, 0.25, -0.125, 0]) {
      previous = (x + previous) * 0.5;
      expected.push(previous);
    }
    for (let i = 0; i < frames; i++) {
      expect(out.channels[0][i]).toBeCloseTo(expected[i], 6);
    }
  });

  it('runs crystalizer’s forward filter for a positive intensity', () => {
    const frames = 4;
    const pcm = createPcm(1, frames, RATE);
    pcm.channels[0].set([0.5, 0.25, -0.125, 0]);

    const out = fx.crystalizer(pcm, { start: 0, end: frames }, { intensity: 1, clip: 0 });

    // y = x + (x − x₋₁)·i, state taken from the input rather than the output.
    const expected = [1.0, 0, -0.5, 0.125];
    for (let i = 0; i < frames; i++) {
      expect(out.channels[0][i]).toBeCloseTo(expected[i], 6);
    }
  });

  /**
   * The oversampled soft-clip path runs in blocks of 8192 input frames so a
   * long selection cannot allocate its length times the oversampling factor.
   * That is only equivalent to one pass if the anti-alias filters carry their
   * state across the boundary, and a reset would show as a step in the output.
   */
  it('carries soft-clip filter state across its block boundary', () => {
    const frames = 8192 * 2 + 500;
    const pcm = createPcm(1, frames, RATE);
    for (let i = 0; i < frames; i++) {
      pcm.channels[0][i] = 0.7 * Math.sin((2 * Math.PI * 180 * i) / RATE);
    }

    const out = fx.asoftclip(
      pcm,
      { start: 0, end: frames },
      { type: 1, threshold: 0.5, output: 1, param: 1, oversample: 4 },
    );

    // The step across the boundary must be in line with the steps either side
    // of it; a reset filter would put a discontinuity there.
    const stepAt = (i: number): number => Math.abs(out.channels[0][i + 1] - out.channels[0][i]);
    const boundary = stepAt(8191);
    const neighbours = [stepAt(8150), stepAt(8180), stepAt(8200), stepAt(8230)];
    const typical = neighbours.reduce((sum, step) => sum + step, 0) / neighbours.length;

    expect(boundary).toBeLessThan(typical * 3);
    expect(Number.isFinite(out.channels[0][8192])).toBe(true);
  });

  /**
   * ffmpeg sizes the tremolo table with `lrint`, which breaks ties to even.
   * 44100/5 + 0.5 is exactly 8820.5, so `Math.round` would give 8821 and the
   * modulation would drift a sample per cycle against the real filter.
   */
  it('sizes the tremolo table by breaking the tie to even', () => {
    const frames = 8820 * 2;
    const pcm = createPcm(1, frames, RATE);
    pcm.channels[0].fill(1);

    const out = fx.tremolo(pcm, { start: 0, end: frames }, { frequency: 5, depth: 0.5 });

    // A constant input makes the output the table itself, so the period is
    // directly measurable. Sample 2205 is a quarter period in, where the
    // modulation is at its steepest and neighbouring samples are furthest
    // apart — at a peak the curve is flat and an off-by-one hides in the noise.
    const probe = 2205;
    expect(out.channels[0][probe], 'one period apart').toBeCloseTo(
      out.channels[0][probe + 8820],
      6,
    );
    // 8821 apart must land on the neighbouring entry instead, which is what
    // rules out the off-by-one: the two assertions swap if the size is wrong.
    expect(Math.abs(out.channels[0][probe] - out.channels[0][probe + 8821])).toBeGreaterThan(1e-5);
  });
});

describe('declick, gate and equalizer', () => {
  /**
   * A sine with one sample driven far outside its own range — the AR model
   * fitted to the surrounding, highly predictable signal should flag it and
   * fill it in from that model, landing close to where the untouched sine
   * would have been.
   */
  it('removes an injected click from an otherwise smooth tone', async () => {
    const frames = 8000;
    const pcm = createPcm(1, frames, RATE);
    for (let i = 0; i < frames; i++) pcm.channels[0][i] = 0.4 * Math.sin((2 * Math.PI * 300 * i) / RATE);
    const trueValue = pcm.channels[0][4000];
    pcm.channels[0][4000] = 0.95;

    const declickSpec = findEffect('declick')!;
    const out = await declickSpec.apply(pcm, { start: 0, end: frames }, declickSpec.defaults);

    const rawError = Math.abs(0.95 - trueValue);
    const repairedError = Math.abs(out.channels[0][4000] - trueValue);
    expect(repairedError, 'repaired sample should land near the true curve').toBeLessThan(rawError * 0.1);
  });

  /**
   * Away from the true edges of the buffer — where `declick`'s own
   * reconstruction is inherently a ramp, by design, see `effects.ts` — a
   * click-free tone should come back close to what went in.
   */
  it('leaves a click-free tone close to unchanged, away from the true edges', async () => {
    const frames = 20000;
    const pcm = createPcm(1, frames, RATE);
    for (let i = 0; i < frames; i++) pcm.channels[0][i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / RATE);

    const declickSpec = findEffect('declick')!;
    const out = await declickSpec.apply(pcm, { start: 0, end: frames }, declickSpec.defaults);

    let worst = 0;
    for (let i = 5000; i < 15000; i++) worst = Math.max(worst, Math.abs(out.channels[0][i] - pcm.channels[0][i]));
    expect(worst).toBeLessThan(1e-6);
  });

  /**
   * Regression pin for a real bug: the first version of this port reached for
   * left context past the true start of the buffer regardless of whether any
   * real audio existed there, fitting an AR model to a window that mixed real
   * signal with synthetic zero-padding — a window ffmpeg's own reconstruction
   * never computes for `method: add` (cross-fade), since it has no window
   * before its first one. Caught by `effects-ffmpeg.test.ts` at 0.42 absolute
   * divergence on a whole-track comparison.
   *
   * `method: save` (Direct) is what pins it here without ffmpeg present, and
   * on purpose: cross-fade's own reconstruction blends contributions from
   * multiple overlapping windows, weighted by a window function that is
   * still ramping up this close to a true stream start — a few tenths of
   * amplitude of repair error at sample 50 is that ramp, present in ffmpeg's
   * own output too, not a bug, and measuring it precisely here would pin an
   * artefact of the reconstruction rather than the click detector. Direct
   * mode has no such blend — each window's own centre chunk is taken
   * verbatim — so a click near the edge repairs exactly there, and does
   * before and after the fix in this file; only cross-fade's true-edge
   * behaviour was ever wrong, which is what the ffmpeg-backed test now pins.
   */
  it('repairs a click close to the true start of the buffer under overlap-save', async () => {
    const frames = 8000;
    const pcm = createPcm(1, frames, RATE);
    for (let i = 0; i < frames; i++) pcm.channels[0][i] = 0.4 * Math.sin((2 * Math.PI * 300 * i) / RATE);
    const trueValue = pcm.channels[0][50];
    pcm.channels[0][50] = -0.95;

    const declickSpec = findEffect('declick')!;
    const out = await declickSpec.apply(pcm, { start: 0, end: frames }, { ...declickSpec.defaults, method: 1 });

    expect(Math.abs(out.channels[0][50] - trueValue)).toBeLessThan(0.01);
  });

  it('reports nondecreasing progress across channels while it runs', async () => {
    const frames = RATE * 5;
    const pcm = createPcm(2, frames, RATE);
    let seed = 1;
    for (let c = 0; c < 2; c++) {
      for (let i = 0; i < frames; i++) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        pcm.channels[c][i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / RATE) + 0.2 * (seed / 2 ** 32 - 0.5);
      }
    }

    const reports: number[] = [];
    await fx.declick(pcm, { start: 0, end: frames }, findEffect('declick')!.defaults, (f) => reports.push(f));

    expect(reports.length).toBeGreaterThan(1);
    for (let i = 1; i < reports.length; i++) expect(reports[i]).toBeGreaterThanOrEqual(reports[i - 1]);
    expect(reports[0]).toBeGreaterThanOrEqual(0);
    expect(reports[reports.length - 1]).toBeLessThanOrEqual(1);
    expect(reports.some((f) => f > 0.5), 'progress should reach the second channel').toBe(true);
  });

  it('quiets a section below its threshold and leaves a loud one alone', async () => {
    const frames = 30000;
    const pcm = createPcm(1, frames, RATE);
    for (let i = 0; i < frames; i++) {
      // Loud for the first half, quiet (below the -18 dBFS-ish default
      // threshold of 0.125) for the second.
      const amplitude = i < frames / 2 ? 0.6 : 0.02;
      pcm.channels[0][i] = amplitude * Math.sin((2 * Math.PI * 300 * i) / RATE);
    }

    const gateSpec = findEffect('agate')!;
    const out = await gateSpec.apply(pcm, { start: 0, end: frames }, gateSpec.defaults);

    const peak = (from: number, to: number): number => {
      let value = 0;
      for (let i = from; i < to; i++) value = Math.max(value, Math.abs(out.channels[0][i]));
      return value;
    };
    // Well after the release has settled, near the end of each half.
    expect(peak(frames / 2 - 2000, frames / 2 - 500), 'loud section').toBeGreaterThan(0.5);
    expect(peak(frames - 2000, frames - 500), 'gated quiet section').toBeLessThan(0.02);
  });

  it('boosts energy at the target frequency and cuts it in the opposite direction', async () => {
    const frames = 8192;
    const pcm = createPcm(1, frames, RATE);
    for (let i = 0; i < frames; i++) pcm.channels[0][i] = 0.2 * Math.sin((2 * Math.PI * 1000 * i) / RATE);

    const energy = (channel: Float32Array): number => {
      let sum = 0;
      for (let i = 1000; i < frames; i++) sum += channel[i] * channel[i];
      return sum;
    };

    const equalizerSpec = findEffect('equalizer')!;
    const source = energy(pcm.channels[0]);
    const boosted = await equalizerSpec.apply(pcm, { start: 0, end: frames }, { frequency: 1000, width: 1, gain: 12 });
    const cut = await equalizerSpec.apply(pcm, { start: 0, end: frames }, { frequency: 1000, width: 1, gain: -12 });

    expect(energy(boosted.channels[0])).toBeGreaterThan(source * 2);
    expect(energy(cut.channels[0])).toBeLessThan(source * 0.5);
  });
});
