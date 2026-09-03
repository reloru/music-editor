/**
 * Rendering the edited buffer to a file the user can keep.
 */
import type { Pcm } from './pcm';
import { encodeWav, type WavBitDepth } from './wav';
import { isMp3SampleRate } from './mp3-rates';
import { toInt16 } from './int16';
import type { Mp3EncodeRequest, Mp3EncodeResponse } from '../workers/mp3-encoder.worker';

export type ExportFormat = 'wav' | 'mp3';

export interface ExportOptions {
  format: ExportFormat;
  /** WAV only. 16-bit is the compatible default; 32 writes lossless float. */
  bitDepth?: WavBitDepth;
  /** MP3 only, in kbps. */
  bitrate?: number;
  onProgress?: (value: number) => void;
  signal?: AbortSignal;
}

export interface ExportResult {
  blob: Blob;
  extension: string;
  mimeType: string;
}

export async function exportAudio(pcm: Pcm, options: ExportOptions): Promise<ExportResult> {
  if (options.format === 'wav') {
    options.onProgress?.(0);
    const buffer = encodeWav(pcm, options.bitDepth ?? 16);
    options.onProgress?.(1);
    return { blob: new Blob([buffer], { type: 'audio/wav' }), extension: 'wav', mimeType: 'audio/wav' };
  }

  const data = await encodeMp3(pcm, options.bitrate ?? 192, options.onProgress, options.signal);
  return {
    blob: new Blob([data as BlobPart], { type: 'audio/mpeg' }),
    extension: 'mp3',
    mimeType: 'audio/mpeg',
  };
}

function encodeMp3(
  pcm: Pcm,
  bitrate: number,
  onProgress?: (value: number) => void,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/mp3-encoder.worker.ts', import.meta.url), {
      type: 'module',
    });

    const cleanup = () => {
      worker.terminate();
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException('Export cancelled', 'AbortError'));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort);

    worker.onmessage = (event: MessageEvent<Mp3EncodeResponse>) => {
      const message = event.data;
      if (message.type === 'progress') {
        onProgress?.(message.value);
      } else if (message.type === 'done') {
        cleanup();
        resolve(message.data);
      } else {
        cleanup();
        reject(new Error(message.message));
      }
    };
    worker.onerror = (event) => {
      cleanup();
      reject(new Error(event.message || 'MP3 encoder failed to start'));
    };

    // The channel arrays are transferred, so the originals — which are still the
    // live document — have to be copied first. That copy is the single largest
    // allocation an export makes: for a three-minute stereo 48 kHz track it is
    // another 69 MB on top of the document, the engine's AudioBuffer and the
    // undo stack, and it is where exports on a phone ran out of memory.
    //
    // LAME quantises to 16-bit integers internally regardless, so when no
    // resampling or downmix is needed the conversion can happen here instead and
    // the copy is halved. Anything the encoder still has to resample or downmix
    // goes over as float, where the extra precision is worth the bytes.
    const direct = isMp3SampleRate(pcm.sampleRate) && pcm.channels.length > 0 && pcm.channels.length <= 2;

    if (direct) {
      const channels = pcm.channels.map(toInt16);
      const request: Mp3EncodeRequest = { int16Channels: channels, sampleRate: pcm.sampleRate, bitrate };
      worker.postMessage(
        request,
        channels.map((channel) => channel.buffer as ArrayBuffer),
      );
      return;
    }

    const channels = pcm.channels.map((channel) => Float32Array.from(channel));
    const request: Mp3EncodeRequest = { channels, sampleRate: pcm.sampleRate, bitrate };
    worker.postMessage(
      request,
      channels.map((channel) => channel.buffer as ArrayBuffer),
    );
  });
}
