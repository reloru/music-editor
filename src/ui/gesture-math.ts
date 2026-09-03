/**
 * The arithmetic behind the canvas gestures, separated from the canvas.
 *
 * Each function here corresponds to something that went wrong on a touch
 * screen and could not be reproduced without one. Pulled out so they can be
 * checked directly rather than by aiming fingers at a phone.
 */

/**
 * Separation between two fingers.
 *
 * Euclidean, and floored at 1. This was measured along x alone, which is wrong
 * in two ways: a vertical pinch reports no change in separation, so it cannot
 * zoom at all, and a near-vertical one reports a separation approaching zero,
 * so the scale factor it feeds approaches infinity. Both fingers moving
 * diagonally — the ordinary case — landed somewhere between the two. Flooring
 * at 1 keeps the reciprocal finite when two fingers land on the same pixel.
 */
export function fingerDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
}

/**
 * Which selection edge a drag from `x` should anchor against, given the two
 * edge positions and the grab radius, all in the same units.
 *
 * `'left'` means the left edge stays put and the right one follows the finger.
 * null means the touch is not on either handle.
 *
 * The two grab zones overlap whenever the selection is narrower than twice the
 * radius, which on a phone means anything under about a fifth of an inch. The
 * original test was `near(left) ? … : near(right) ? … : null`, so inside the
 * overlap the left handle always won and dragging the right edge of a narrow
 * selection moved the wrong side. Nearest wins instead, and an exact tie is
 * resolved by which half of the selection the touch fell in.
 */
export function pickAnchor(x: number, left: number, right: number, grab: number): 'left' | 'right' | null {
  const toLeft = Math.abs(x - left);
  const toRight = Math.abs(x - right);
  if (Math.min(toLeft, toRight) > grab) return null;
  if (toLeft < toRight) return 'right';
  if (toRight < toLeft) return 'left';
  return x < (left + right) / 2 ? 'right' : 'left';
}

/**
 * The selection implied by dragging from `anchor` to `moving`, never empty.
 *
 * `Editor.setSelection` discards a range whose end is not past its start, so a
 * drag that carried one edge onto the other destroyed the selection mid-gesture:
 * the handle disappeared, there was nothing left to resize, and the drag looked
 * stuck even though pointer events were still arriving. Holding one sample of
 * width keeps the handle under the finger on the way back out.
 */
export function dragRange(anchor: number, moving: number, total: number): { start: number; end: number } {
  let start = Math.min(anchor, moving);
  let end = Math.max(anchor, moving);
  if (end - start < 1) {
    if (start >= total) start = Math.max(0, total - 1);
    end = start + 1;
  }
  return { start, end };
}

/**
 * How hard to scroll when a drag reaches the edge of the view: -1 at the left
 * edge through 0 anywhere in the middle to +1 at the right. `x` is measured
 * from the left of the element.
 *
 * Without this a selection could never be longer than one screenful, because
 * the finger runs out of glass before the audio runs out of samples. The ramp
 * is linear across the zone rather than a step, so a finger parked just inside
 * it creeps and one pressed against the edge moves at full speed. The zone is
 * capped at a quarter of the width so that on a narrow element the two zones
 * cannot meet and leave no neutral middle.
 */
export function edgeScrollPush(x: number, width: number, zone: number): number {
  if (!(width > 0) || !(zone > 0)) return 0;
  const limit = Math.min(zone, width / 4);
  if (x < limit) return Math.max(-1, -(limit - x) / limit);
  if (x > width - limit) return Math.min(1, (x - (width - limit)) / limit);
  return 0;
}
