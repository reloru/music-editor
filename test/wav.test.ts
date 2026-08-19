import { describe, expect, it } from 'vitest';
import { decodeWav, encodeWav, isWav } from '../src/audio/wav';
import { createPcm, frameCount, type Pcm } from '../src/audio/pcm';

function tone(frames: number, channels = 1, sampleRate = 8000): Pcm {
  const pcm = createPcm(channels, frames, sampleRate);
  for (let c = 0; c < channels; c++) {
    for (let i = 0; i < frames; i++) {
      pcm.channels[c][i] = Math.sin((2 * Math.PI * 220 * i) / sampleRate) * (c === 0 ? 0.9 : 0.4);
    }
  }
  return pcm;
}

describe('encodeWav', () => {
  it('writes a RIFF/WAVE header', () => {
    const bytes = new Uint8Array(encodeWav(tone(16), 16));
    expect(isWav(bytes)).toBe(true);
  });

  it('sizes the file from the frame count and bit depth', () => {
    const buffer = encodeWav(tone(100, 2), 24);
    expect(buffer.byteLength).toBe(44 + 100 * 2 * 3);
  });

  it('clamps samples above full scale instead of wrapping them', () => {
    const loud: Pcm = { sampleRate: 8000, channels: [Float32Array.from([2, -2])] };
    const decoded = decodeWav(encodeWav(loud, 16));
    expect(decoded.channels[0][0]).toBeCloseTo(1, 3);
    expect(decoded.channels[0][1]).toBeCloseTo(-1, 3);
  });
});

describe('round trips', () => {
  it.each([
    [16, 1e-4],
    [24, 1e-6],
    [32, 1e-7],
  ] as const)('survives a %i-bit round trip', (depth, tolerance) => {
    const source = tone(512, 2);
    const decoded = decodeWav(encodeWav(source, depth));

    expect(decoded.sampleRate).toBe(source.sampleRate);
    expect(decoded.channels).toHaveLength(2);
    expect(frameCount(decoded)).toBe(512);

    for (let c = 0; c < 2; c++) {
      for (let i = 0; i < 512; i++) {
        expect(decoded.channels[c][i]).toBeCloseTo(source.channels[c][i], -Math.log10(tolerance));
      }
    }
  });

  it('keeps channels separate rather than interleaved', () => {
    const source: Pcm = {
      sampleRate: 8000,
      channels: [Float32Array.from([1, 1, 1]), Float32Array.from([-1, -1, -1])],
    };
    const decoded = decodeWav(encodeWav(source, 24));
    // Full scale positive is one step short of 1.0 in integer PCM.
    for (const sample of decoded.channels[0]) expect(sample).toBeCloseTo(1, 6);
    for (const sample of decoded.channels[1]) expect(sample).toBeCloseTo(-1, 6);
  });
});

