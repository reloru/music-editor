/// <reference lib="webworker" />
/**
 * MP3 encoding, off the main thread.
 *
 * LAME is pure JavaScript here, so encoding a few minutes of audio takes
 * seconds of solid CPU. Running it in a worker keeps the waveform responsive
 * and lets the UI show real progress instead of freezing the tab — which on
 * iOS is the difference between "working" and "Safari killed the page".
 */
import { Mp3Encoder } from '@breezystack/lamejs';
import { resample, setChannelCount } from '../audio/dsp';
import { isMp3SampleRate, nearestMp3SampleRate } from '../audio/mp3-rates';
import { writeInt16 } from '../audio/int16';
import type { Pcm } from '../audio/pcm';

/**
 * Exactly one channel set is populated.
 *
 * `int16Channels` is the cheap path: the caller has already checked that the
 * rate and channel count need no conversion, so the samples arrive in the form
 * LAME wants and cost half as much to hand over as floats do.
 */
export interface Mp3EncodeRequest {
  channels?: Float32Array[];
  int16Channels?: Int16Array[];
  sampleRate: number;
  bitrate: number;
}

export type Mp3EncodeResponse =
  | { type: 'progress'; value: number }
  | { type: 'done'; data: Uint8Array; sampleRate: number; channels: number }
  | { type: 'error'; message: string };

/** One MPEG frame is 1152 samples; batching frames keeps call overhead down. */
const SAMPLES_PER_CHUNK = 1152 * 16;

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = (event: MessageEvent<Mp3EncodeRequest>) => {
  try {
    const result = encode(event.data);
    const message: Mp3EncodeResponse = {
      type: 'done',
      data: result.data,
      sampleRate: result.sampleRate,
      channels: result.channels,
    };
    scope.postMessage(message, [result.data.buffer as ArrayBuffer]);
  } catch (error) {
    const message: Mp3EncodeResponse = {
      type: 'error',
      message: error instanceof Error ? error.message : 'MP3 encoding failed',
    };
    scope.postMessage(message);
  }
};

function encode(request: Mp3EncodeRequest): { data: Uint8Array; sampleRate: number; channels: number } {
  const ready = request.int16Channels;
  if (ready) {
    if (ready.length === 0) throw new Error('Nothing to encode');
    // No conversion buffers at all on this path: LAME reads windows straight out
    // of the transferred arrays.
    return run(
      request.sampleRate,
      request.bitrate,
      ready.length,
      ready[0].length,
      (offset, length) => ready[0].subarray(offset, offset + length),
      ready.length > 1 ? (offset, length) => ready[1].subarray(offset, offset + length) : undefined,
    );
  }

  let pcm: Pcm = { sampleRate: request.sampleRate, channels: request.channels ?? [] };

  // LAME only accepts mono or stereo, at one of the MPEG sample rates.
  if (pcm.channels.length > 2) pcm = setChannelCount(pcm, 2);
  if (pcm.channels.length === 0) throw new Error('Nothing to encode');
  if (!isMp3SampleRate(pcm.sampleRate)) {
    pcm = resample(pcm, nearestMp3SampleRate(pcm.sampleRate));
  }

  const channelCount = pcm.channels.length;
  const frames = pcm.channels[0].length;

  // One reusable conversion buffer per channel rather than one per chunk.
  const left = new Int16Array(Math.min(SAMPLES_PER_CHUNK, frames));
  const right = channelCount > 1 ? new Int16Array(left.length) : undefined;

  return run(
    pcm.sampleRate,
    request.bitrate,
    channelCount,
    frames,
    (offset, length) => {
      const chunk = length === left.length ? left : left.subarray(0, length);
      writeInt16(pcm.channels[0], offset, length, chunk);
      return chunk;
    },
    right
      ? (offset, length) => {
          const chunk = length === right.length ? right : right.subarray(0, length);
          writeInt16(pcm.channels[1], offset, length, chunk);
          return chunk;
        }
      : undefined,
  );
}

/**
 * Drives the encoder over `frames` samples, pulling each chunk through the
 * supplied readers. Both request shapes share this loop so the progress
 * reporting and the bitstream assembly cannot drift apart.
 */
function run(
  sampleRate: number,
  bitrate: number,
  channelCount: number,
  frames: number,
  readLeft: (offset: number, length: number) => Int16Array,
  readRight?: (offset: number, length: number) => Int16Array,
): { data: Uint8Array; sampleRate: number; channels: number } {
  const encoder = new Mp3Encoder(channelCount, sampleRate, bitrate);
  const parts: Uint8Array[] = [];

  for (let offset = 0; offset < frames; offset += SAMPLES_PER_CHUNK) {
    const length = Math.min(SAMPLES_PER_CHUNK, frames - offset);
    const encoded = encoder.encodeBuffer(readLeft(offset, length), readRight?.(offset, length));
    if (encoded.length > 0) parts.push(encoded.slice());

    const progress: Mp3EncodeResponse = {
      type: 'progress',
      value: Math.min(1, (offset + length) / frames),
    };
    scope.postMessage(progress);
  }

  const tail = encoder.flush();
  if (tail.length > 0) parts.push(tail.slice());

  return { data: concat(parts), sampleRate, channels: channelCount };
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
