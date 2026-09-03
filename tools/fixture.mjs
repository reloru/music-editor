/**
 * Test audio for the browser harnesses, generated rather than committed.
 *
 * A 12-second 44.1 kHz stereo WAV is about 2 MB, which is not worth carrying in
 * git when it is fully described by a dozen lines of arithmetic. The signal is
 * deliberately not a plain sine: the amplitude envelope and the differing
 * channel frequencies give the waveform view something with visible structure,
 * so a peak-drawing regression is apparent in a screenshot.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const SAMPLE_RATE = 44_100;
const CHANNELS = 2;
const SECONDS = 12;
const BITS = 16;

/** Little-endian 16-bit PCM WAV, written by hand — no encoder dependency. */
function buildWav() {
  const frames = SAMPLE_RATE * SECONDS;
  const blockAlign = (CHANNELS * BITS) / 8;
  const dataBytes = frames * blockAlign;
  const buffer = Buffer.alloc(44 + dataBytes);

  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16); // PCM fmt chunk length
  buffer.writeUInt16LE(1, 20); // format 1 = PCM
  buffer.writeUInt16LE(CHANNELS, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * blockAlign, 28); // byte rate
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(BITS, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);

  for (let i = 0; i < frames; i += 1) {
    const t = i / SAMPLE_RATE;
    // Four bursts across the file, each swelling and fading, so the drawn peaks
    // vary along the timeline instead of forming a flat band.
    const envelope = 0.15 + 0.75 * Math.abs(Math.sin((Math.PI * t) / 3));
    const left = Math.sin(2 * Math.PI * 220 * t) * envelope;
    const right = Math.sin(2 * Math.PI * 277.18 * t) * envelope * 0.8;
    const offset = 44 + i * blockAlign;
    // Asymmetric scaling: 16-bit PCM runs -32768..32767.
    buffer.writeInt16LE(Math.round(left < 0 ? left * 32768 : left * 32767), offset);
    buffer.writeInt16LE(Math.round(right < 0 ? right * 32768 : right * 32767), offset + 2);
  }

  return buffer;
}

/** Returns the fixture path, writing the file first if it is not there yet. */
export function ensureFixture(path) {
  path ||= new URL('../test/fixtures/tone.wav', import.meta.url).pathname;
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, buildWav());
  }
  return path;
}
