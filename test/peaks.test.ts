import { describe, expect, it } from 'vitest';
import { buildPeaks, createColumn, readColumn } from '../src/audio/peaks';
import { createPcm, type Pcm } from '../src/audio/pcm';

function ramp(frames: number, channels = 1): Pcm {
  const pcm = createPcm(channels, frames, 8000);
  for (let c = 0; c < channels; c++) {
    for (let i = 0; i < frames; i++) {
      pcm.channels[c][i] = Math.sin((i / frames) * Math.PI * 8) * (c === 0 ? 1 : 0.5);
    }
  }
  return pcm;
}

/** What the column ought to contain, computed the slow, obvious way. */
function bruteForce(pcm: Pcm, channel: number, from: number, to: number, width: number) {
  const min: number[] = [];
  const max: number[] = [];
  const samplesPerPixel = (to - from) / width;
  for (let x = 0; x < width; x++) {
    const start = Math.floor(from + x * samplesPerPixel);
    const end = Math.max(start + 1, Math.ceil(from + (x + 1) * samplesPerPixel));
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = start; i < end && i < pcm.channels[channel].length; i++) {
      lo = Math.min(lo, pcm.channels[channel][i]);
      hi = Math.max(hi, pcm.channels[channel][i]);
    }
    min.push(lo);
    max.push(hi);
  }
  return { min, max };
}

describe('buildPeaks', () => {
  it('builds levels down to a handful of buckets', () => {
    const pyramid = buildPeaks(ramp(100_000));
    expect(pyramid.levels.length).toBeGreaterThan(1);
    expect(pyramid.levels[0].samplesPerBucket).toBe(256);
    expect(pyramid.levels[1].samplesPerBucket).toBe(512);
    expect(pyramid.levels[pyramid.levels.length - 1].min[0].length).toBeLessThanOrEqual(8);
  });

  it('keeps one set of buckets per channel', () => {
    const pyramid = buildPeaks(ramp(10_000, 2));
    expect(pyramid.levels[0].min).toHaveLength(2);
    expect(pyramid.channels).toBe(2);
  });

  it('handles an empty buffer without levels', () => {
    const pyramid = buildPeaks(createPcm(1, 0, 8000));
    expect(pyramid.levels).toHaveLength(0);
  });

  it('records the true extremes of the signal at the base level', () => {
    const pcm = createPcm(1, 512, 8000);
    pcm.channels[0][100] = 0.8;
    pcm.channels[0][300] = -0.6;
    const level = buildPeaks(pcm).levels[0];
    // Bucket 0 spans samples 0-255, bucket 1 spans 256-511.
    expect(level.max[0][0]).toBeCloseTo(0.8, 6);
    expect(level.min[0][1]).toBeCloseTo(-0.6, 6);
  });
});

describe('readColumn', () => {
  it('never reports a peak the signal does not reach', () => {
    const pcm = ramp(50_000);
    const pyramid = buildPeaks(pcm);
    const column = createColumn(64);
    readColumn(pcm, pyramid, 0, 0, 50_000, column);

    for (let x = 0; x < 64; x++) {
      expect(column.max[x]).toBeLessThanOrEqual(1.000001);
      expect(column.min[x]).toBeGreaterThanOrEqual(-1.000001);
      expect(column.max[x]).toBeGreaterThanOrEqual(column.min[x]);
    }
  });

  it('matches a direct scan when zoomed past the finest level', () => {
    const pcm = ramp(4000);
    const pyramid = buildPeaks(pcm);
    const width = 32;
    const column = createColumn(width);
    // 64 samples across 32 pixels is well below the 256-sample base bucket.
    readColumn(pcm, pyramid, 0, 1000, 1064, column);

    const expected = bruteForce(pcm, 0, 1000, 1064, width);
    for (let x = 0; x < width; x++) {
      expect(column.min[x]).toBeCloseTo(expected.min[x], 6);
      expect(column.max[x]).toBeCloseTo(expected.max[x], 6);
    }
  });

  it('covers the signal envelope when zoomed out', () => {
    const pcm = ramp(200_000);
    const pyramid = buildPeaks(pcm);
    const column = createColumn(100);
    readColumn(pcm, pyramid, 0, 0, 200_000, column);

    // A full-scale sine must show up as full scale somewhere on screen.
    expect(Math.max(...column.max)).toBeGreaterThan(0.98);
    expect(Math.min(...column.min)).toBeLessThan(-0.98);
  });

  it('reads the requested channel', () => {
    const pcm = ramp(20_000, 2);
    const pyramid = buildPeaks(pcm);
    const left = createColumn(16);
    const right = createColumn(16);
    readColumn(pcm, pyramid, 0, 0, 20_000, left);
    readColumn(pcm, pyramid, 1, 0, 20_000, right);
    expect(Math.max(...right.max)).toBeLessThan(Math.max(...left.max));
  });

  it('clamps a window that runs past the end of the buffer', () => {
    const pcm = ramp(1000);
    const pyramid = buildPeaks(pcm);
    const column = createColumn(8);
    expect(() => readColumn(pcm, pyramid, 0, 900, 5000, column)).not.toThrow();
  });
});
