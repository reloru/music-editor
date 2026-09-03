import { describe, expect, it } from 'vitest';
import { dragRange, edgeScrollPush, fingerDistance, pickAnchor } from '../src/ui/gesture-math';

describe('fingerDistance', () => {
  it('measures along both axes', () => {
    expect(fingerDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });

  it('reports a vertical pinch as a real separation', () => {
    // Measured along x alone this is 0, so a vertical pinch could not zoom and,
    // once floored, reported the fingers as touching.
    expect(fingerDistance({ x: 100, y: 40 }, { x: 100, y: 240 })).toBe(200);
  });

  it('keeps the scale factor of a diagonal pinch bounded', () => {
    // Two fingers 200 px apart, rotated through a quarter turn while their
    // separation is unchanged. The zoom factor is the ratio of separations, so
    // it must stay at 1 throughout; an x-only measure sweeps it from 1 to 200.
    const radius = 100;
    for (let degrees = 0; degrees <= 90; degrees += 5) {
      const radians = (degrees * Math.PI) / 180;
      const dx = Math.cos(radians) * radius;
      const dy = Math.sin(radians) * radius;
      const distance = fingerDistance({ x: 200 - dx, y: 200 - dy }, { x: 200 + dx, y: 200 + dy });
      expect(distance).toBeCloseTo(2 * radius, 6);
    }
  });

  it('is symmetric', () => {
    const a = { x: 12, y: -30 };
    const b = { x: 400, y: 88 };
    expect(fingerDistance(a, b)).toBe(fingerDistance(b, a));
  });

  it('never returns zero, so it is safe as a denominator', () => {
    const same = { x: 50, y: 50 };
    expect(fingerDistance(same, same)).toBe(1);
    expect(Number.isFinite(1 / fingerDistance(same, same))).toBe(true);
  });
});

describe('pickAnchor', () => {
  const grab = 22;

  it('anchors the far edge so the near one follows the finger', () => {
    expect(pickAnchor(100, 100, 400, grab)).toBe('right');
    expect(pickAnchor(400, 100, 400, grab)).toBe('left');
  });

  it('ignores a touch outside both grab zones', () => {
    expect(pickAnchor(250, 100, 400, grab)).toBeNull();
    expect(pickAnchor(60, 100, 400, grab)).toBeNull();
    expect(pickAnchor(500, 100, 400, grab)).toBeNull();
  });

  it('reaches a handle from either side of it', () => {
    expect(pickAnchor(100 - grab, 100, 400, grab)).toBe('right');
    expect(pickAnchor(100 + grab, 100, 400, grab)).toBe('right');
  });

  it('gives the nearer handle a narrow selection whose zones overlap', () => {
    // 20 px apart: both zones cover every point between them.
    expect(pickAnchor(202, 200, 220, grab)).toBe('right');
    expect(pickAnchor(218, 200, 220, grab)).toBe('left');
  });

  it('splits an exact tie by which half the touch is in', () => {
    // Equidistant from both edges, which is the midpoint itself. The tie-break
    // has to pick one; what matters is that it is deterministic and that the
    // two sides of the midpoint disagree.
    expect(pickAnchor(210, 200, 220, grab)).toBe('left');
    expect(pickAnchor(209.9, 200, 220, grab)).toBe('right');
  });

  it('handles a selection collapsed to a single pixel', () => {
    expect(pickAnchor(300, 300, 300, grab)).toBe('left');
    expect(pickAnchor(300 + grab + 1, 300, 300, grab)).toBeNull();
  });
});

describe('dragRange', () => {
  const total = 10000;

  it('orders the two positions', () => {
    expect(dragRange(500, 200, total)).toEqual({ start: 200, end: 500 });
    expect(dragRange(200, 500, total)).toEqual({ start: 200, end: 500 });
  });

  it('keeps a width of one sample when the edges meet', () => {
    expect(dragRange(500, 500, total)).toEqual({ start: 500, end: 501 });
  });

  it('never produces a range the editor would discard', () => {
    for (const moving of [0, 1, 499, 500, 501, 9999, 10000]) {
      const range = dragRange(500, moving, total);
      expect(range.end).toBeGreaterThan(range.start);
    }
  });

  it('stays inside the buffer when the drag ends at the very last sample', () => {
    const range = dragRange(total, total, total);
    expect(range.start).toBe(total - 1);
    expect(range.end).toBe(total);
  });

  it('survives an empty buffer without producing negative offsets', () => {
    const range = dragRange(0, 0, 0);
    expect(range.start).toBe(0);
    expect(range.end).toBe(1);
  });

  it('holds width through a shrinking drag, so the handle stays grabbable', () => {
    // The finger walks onto the anchor and back out. Every intermediate range
    // has to be non-empty, or the selection is destroyed part-way and the
    // remaining moves have nothing to resize.
    const widths: number[] = [];
    for (const moving of [900, 700, 500, 300, 100, 0, 100, 300, 500]) {
      const range = dragRange(500, moving, total);
      widths.push(range.end - range.start);
    }
    for (const width of widths) expect(width).toBeGreaterThanOrEqual(1);
    expect(widths[5]).toBe(500);
  });
});

describe('edgeScrollPush', () => {
  const width = 400;
  const zone = 36;

  it('is neutral across the middle', () => {
    for (const x of [100, 200, 300]) expect(edgeScrollPush(x, width, zone)).toBe(0);
  });

  it('pushes left at the left edge and right at the right', () => {
    expect(edgeScrollPush(0, width, zone)).toBe(-1);
    expect(edgeScrollPush(width, width, zone)).toBe(1);
  });

  it('ramps rather than steps', () => {
    const half = edgeScrollPush(zone / 2, width, zone);
    expect(half).toBeCloseTo(-0.5, 6);
    expect(Math.abs(half)).toBeLessThan(Math.abs(edgeScrollPush(0, width, zone)));
  });

  it('is continuous at the zone boundary', () => {
    expect(edgeScrollPush(zone, width, zone)).toBe(0);
    expect(edgeScrollPush(zone - 0.001, width, zone)).toBeGreaterThan(-0.001);
  });

  it('clamps when the finger leaves the element', () => {
    expect(edgeScrollPush(-500, width, zone)).toBe(-1);
    expect(edgeScrollPush(width + 500, width, zone)).toBe(1);
  });

  it('leaves a neutral middle even when the element is narrower than two zones', () => {
    const narrow = 40;
    expect(edgeScrollPush(narrow / 2, narrow, zone)).toBe(0);
    expect(edgeScrollPush(0, narrow, zone)).toBe(-1);
    expect(edgeScrollPush(narrow, narrow, zone)).toBe(1);
  });

  it('is antisymmetric about the centre', () => {
    for (const offset of [0, 5, 18, 36, 100]) {
      expect(edgeScrollPush(width - offset, width, zone)).toBeCloseTo(-edgeScrollPush(offset, width, zone), 9);
    }
  });

  it('returns nothing to do for a degenerate element', () => {
    expect(edgeScrollPush(10, 0, zone)).toBe(0);
    expect(edgeScrollPush(10, width, 0)).toBe(0);
    expect(edgeScrollPush(10, Number.NaN, zone)).toBe(0);
  });
});
