/**
 * Waveform summary data.
 *
 * Scanning raw samples for every repaint is hopeless on a phone — a five minute
 * stereo track is ~26 million samples and the canvas is only ~430 points wide.
 * Instead we precompute a mipmap-style pyramid of min/max/RMS buckets once per
 * edit and pick the level that matches the current zoom, so a repaint touches a
 * few hundred values regardless of how long the file is.
 */
import { type Pcm, frameCount } from './pcm';

export interface PeakLevel {
  samplesPerBucket: number;
  /** Per channel, one entry per bucket. */
  min: Float32Array[];
  max: Float32Array[];
  rms: Float32Array[];
}

export interface PeakPyramid {
  channels: number;
  length: number;
  levels: PeakLevel[];
}

const BASE_BUCKET = 256;

export function buildPeaks(pcm: Pcm, baseBucket = BASE_BUCKET): PeakPyramid {
  const channels = pcm.channels.length;
  const length = frameCount(pcm);
  const levels: PeakLevel[] = [];

  if (channels === 0 || length === 0) {
    return { channels, length, levels };
  }

  levels.push(buildBaseLevel(pcm, baseBucket));

  // Halve the resolution until a whole file fits in a handful of buckets.
  while (true) {
    const previous = levels[levels.length - 1];
    const buckets = previous.min[0].length;
    if (buckets <= 8) break;
    levels.push(halveLevel(previous));
  }

  return { channels, length, levels };
}

function buildBaseLevel(pcm: Pcm, samplesPerBucket: number): PeakLevel {
  const length = frameCount(pcm);
  const buckets = Math.max(1, Math.ceil(length / samplesPerBucket));
  const level: PeakLevel = { samplesPerBucket, min: [], max: [], rms: [] };

  for (const channel of pcm.channels) {
    const min = new Float32Array(buckets);
    const max = new Float32Array(buckets);
    const rms = new Float32Array(buckets);

    for (let b = 0; b < buckets; b++) {
      const start = b * samplesPerBucket;
      const end = Math.min(length, start + samplesPerBucket);
      let lo = 0;
      let hi = 0;
      let sumSquares = 0;
      if (end > start) {
        lo = channel[start];
        hi = channel[start];
        for (let i = start; i < end; i++) {
          const value = channel[i];
          if (value < lo) lo = value;
          if (value > hi) hi = value;
          sumSquares += value * value;
        }
      }
      min[b] = lo;
      max[b] = hi;
      rms[b] = end > start ? Math.sqrt(sumSquares / (end - start)) : 0;
    }

    level.min.push(min);
    level.max.push(max);
    level.rms.push(rms);
  }
  return level;
}

function halveLevel(source: PeakLevel): PeakLevel {
  const buckets = Math.ceil(source.min[0].length / 2);
  const level: PeakLevel = {
    samplesPerBucket: source.samplesPerBucket * 2,
    min: [],
    max: [],
    rms: [],
  };

  for (let c = 0; c < source.min.length; c++) {
    const sourceMin = source.min[c];
    const sourceMax = source.max[c];
    const sourceRms = source.rms[c];
    const min = new Float32Array(buckets);
    const max = new Float32Array(buckets);
    const rms = new Float32Array(buckets);

    for (let b = 0; b < buckets; b++) {
      const a = b * 2;
      const hasPair = a + 1 < sourceMin.length;
      min[b] = hasPair ? Math.min(sourceMin[a], sourceMin[a + 1]) : sourceMin[a];
      max[b] = hasPair ? Math.max(sourceMax[a], sourceMax[a + 1]) : sourceMax[a];
      // Equal-width buckets, so combining mean-squares is exact.
      rms[b] = hasPair
        ? Math.sqrt((sourceRms[a] * sourceRms[a] + sourceRms[a + 1] * sourceRms[a + 1]) / 2)
        : sourceRms[a];
    }

    level.min.push(min);
    level.max.push(max);
    level.rms.push(rms);
  }
  return level;
}

export interface Column {
  min: Float32Array;
  max: Float32Array;
  rms: Float32Array;
}

export function createColumn(width: number): Column {
  return { min: new Float32Array(width), max: new Float32Array(width), rms: new Float32Array(width) };
}

/**
 * Fills `out` with one min/max/RMS triple per pixel for the sample window
 * `[startSample, endSample)` of `channelIndex`.
 */
export function readColumn(
  pcm: Pcm,
  pyramid: PeakPyramid,
  channelIndex: number,
  startSample: number,
  endSample: number,
  out: Column,
): void {
  const width = out.min.length;
  const channel = pcm.channels[channelIndex];
  if (!channel || width === 0) return;

  const total = frameCount(pcm);
  const from = Math.max(0, Math.min(total, startSample));
  const to = Math.max(from, Math.min(total, endSample));
  const samplesPerPixel = (to - from) / width;

  const level = pickLevel(pyramid, samplesPerPixel);
  if (!level) {
    readRaw(channel, from, to, out);
    return;
  }

  const min = level.min[channelIndex];
  const max = level.max[channelIndex];
  const rms = level.rms[channelIndex];
  const perBucket = level.samplesPerBucket;

  for (let x = 0; x < width; x++) {
    const sampleStart = from + x * samplesPerPixel;
    const sampleEnd = from + (x + 1) * samplesPerPixel;
    const first = Math.min(min.length - 1, Math.max(0, Math.floor(sampleStart / perBucket)));
    const last = Math.min(min.length - 1, Math.max(first, Math.ceil(sampleEnd / perBucket) - 1));

    let lo = min[first];
    let hi = max[first];
    let squares = rms[first] * rms[first];
    for (let b = first + 1; b <= last; b++) {
      if (min[b] < lo) lo = min[b];
      if (max[b] > hi) hi = max[b];
      squares += rms[b] * rms[b];
    }
    out.min[x] = lo;
    out.max[x] = hi;
    out.rms[x] = Math.sqrt(squares / (last - first + 1));
  }
}

function pickLevel(pyramid: PeakPyramid, samplesPerPixel: number): PeakLevel | null {
  let chosen: PeakLevel | null = null;
  for (const level of pyramid.levels) {
    // Stay at or below one bucket per pixel so detail is never invented.
    if (level.samplesPerBucket <= samplesPerPixel) chosen = level;
    else break;
  }
  return chosen;
}

/** Zoomed in past the finest pyramid level: read the samples themselves. */
function readRaw(channel: Float32Array, from: number, to: number, out: Column): void {
  const width = out.min.length;
  const samplesPerPixel = (to - from) / width;

  for (let x = 0; x < width; x++) {
    const start = Math.floor(from + x * samplesPerPixel);
    const end = Math.max(start + 1, Math.ceil(from + (x + 1) * samplesPerPixel));
    let lo = 0;
    let hi = 0;
    let squares = 0;
    let count = 0;
    for (let i = start; i < end && i < channel.length; i++) {
      const value = channel[i];
      if (count === 0 || value < lo) lo = value;
      if (count === 0 || value > hi) hi = value;
      squares += value * value;
      count++;
    }
    out.min[x] = lo;
    out.max[x] = hi;
    out.rms[x] = count > 0 ? Math.sqrt(squares / count) : 0;
  }
}
