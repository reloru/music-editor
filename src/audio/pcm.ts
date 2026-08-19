/**
 * The editor's in-memory audio representation.
 *
 * Deliberately plain data rather than a Web Audio `AudioBuffer`: every editing
 * operation in `dsp.ts` is a pure function over this shape, which keeps them
 * unit-testable in Node and independent of the browser's audio graph.
 */
export interface Pcm {
  sampleRate: number;
  /** One Float32Array of samples per channel; all channels are the same length. */
  channels: Float32Array[];
}

/** A half-open sample range `[start, end)`. */
export interface Range {
  start: number;
  end: number;
}

export function createPcm(channelCount: number, length: number, sampleRate: number): Pcm {
  const channels: Float32Array[] = [];
  for (let c = 0; c < channelCount; c++) channels.push(new Float32Array(length));
  return { sampleRate, channels };
}

export function frameCount(pcm: Pcm): number {
  return pcm.channels[0]?.length ?? 0;
}

export function channelCount(pcm: Pcm): number {
  return pcm.channels.length;
}

export function duration(pcm: Pcm): number {
  return frameCount(pcm) / pcm.sampleRate;
}

/** Approximate heap cost of a buffer, used to bound the undo history. */
export function byteSize(pcm: Pcm): number {
  return frameCount(pcm) * channelCount(pcm) * Float32Array.BYTES_PER_ELEMENT;
}

export function clonePcm(pcm: Pcm): Pcm {
  return {
    sampleRate: pcm.sampleRate,
    channels: pcm.channels.map((channel) => Float32Array.from(channel)),
  };
}

/** Clamps a range to the buffer and normalises inverted ranges. */
export function clampRange(pcm: Pcm, range: Range | null | undefined): Range {
  const total = frameCount(pcm);
  if (!range) return { start: 0, end: total };
  const start = Math.max(0, Math.min(total, Math.floor(Math.min(range.start, range.end))));
  const end = Math.max(start, Math.min(total, Math.ceil(Math.max(range.start, range.end))));
  return { start, end };
}

export function rangeLength(range: Range): number {
  return Math.max(0, range.end - range.start);
}

export function secondsToSamples(seconds: number, sampleRate: number): number {
  return Math.round(seconds * sampleRate);
}

export function samplesToSeconds(samples: number, sampleRate: number): number {
  return samples / sampleRate;
}

export function linearToDb(linear: number): number {
  return linear <= 0 ? -Infinity : 20 * Math.log10(linear);
}

export function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}
