/**
 * Every destructive edit the editor can perform, as pure functions.
 *
 * Each one takes a `Pcm` and returns a new `Pcm`; the input is never mutated.
 * That costs a copy per edit but makes undo/redo a matter of keeping the old
 * reference, and it makes the whole edit surface testable without a browser.
 */
import {
  type Pcm,
  type Range,
  channelCount,
  clampRange,
  clonePcm,
  createPcm,
  dbToLinear,
  frameCount,
  rangeLength,
} from './pcm';

export type FadeCurve = 'linear' | 'equalPower' | 'exponential';

/** Returns the samples inside `range` as a standalone buffer. */
export function slice(pcm: Pcm, range: Range): Pcm {
  const { start, end } = clampRange(pcm, range);
  return {
    sampleRate: pcm.sampleRate,
    channels: pcm.channels.map((channel) => channel.slice(start, end)),
  };
}

/** Removes `range`, closing the gap. */
export function remove(pcm: Pcm, range: Range): Pcm {
  const { start, end } = clampRange(pcm, range);
  const removed = end - start;
  if (removed <= 0) return clonePcm(pcm);

  const total = frameCount(pcm);
  const out = createPcm(channelCount(pcm), total - removed, pcm.sampleRate);
  for (let c = 0; c < pcm.channels.length; c++) {
    const source = pcm.channels[c];
    const target = out.channels[c];
    target.set(source.subarray(0, start), 0);
    target.set(source.subarray(end), start);
  }
  return out;
}

/** Keeps only `range`, discarding everything outside it. */
export function trimTo(pcm: Pcm, range: Range): Pcm {
  return slice(pcm, range);
}

/** Splices `clip` into `pcm` at sample position `at`. */
export function insert(pcm: Pcm, clip: Pcm, at: number): Pcm {
  const total = frameCount(pcm);
  const position = Math.max(0, Math.min(total, Math.round(at)));
  const adapted = conform(clip, pcm.sampleRate, channelCount(pcm));
  const clipLength = frameCount(adapted);
  if (clipLength === 0) return clonePcm(pcm);

  const out = createPcm(channelCount(pcm), total + clipLength, pcm.sampleRate);
  for (let c = 0; c < pcm.channels.length; c++) {
    const source = pcm.channels[c];
    const target = out.channels[c];
    target.set(source.subarray(0, position), 0);
    target.set(adapted.channels[c], position);
    target.set(source.subarray(position), position + clipLength);
  }
  return out;
}

/** Replaces `range` with `clip` (the paste-over-a-selection case). */
export function replaceRange(pcm: Pcm, range: Range, clip: Pcm): Pcm {
  const { start, end } = clampRange(pcm, range);
  return insert(remove(pcm, { start, end }), clip, start);
}

/** Inserts `seconds` of silence at sample position `at`. */
export function insertSilence(pcm: Pcm, at: number, seconds: number): Pcm {
  const length = Math.max(0, Math.round(seconds * pcm.sampleRate));
  if (length === 0) return clonePcm(pcm);
  return insert(pcm, createPcm(channelCount(pcm), length, pcm.sampleRate), at);
}

/** Zeroes `range` without changing the buffer's length. */
export function silence(pcm: Pcm, range: Range): Pcm {
  const { start, end } = clampRange(pcm, range);
  const out = clonePcm(pcm);
  for (const channel of out.channels) channel.fill(0, start, end);
  return out;
}

/**
 * Scales `range` by a linear gain factor.
 *
 * Samples are intentionally left unclamped: keeping the float headroom means a
 * boost followed by `normalize` recovers cleanly instead of baking in clipping.
 * Clamping happens once, at export.
 */
export function applyGain(pcm: Pcm, range: Range, gain: number): Pcm {
  const { start, end } = clampRange(pcm, range);
  const out = clonePcm(pcm);
  for (const channel of out.channels) {
    for (let i = start; i < end; i++) channel[i] *= gain;
  }
  return out;
}

/** Scales `range` by a gain expressed in decibels. */
export function applyGainDb(pcm: Pcm, range: Range, db: number): Pcm {
  return applyGain(pcm, range, dbToLinear(db));
}

/** Flips `range` back to front. */
export function reverse(pcm: Pcm, range: Range): Pcm {
  const { start, end } = clampRange(pcm, range);
  const out = clonePcm(pcm);
  for (const channel of out.channels) {
    let left = start;
    let right = end - 1;
    while (left < right) {
      const temp = channel[left];
      channel[left] = channel[right];
      channel[right] = temp;
      left++;
      right--;
    }
  }
  return out;
}

/**
 * Ramps `range` from silence to full level (`direction: 'in'`) or the reverse.
 *
 * `equalPower` is the sensible default for crossfade-style edits because it
 * keeps perceived loudness constant through the ramp; `linear` matches what
 * most people expect from a visual fade handle.
 */
export function fade(pcm: Pcm, range: Range, direction: 'in' | 'out', curve: FadeCurve = 'equalPower'): Pcm {
  const { start, end } = clampRange(pcm, range);
  const length = end - start;
  if (length <= 0) return clonePcm(pcm);

  const out = clonePcm(pcm);
  for (const channel of out.channels) {
    for (let i = 0; i < length; i++) {
      const position = length === 1 ? 1 : i / (length - 1);
      const progress = direction === 'in' ? position : 1 - position;
      channel[start + i] *= fadeGain(progress, curve);
    }
  }
  return out;
}

