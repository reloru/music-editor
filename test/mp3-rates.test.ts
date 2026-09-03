import { describe, expect, it } from 'vitest';
import { MP3_SAMPLE_RATES, isMp3SampleRate, nearestMp3SampleRate } from '../src/audio/mp3-rates';

describe('MP3 sample rates', () => {
  it('lists exactly the MPEG-1 and MPEG-2 layer III rates', () => {
    // MPEG-1 audio: 32/44.1/48 kHz. MPEG-2: 16/22.05/24 kHz.
    // MPEG-2.5 (LAME extension): 8/11.025/12 kHz.
    expect(MP3_SAMPLE_RATES).toEqual([8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000]);
  });

  it('accepts every listed rate', () => {
    for (const rate of MP3_SAMPLE_RATES) expect(isMp3SampleRate(rate)).toBe(true);
  });

  it('rejects rates the bitstream cannot carry', () => {
    for (const rate of [0, 8001, 44000, 44101, 96000, 192000]) {
      expect(isMp3SampleRate(rate)).toBe(false);
    }
  });

  it('snaps an unsupported rate to the closest supported one', () => {
    expect(nearestMp3SampleRate(96000)).toBe(48000);
    expect(nearestMp3SampleRate(44000)).toBe(44100);
    expect(nearestMp3SampleRate(4000)).toBe(8000);
    expect(nearestMp3SampleRate(28000)).toBe(24000);
  });

  it('leaves a supported rate untouched', () => {
    for (const rate of MP3_SAMPLE_RATES) expect(nearestMp3SampleRate(rate)).toBe(rate);
  });

  it('never returns a rate it would then reject', () => {
    for (let rate = 1000; rate <= 200000; rate += 997) {
      expect(isMp3SampleRate(nearestMp3SampleRate(rate))).toBe(true);
    }
  });
});