describe('decodeWav', () => {
  it('rejects data that is not a WAV', () => {
    expect(() => decodeWav(new Uint8Array([1, 2, 3, 4]))).toThrow(/RIFF/);
  });

  it('skips unknown chunks such as LIST', () => {
    const original = new Uint8Array(encodeWav(tone(8), 16));
    const list = buildChunk('LIST', new Uint8Array([73, 78, 70, 79]));

    // Splice the extra chunk between `fmt ` and `data`, and fix the RIFF size.
    const withList = new Uint8Array(original.length + list.length);
    withList.set(original.subarray(0, 36), 0);
    withList.set(list, 36);
    withList.set(original.subarray(36), 36 + list.length);
    new DataView(withList.buffer).setUint32(4, withList.length - 8, true);

    const decoded = decodeWav(withList);
    expect(frameCount(decoded)).toBe(8);
  });

  it('handles an odd-sized chunk followed by its pad byte', () => {
    const original = new Uint8Array(encodeWav(tone(8), 16));
    // A 3-byte body is padded to 4 bytes on disk.
    const odd = buildChunk('note', new Uint8Array([1, 2, 3]));

    const withOdd = new Uint8Array(original.length + odd.length);
    withOdd.set(original.subarray(0, 36), 0);
    withOdd.set(odd, 36);
    withOdd.set(original.subarray(36), 36 + odd.length);
    new DataView(withOdd.buffer).setUint32(4, withOdd.length - 8, true);

    expect(frameCount(decodeWav(withOdd))).toBe(8);
  });

  it('reads WAVE_FORMAT_EXTENSIBLE files, which Safari can refuse', () => {
    const extensible = buildExtensibleWav([0.5, -0.5, 0.25]);
    const decoded = decodeWav(extensible);
    expect(decoded.sampleRate).toBe(8000);
    expect(decoded.channels[0][0]).toBeCloseTo(0.5, 4);
    expect(decoded.channels[0][1]).toBeCloseTo(-0.5, 4);
  });

  it('reads unsigned 8-bit PCM centred on 128', () => {
    const bytes = buildPcmWav(8, [0, 128, 255]);
    const decoded = decodeWav(bytes);
    expect(decoded.channels[0][0]).toBeCloseTo(-1, 5);
    expect(decoded.channels[0][1]).toBeCloseTo(0, 5);
  });

  it('refuses a compressed payload it cannot represent', () => {
    const bytes = buildPcmWav(16, [0]);
    // Format 17 is IMA ADPCM.
    new DataView(bytes.buffer).setUint16(20, 17, true);
    expect(() => decodeWav(bytes)).toThrow(/Unsupported WAV encoding/);
  });

  it('tolerates a data chunk that claims to be longer than the file', () => {
    const bytes = new Uint8Array(encodeWav(tone(8), 16));
    new DataView(bytes.buffer).setUint32(40, 0xffffffff, true);
    expect(frameCount(decodeWav(bytes))).toBe(8);
  });
});

function buildChunk(id: string, body: Uint8Array): Uint8Array {
  const padded = body.length % 2 === 1 ? body.length + 1 : body.length;
  const out = new Uint8Array(8 + padded);
  const view = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) out[i] = id.charCodeAt(i);
  view.setUint32(4, body.length, true);
  out.set(body, 8);
  return out;
}

/** Minimal mono 16-bit PCM file with the given raw samples. */
function buildPcmWav(bitDepth: 8 | 16, samples: number[]): Uint8Array {
  const bytesPerSample = bitDepth / 8;
  const out = new Uint8Array(44 + samples.length * bytesPerSample);
  const view = new DataView(out.buffer);
  writeAscii(out, 0, 'RIFF');
  view.setUint32(4, out.length - 8, true);
  writeAscii(out, 8, 'WAVE');
  writeAscii(out, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 8000 * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, bitDepth, true);
  writeAscii(out, 36, 'data');
  view.setUint32(40, samples.length * bytesPerSample, true);
  samples.forEach((sample, index) => {
    if (bitDepth === 8) view.setUint8(44 + index, sample);
    else view.setInt16(44 + index * 2, sample, true);
  });
  return out;
}

/** 16-bit mono file declared as WAVE_FORMAT_EXTENSIBLE (a 40-byte fmt chunk). */
function buildExtensibleWav(samples: number[]): Uint8Array {
  const dataBytes = samples.length * 2;
  const out = new Uint8Array(12 + 8 + 40 + 8 + dataBytes);
  const view = new DataView(out.buffer);

  writeAscii(out, 0, 'RIFF');
  view.setUint32(4, out.length - 8, true);
  writeAscii(out, 8, 'WAVE');

  writeAscii(out, 12, 'fmt ');
  view.setUint32(16, 40, true);
  view.setUint16(20, 0xfffe, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 16000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint16(36, 22, true); // cbSize
  view.setUint16(38, 16, true); // valid bits
  view.setUint32(40, 4, true); // channel mask
  view.setUint16(44, 1, true); // sub-format: PCM

  writeAscii(out, 60, 'data');
  view.setUint32(64, dataBytes, true);
  samples.forEach((sample, index) => {
    view.setInt16(68 + index * 2, Math.round(sample * 32767), true);
  });
  return out;
}

function writeAscii(bytes: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
}