function fadeGain(progress: number, curve: FadeCurve): number {
  switch (curve) {
    case 'linear':
      return progress;
    case 'exponential':
      // Perceptually smooth taper that still reaches exactly 0 and 1.
      return progress * progress;
    case 'equalPower':
    default:
      return Math.sin((progress * Math.PI) / 2);
  }
}

/** Highest absolute sample value in `range` (0…1+). */
export function peakAmplitude(pcm: Pcm, range: Range): number {
  const { start, end } = clampRange(pcm, range);
  let peak = 0;
  for (const channel of pcm.channels) {
    for (let i = start; i < end; i++) {
      const value = Math.abs(channel[i]);
      if (value > peak) peak = value;
    }
  }
  return peak;
}

/** Root-mean-square level across all channels in `range`. */
export function rmsAmplitude(pcm: Pcm, range: Range): number {
  const { start, end } = clampRange(pcm, range);
  const length = end - start;
  if (length <= 0 || pcm.channels.length === 0) return 0;
  let sum = 0;
  for (const channel of pcm.channels) {
    for (let i = start; i < end; i++) sum += channel[i] * channel[i];
  }
  return Math.sqrt(sum / (length * pcm.channels.length));
}

/**
 * Peak-normalises `range` so its loudest sample sits at `targetDb` dBFS.
 * -1 dBFS is the usual default: audible headroom without clipping on playback.
 */
export function normalize(pcm: Pcm, range: Range, targetDb = -1): Pcm {
  const peak = peakAmplitude(pcm, range);
  if (peak <= 0) return clonePcm(pcm);
  return applyGain(pcm, range, dbToLinear(targetDb) / peak);
}

/** Removes any DC bias in `range`, which otherwise eats headroom. */
export function removeDcOffset(pcm: Pcm, range: Range): Pcm {
  const { start, end } = clampRange(pcm, range);
  const length = end - start;
  if (length <= 0) return clonePcm(pcm);

  const out = clonePcm(pcm);
  for (const channel of out.channels) {
    let sum = 0;
    for (let i = start; i < end; i++) sum += channel[i];
    const offset = sum / length;
    if (offset === 0) continue;
    for (let i = start; i < end; i++) channel[i] -= offset;
  }
  return out;
}

/**
 * Resamples to `targetRate` with linear interpolation.
 *
 * Good enough for the two places it is used — matching a pasted clip to the
 * project rate, and coercing to a rate the MP3 encoder accepts. Speed changes
 * in the UI go through `OfflineAudioContext`, which resamples far better.
 */
export function resample(pcm: Pcm, targetRate: number): Pcm {
  if (targetRate === pcm.sampleRate || frameCount(pcm) === 0) {
    return { sampleRate: targetRate, channels: pcm.channels.map((c) => Float32Array.from(c)) };
  }
  const ratio = targetRate / pcm.sampleRate;
  const sourceLength = frameCount(pcm);
  const targetLength = Math.max(1, Math.round(sourceLength * ratio));
  const out = createPcm(channelCount(pcm), targetLength, targetRate);

  for (let c = 0; c < pcm.channels.length; c++) {
    const source = pcm.channels[c];
    const target = out.channels[c];
    for (let i = 0; i < targetLength; i++) {
      const position = i / ratio;
      const index = Math.floor(position);
      const fraction = position - index;
      const a = source[Math.min(index, sourceLength - 1)];
      const b = source[Math.min(index + 1, sourceLength - 1)];
      target[i] = a + (b - a) * fraction;
    }
  }
  return out;
}

/** Up-mixes by duplication and down-mixes by averaging. */
export function setChannelCount(pcm: Pcm, count: number): Pcm {
  const current = channelCount(pcm);
  if (count === current || count < 1) return clonePcm(pcm);

  const length = frameCount(pcm);
  const out = createPcm(count, length, pcm.sampleRate);
  if (count < current) {
    // Fold every source channel into every target channel evenly.
    for (let i = 0; i < length; i++) {
      let sum = 0;
      for (const channel of pcm.channels) sum += channel[i];
      const value = sum / current;
      for (const channel of out.channels) channel[i] = value;
    }
  } else {
    for (let c = 0; c < count; c++) {
      out.channels[c].set(pcm.channels[c % current]);
    }
  }
  return out;
}

/** Brings a clip in line with a project's sample rate and channel layout. */
export function conform(clip: Pcm, sampleRate: number, channels: number): Pcm {
  let out = clip.sampleRate === sampleRate ? clip : resample(clip, sampleRate);
  if (channelCount(out) !== channels) out = setChannelCount(out, channels);
  return out === clip ? clonePcm(clip) : out;
}

/**
 * Applies a short equal-power ramp at both ends of `range`.
 * Cutting on a non-zero sample leaves a click; a couple of milliseconds of
 * taper removes it without being audible as a fade.
 */
export function declick(pcm: Pcm, range: Range, milliseconds = 3): Pcm {
  const { start, end } = clampRange(pcm, range);
  const ramp = Math.min(
    Math.floor((milliseconds / 1000) * pcm.sampleRate),
    Math.floor(rangeLength({ start, end }) / 2),
  );
  if (ramp <= 0) return clonePcm(pcm);

  let out = fade(pcm, { start, end: start + ramp }, 'in', 'equalPower');
  out = fade(out, { start: end - ramp, end }, 'out', 'equalPower');
  return out;
}
