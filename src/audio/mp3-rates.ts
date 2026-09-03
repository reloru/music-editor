/**
 * Sample rates the MPEG-1/2 layer III bitstream can carry.
 *
 * Lives in its own module so the main thread can decide whether the encoder
 * will need to resample — and therefore whether it can hand over cheap 16-bit
 * integers instead of floats — without importing the worker, which would pull
 * the whole LAME bundle into the main chunk.
 */
export const MP3_SAMPLE_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

export function isMp3SampleRate(rate: number): boolean {
  return MP3_SAMPLE_RATES.includes(rate);
}

export function nearestMp3SampleRate(rate: number): number {
  return MP3_SAMPLE_RATES.reduce((best, candidate) =>
    Math.abs(candidate - rate) < Math.abs(best - rate) ? candidate : best,
  );
}
