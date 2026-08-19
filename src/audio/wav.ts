/**
 * RIFF/WAVE reading and writing.
 *
 * Writing is the export path. Reading exists because Safari's
 * `decodeAudioData` rejects a few perfectly valid WAV variants (notably 24-bit
 * and WAVE_FORMAT_EXTENSIBLE files, which is exactly what a lot of field
 * recorders and DAWs produce), so `decode.ts` falls back to this parser.
 */
import { type Pcm, createPcm, frameCount } from './pcm';

export type WavBitDepth = 16 | 24 | 32;

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

/**
 * Encodes to a WAV file. `bitDepth` 16 and 24 write integer PCM; 32 writes
 * IEEE float, which is lossless for our internal representation.
 */
export function encodeWav(pcm: Pcm, bitDepth: WavBitDepth = 16): ArrayBuffer {
  const channels = pcm.channels.length;
  const frames = frameCount(pcm);
  const bytesPerSample = bitDepth / 8;
  const blockAlign = channels * bytesPerSample;
  const dataBytes = frames * blockAlign;
  const isFloat = bitDepth === 32;

  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, isFloat ? FORMAT_FLOAT : FORMAT_PCM, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, pcm.sampleRate, true);
  view.setUint32(28, pcm.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let frame = 0; frame < frames; frame++) {
    for (let c = 0; c < channels; c++) {
      const sample = clamp(pcm.channels[c][frame]);
      switch (bitDepth) {
        case 16:
          view.setInt16(offset, Math.round(sample * 32767), true);
          break;
        case 24: {
          const value = Math.round(sample * 8388607);
          view.setUint8(offset, value & 0xff);
          view.setUint8(offset + 1, (value >> 8) & 0xff);
          view.setUint8(offset + 2, (value >> 16) & 0xff);
          break;
        }
        case 32:
          view.setFloat32(offset, sample, true);
          break;
      }
      offset += bytesPerSample;
    }
  }
  return buffer;
}

/** True when `bytes` starts with a RIFF/WAVE header. */
export function isWav(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 12 &&
    readAscii(bytes, 0, 4) === 'RIFF' &&
    readAscii(bytes, 8, 4) === 'WAVE'
  );
}

/**
 * Parses a WAV file. Handles 8/16/24/32-bit integer PCM and 32/64-bit float,
 * including WAVE_FORMAT_EXTENSIBLE. Throws on anything it cannot represent
 * (compressed payloads such as ADPCM).
 */
export function decodeWav(input: ArrayBuffer | Uint8Array): Pcm {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (!isWav(bytes)) throw new Error('Not a RIFF/WAVE file');

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let cursor = 12;
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitDepth = 0;
  let dataOffset = -1;
  let dataLength = 0;

  while (cursor + 8 <= bytes.length) {
    const chunkId = readAscii(bytes, cursor, 4);
    const chunkSize = view.getUint32(cursor + 4, true);
    const body = cursor + 8;

    if (chunkId === 'fmt ') {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitDepth = view.getUint16(body + 14, true);
      if (format === FORMAT_EXTENSIBLE && chunkSize >= 40) {
        // The real format lives in the first two bytes of the GUID sub-format.
        format = view.getUint16(body + 24, true);
      }
    } else if (chunkId === 'data') {
      dataOffset = body;
      // Some encoders write 0xFFFFFFFF for streamed files; fall back to what is
      // actually present rather than trusting the header.
      dataLength = Math.min(chunkSize, bytes.length - body);
    }

    // Chunks are word-aligned: an odd size is followed by a pad byte.
    cursor = body + chunkSize + (chunkSize % 2);
  }

  if (dataOffset < 0 || channels === 0 || sampleRate === 0) {
    throw new Error('WAV file is missing a fmt or data chunk');
  }
  if (format !== FORMAT_PCM && format !== FORMAT_FLOAT) {
    throw new Error(`Unsupported WAV encoding (format ${format})`);
  }

  const bytesPerSample = bitDepth / 8;
  const blockAlign = bytesPerSample * channels;
  const frames = Math.floor(dataLength / blockAlign);
  const pcm = createPcm(channels, frames, sampleRate);

  for (let frame = 0; frame < frames; frame++) {
    const frameStart = dataOffset + frame * blockAlign;
    for (let c = 0; c < channels; c++) {
      const at = frameStart + c * bytesPerSample;
      pcm.channels[c][frame] = readSample(view, at, bitDepth, format);
    }
  }
  return pcm;
}

function readSample(view: DataView, at: number, bitDepth: number, format: number): number {
  if (format === FORMAT_FLOAT) {
    if (bitDepth === 64) return view.getFloat64(at, true);
    return view.getFloat32(at, true);
  }
  switch (bitDepth) {
    case 8:
      // 8-bit WAV is unsigned, centred on 128.
      return (view.getUint8(at) - 128) / 128;
    case 16:
      return view.getInt16(at, true) / 32768;
    case 24: {
      const value = view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getInt8(at + 2) << 16);
      return value / 8388608;
    }
    case 32:
      return view.getInt32(at, true) / 2147483648;
    default:
      throw new Error(`Unsupported WAV bit depth: ${bitDepth}`);
  }
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i]);
  return out;
}

function clamp(value: number): number {
  if (value > 1) return 1;
  if (value < -1) return -1;
  return value;
}
