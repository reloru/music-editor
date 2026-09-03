import { describe, expect, it } from 'vitest';
import { toInt16, writeInt16 } from '../src/audio/int16';

describe('int16 conversion', () => {
  it('maps the full-scale ends onto the full integer range', () => {
    const out = toInt16(new Float32Array([-1, 0, 1]));
    expect(Array.from(out)).toEqual([-32768, 0, 32767]);
  });

  it('never wraps a full-scale negative peak to positive', () => {
    // Scaling both ends by 32768 would give +32768 here, which does not fit in
    // an Int16Array and lands as -32768 — an inverted sample, heard as a click.
    const out = toInt16(new Float32Array([-1, -0.999999]));
    for (const sample of out) expect(sample).toBeLessThan(0);
  });

  it('clamps samples outside the float range instead of wrapping', () => {
    const out = toInt16(new Float32Array([2, -2, 1.0001, -1.0001]));
    expect(Array.from(out)).toEqual([32767, -32768, 32767, -32768]);
  });

  it('leaves the sign of every sample alone', () => {
    const source = new Float32Array(2048);
    for (let i = 0; i < source.length; i++) source[i] = Math.sin(i / 12) * 0.97;
    const out = toInt16(source);
    for (let i = 0; i < source.length; i++) {
      expect(Math.sign(out[i])).toBe(source[i] === 0 ? 0 : Math.sign(source[i]));
    }
  });

  it('quantises within one step of the ideal value', () => {
    const source = new Float32Array(512);
    for (let i = 0; i < source.length; i++) source[i] = i / (source.length - 1) * 2 - 1;
    const out = toInt16(source);
    for (let i = 0; i < source.length; i++) {
      const ideal = source[i] * (source[i] < 0 ? 32768 : 32767);
      expect(Math.abs(out[i] - ideal)).toBeLessThanOrEqual(1);
    }
  });

  it('writes a window into an existing target', () => {
    const source = new Float32Array([0, 1, -1, 0.5]);
    const target = new Int16Array(2);
    writeInt16(source, 1, 2, target);
    expect(Array.from(target)).toEqual([32767, -32768]);
  });

  it('agrees with the windowed form used by the worker', () => {
    const source = new Float32Array(300);
    for (let i = 0; i < source.length; i++) source[i] = Math.cos(i / 7) * 0.8;

    const whole = toInt16(source);
    const chunked = new Int16Array(source.length);
    const scratch = new Int16Array(64);
    for (let offset = 0; offset < source.length; offset += scratch.length) {
      const length = Math.min(scratch.length, source.length - offset);
      const window = length === scratch.length ? scratch : scratch.subarray(0, length);
      writeInt16(source, offset, length, window);
      chunked.set(window, offset);
    }

    expect(Array.from(chunked)).toEqual(Array.from(whole));
  });
});
