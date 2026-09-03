import { describe, expect, it } from 'vitest';
import { formatDuration, parseTimecode } from '../src/editor';

describe('parseTimecode', () => {
  it('reads bare seconds, which is all the iOS decimal keypad can type', () => {
    expect(parseTimecode('0')).toBe(0);
    expect(parseTimecode('83')).toBe(83);
    expect(parseTimecode('83.45')).toBeCloseTo(83.45, 6);
    expect(parseTimecode('.5')).toBeCloseTo(0.5, 6);
    expect(parseTimecode('12.')).toBe(12);
  });

  it('reads minutes and seconds', () => {
    expect(parseTimecode('1:23')).toBe(83);
    expect(parseTimecode('1:23.45')).toBeCloseTo(83.45, 6);
    expect(parseTimecode('0:00.00')).toBe(0);
    expect(parseTimecode('10:00')).toBe(600);
  });

  it('reads hours when there are two colons', () => {
    expect(parseTimecode('1:02:03')).toBe(3723);
    expect(parseTimecode('1:02:03.5')).toBeCloseTo(3723.5, 6);
    expect(parseTimecode('0:01:00')).toBe(60);
  });

  it('takes a comma as the decimal separator', () => {
    // Which is what the iOS keypad emits under a locale that uses one.
    expect(parseTimecode('83,45')).toBeCloseTo(83.45, 6);
    expect(parseTimecode('1:23,45')).toBeCloseTo(83.45, 6);
  });

  it('does not bound minutes or seconds at 60', () => {
    // So "thirty seconds later" is a thing you can type without carrying.
    expect(parseTimecode('1:90')).toBe(150);
    expect(parseTimecode('90:00')).toBe(5400);
  });

  it('ignores surrounding whitespace', () => {
    expect(parseTimecode('  1:23  ')).toBe(83);
  });

  it('returns null for anything it cannot read', () => {
    for (const input of [
      '',
      '   ',
      '—',
      'half past four',
      '1:2:3:4',
      '1::2',
      ':30',
      '-5',
      '1e3',
      '3s',
      'NaN',
      'Infinity',
      '1.2.3',
    ]) {
      expect(parseTimecode(input), `expected ${JSON.stringify(input)} to be rejected`).toBeNull();
    }
  });

  it('round-trips whatever formatDuration produces', () => {
    for (const seconds of [0, 0.01, 1.5, 59.99, 83.45, 600, 3723.5]) {
      const parsed = parseTimecode(formatDuration(seconds));
      expect(parsed).not.toBeNull();
      // formatDuration truncates to hundredths, so the round trip is exact only
      // to that resolution.
      expect(parsed as number).toBeCloseTo(Math.floor(seconds * 100) / 100, 6);
    }
  });
});
