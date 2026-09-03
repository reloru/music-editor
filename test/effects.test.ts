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
    it(`${effect.id} keeps the buffer's shape and produces finite samples`, () => {
      const out = effect.apply(stereo, whole, effect.defaults);
      expect(channelCount(out)).toBe(channelCount(stereo));
      expect(frameCount(out)).toBe(frameCount(stereo));
      expect(out.sampleRate).toBe(stereo.sampleRate);
      for (const channel of out.channels) {
        for (let i = 0; i < channel.length; i++) {
          expect(Number.isFinite(channel[i]), `${effect.id} sample ${i}`).toBe(true);
        }
      }
    });

    it(`${effect.id} does not mutate its input`, () => {
      const source = fixture();
      const before = source.channels.map((channel) => Float32Array.from(channel));
      effect.apply(source, whole, effect.defaults);
      for (let c = 0; c < before.length; c++) {
        expect(Array.from(source.channels[c])).toEqual(Array.from(before[c]));
      }
    });

    it(`${effect.id} touches nothing outside the range`, () => {
      const source = fixture();
      const range = { start: 2000, end: 5000 };
      const out = effect.apply(source, range, effect.defaults);

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

  it('changes something inside the range', () => {
    // A no-op at its defaults would pass every check above, so assert the
    // opposite too: each effect audibly does something out of the box.
    for (const effect of EFFECTS) {
      const out = effect.apply(stereo, whole, effect.defaults);
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

  it('runs the mono-safe effects on a mono track', () => {
    const mono = fixture(4000, 1);
    const range = { start: 0, end: frameCount(mono) };
    for (const effect of EFFECTS.filter((entry) => !entry.stereoOnly)) {
      const out = effect.apply(mono, range, effect.defaults);
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
