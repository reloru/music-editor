/**
 * Float samples to 16-bit integers.
 *
 * Both the export path on the main thread and the MP3 worker need this, and
 * they need it to agree: the main thread converts up front when no resampling
 * is required, and the worker converts chunk by chunk when it does. Two copies
 * of the scaling rule would be two chances for the quiet-vs-clipped behaviour to
 * diverge, so there is one.
 *
 * Scaling is asymmetric — -1 maps to -32768 and +1 to 32767 — because the
 * two's-complement range is asymmetric. Using 32768 for both ends makes a
 * full-scale negative peak overflow and wrap to a large positive value, which is
 * audible as a click. Values outside [-1, 1] are clamped, since float buffers
 * legitimately carry headroom the integer format has no room for.
 */

/** Converts `length` samples from `source[offset..]` into `target[0..length]`. */
export function writeInt16(source: Float32Array, offset: number, length: number, target: Int16Array): void {
  for (let i = 0; i < length; i++) {
    const sample = source[offset + i];
    const clamped = sample > 1 ? 1 : sample < -1 ? -1 : sample;
    target[i] = clamped < 0 ? clamped * 32768 : clamped * 32767;
  }
}

/** Converts a whole channel, allocating the result. */
export function toInt16(source: Float32Array): Int16Array {
  const target = new Int16Array(source.length);
  writeInt16(source, 0, source.length, target);
  return target;
}
