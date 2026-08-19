import { describe, expect, it } from 'vitest';
import * as dsp from '../src/audio/dsp';
import { createPcm, dbToLinear, frameCount, linearToDb, type Pcm } from '../src/audio/pcm';

function pcmFrom(channels: number[][], sampleRate = 8000): Pcm {
  return { sampleRate, channels: channels.map((values) => Float32Array.from(values)) };
}

function values(pcm: Pcm, channel = 0): number[] {
  return Array.from(pcm.channels[channel]);
}

describe('slice and remove', () => {
  const source = pcmFrom([[0, 1, 2, 3, 4, 5]]);

  it('slices a half-open range', () => {
    expect(values(dsp.slice(source, { start: 1, end: 4 }))).toEqual([1, 2, 3]);
  });

  it('closes the gap when removing', () => {
    expect(values(dsp.remove(source, { start: 1, end: 4 }))).toEqual([0, 4, 5]);
  });

  it('clamps ranges that run past the end', () => {
    expect(values(dsp.slice(source, { start: 4, end: 99 }))).toEqual([4, 5]);
  });

  it('leaves the source untouched', () => {
    dsp.remove(source, { start: 0, end: 3 });
    expect(values(source)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('treats an inverted range as the same span', () => {
    expect(values(dsp.slice(source, { start: 4, end: 1 }))).toEqual([1, 2, 3]);
  });
});

describe('insert and replace', () => {
  const source = pcmFrom([[1, 2, 3]]);
  const clip = pcmFrom([[9, 9]]);

  it('splices a clip in at a position', () => {
    expect(values(dsp.insert(source, clip, 1))).toEqual([1, 9, 9, 2, 3]);
  });

  it('appends when inserting past the end', () => {
    expect(values(dsp.insert(source, clip, 99))).toEqual([1, 2, 3, 9, 9]);
  });

  it('replaces a range with the clip', () => {
    expect(values(dsp.replaceRange(source, { start: 0, end: 2 }, clip))).toEqual([9, 9, 3]);
  });

  it('up-mixes a mono clip into a stereo document', () => {
    const stereo = pcmFrom([
      [1, 2],
      [3, 4],
    ]);
    const result = dsp.insert(stereo, pcmFrom([[7]]), 1);
    expect(values(result, 0)).toEqual([1, 7, 2]);
    expect(values(result, 1)).toEqual([3, 7, 4]);
  });

  it('resamples a clip recorded at another rate', () => {
    const clip44 = pcmFrom([[1, 1, 1, 1]], 4000);
    const result = dsp.insert(pcmFrom([[0, 0]], 8000), clip44, 1);
    // Twice the rate means twice the samples.
    expect(frameCount(result)).toBe(2 + 8);
  });
});

describe('level operations', () => {
  it('scales by a linear gain', () => {
    const result = dsp.applyGain(pcmFrom([[0.1, 0.2]]), { start: 0, end: 2 }, 2);
    expect(values(result)[0]).toBeCloseTo(0.2, 6);
    expect(values(result)[1]).toBeCloseTo(0.4, 6);
  });

  it('only touches the selected range', () => {
    const result = dsp.applyGain(pcmFrom([[1, 1, 1]]), { start: 1, end: 2 }, 0.5);
    expect(values(result)).toEqual([1, 0.5, 1]);
  });

  it('keeps headroom above full scale so a boost stays reversible', () => {
    const boosted = dsp.applyGainDb(pcmFrom([[0.8]]), { start: 0, end: 1 }, 12);
    expect(values(boosted)[0]).toBeGreaterThan(1);
    const restored = dsp.normalize(boosted, { start: 0, end: 1 }, 0);
    expect(values(restored)[0]).toBeCloseTo(1, 5);
  });

  it('normalises the peak to the requested level', () => {
    const result = dsp.normalize(pcmFrom([[0.25, -0.5, 0.1]]), { start: 0, end: 3 }, -6);
    expect(linearToDb(dsp.peakAmplitude(result, { start: 0, end: 3 }))).toBeCloseTo(-6, 4);
  });

  it('leaves digital silence alone rather than dividing by zero', () => {
    const result = dsp.normalize(pcmFrom([[0, 0, 0]]), { start: 0, end: 3 });
    expect(values(result)).toEqual([0, 0, 0]);
  });

  it('measures RMS across channels', () => {
    const rms = dsp.rmsAmplitude(
      pcmFrom([
        [1, 1],
        [0, 0],
      ]),
      { start: 0, end: 2 },
    );
    expect(rms).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('removes a DC offset', () => {
    const result = dsp.removeDcOffset(pcmFrom([[0.5, 0.7, 0.3]]), { start: 0, end: 3 });
    const sum = values(result).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(0, 6);
  });
});

describe('fades', () => {
  it('starts a fade in at silence and ends at full level', () => {
    const result = dsp.fade(pcmFrom([[1, 1, 1, 1, 1]]), { start: 0, end: 5 }, 'in', 'linear');
    expect(values(result)[0]).toBeCloseTo(0, 6);
    expect(values(result)[4]).toBeCloseTo(1, 6);
  });

  it('reverses that shape for a fade out', () => {
    const result = dsp.fade(pcmFrom([[1, 1, 1, 1, 1]]), { start: 0, end: 5 }, 'out', 'linear');
    expect(values(result)[0]).toBeCloseTo(1, 6);
    expect(values(result)[4]).toBeCloseTo(0, 6);
  });

  it('holds power constant through an equal-power fade', () => {
    const result = dsp.fade(pcmFrom([[1, 1, 1]]), { start: 0, end: 3 }, 'in', 'equalPower');
    // Halfway through, an equal-power ramp sits at sin(45°).
    expect(values(result)[1]).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('tapers both ends when declicking', () => {
    const flat = createPcm(1, 100, 1000);
    flat.channels[0].fill(1);
    const result = dsp.declick(flat, { start: 0, end: 100 }, 3);
    expect(values(result)[0]).toBeCloseTo(0, 6);
    expect(values(result)[99]).toBeCloseTo(0, 6);
    expect(values(result)[50]).toBe(1);
  });
});

describe('structural operations', () => {
  it('reverses only the selected range', () => {
    const result = dsp.reverse(pcmFrom([[1, 2, 3, 4]]), { start: 1, end: 4 });
    expect(values(result)).toEqual([1, 4, 3, 2]);
  });

  it('zeroes a range without changing length', () => {
    const result = dsp.silence(pcmFrom([[1, 1, 1]]), { start: 0, end: 2 });
    expect(values(result)).toEqual([0, 0, 1]);
  });

  it('inserts silence of the requested duration', () => {
    const result = dsp.insertSilence(pcmFrom([[1, 1]], 1000), 1, 0.5);
    expect(frameCount(result)).toBe(2 + 500);
    expect(values(result)[1]).toBe(0);
  });

  it('down-mixes stereo to mono by averaging', () => {
    const result = dsp.setChannelCount(
      pcmFrom([
        [1, 1],
        [0, 0],
      ]),
      1,
    );
    expect(result.channels).toHaveLength(1);
    expect(values(result)).toEqual([0.5, 0.5]);
  });

  it('resamples to the requested rate and length', () => {
    const result = dsp.resample(pcmFrom([[0, 1, 0, 1]], 8000), 16000);
    expect(result.sampleRate).toBe(16000);
    expect(frameCount(result)).toBe(8);
  });

  it('keeps signal level through a resample', () => {
    const source = createPcm(1, 400, 8000);
    for (let i = 0; i < 400; i++) source.channels[0][i] = Math.sin((2 * Math.PI * 200 * i) / 8000);
    const result = dsp.resample(source, 16000);
    expect(dsp.peakAmplitude(result, { start: 0, end: frameCount(result) })).toBeCloseTo(1, 1);
  });
});

describe('decibel conversion', () => {
  it('round-trips through linear', () => {
    expect(linearToDb(dbToLinear(-6))).toBeCloseTo(-6, 9);
  });

  it('maps unity gain to 0 dB', () => {
    expect(linearToDb(1)).toBe(0);
  });

  it('treats silence as negative infinity', () => {
    expect(linearToDb(0)).toBe(-Infinity);
  });
});
