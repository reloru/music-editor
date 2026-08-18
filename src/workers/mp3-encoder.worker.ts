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
import type { Pcm } from '../audio/pcm';

export interface Mp3EncodeRequest {
  channels: Float32Array[];
  sampleRate: number;
  bitrate: number;
}

export type Mp3EncodeResponse =
  | { type: 'progress'; value: number }
  | { type: 'done'; data: Uint8Array; sampleRate: number; channels: number }
  | { type: 'error'; message: string };

/** Sample rates the MPEG-1/2 layer III bitstream can carry. */
const SUPPORTED_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

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
  let pcm: Pcm = { sampleRate: request.sampleRate, channels: request.channels };

  // LAME only accepts mono or stereo, at one of the MPEG sample rates.
  if (pcm.channels.length > 2) pcm = setChannelCount(pcm, 2);
  if (pcm.channels.length === 0) throw new Error('Nothing to encode');
  if (!SUPPORTED_RATES.includes(pcm.sampleRate)) {
    pcm = resample(pcm, nearestSupportedRate(pcm.sampleRate));
  }

  const channelCount = pcm.channels.length;
  const frames = pcm.channels[0].length;
  const encoder = new Mp3Encoder(channelCount, pcm.sampleRate, request.bitrate);
  const parts: Uint8Array[] = [];

  const left = new Int16Array(Math.min(SAMPLES_PER_CHUNK, frames));
  const right = channelCount > 1 ? new Int16Array(left.length) : undefined;

  for (let offset = 0; offset < frames; offset += SAMPLES_PER_CHUNK) {
    const length = Math.min(SAMPLES_PER_CHUNK, frames - offset);
    const leftChunk = length === left.length ? left : left.subarray(0, length);
    toInt16(pcm.channels[0], offset, length, leftChunk);

    let rightChunk: Int16Array | undefined;
    if (right) {
      rightChunk = length === right.length ? right : right.subarray(0, length);
      toInt16(pcm.channels[1], offset, length, rightChunk);
    }

    const encoded = encoder.encodeBuffer(leftChunk, rightChunk);
    if (encoded.length > 0) parts.push(encoded.slice());

    const progress: Mp3EncodeResponse = {
      type: 'progress',
      value: Math.min(1, (offset + length) / frames),
    };
    scope.postMessage(progress);
  }

  const tail = encoder.flush();
  if (tail.length > 0) parts.push(tail.slice());

  return { data: concat(parts), sampleRate: pcm.sampleRate, channels: channelCount };
}

function toInt16(source: Float32Array, offset: number, length: number, target: Int16Array): void {
  for (let i = 0; i < length; i++) {
    const sample = source[offset + i];
    const clamped = sample > 1 ? 1 : sample < -1 ? -1 : sample;
    // Asymmetric scaling: -1 maps to -32768 and +1 to 32767 without wrapping.
    target[i] = clamped < 0 ? clamped * 32768 : clamped * 32767;
  }
}

function nearestSupportedRate(rate: number): number {
  return SUPPORTED_RATES.reduce((best, candidate) =>
    Math.abs(candidate - rate) < Math.abs(best - rate) ? candidate : best,
  );
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
