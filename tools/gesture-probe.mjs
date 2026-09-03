/**
 * Synthetic-touch harness for the mobile gesture path.
 *
 * Playwright's own touchscreen API only taps, so every multi-touch sequence here
 * is dispatched through CDP `Input.dispatchTouchEvent`. The app exposes
 * `window.__app` in these probe builds only, which is how the harness reads the
 * viewport range and the selection: neither is in the DOM.
 *
 * Run with BASE pointing at a probe build:
 *   BASE=http://127.0.0.1:4323 node gesture-probe.mjs
 */

import { devices, chromium } from '@playwright/test';
import { ensureFixture } from './fixture.mjs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:4325';
const FILE = ensureFixture(process.env.AUDIO);

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 393, height: 852 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent: devices['iPhone 14 Pro'].userAgent,
});
const page = await context.newPage();
const cdp = await context.newCDPSession(page);

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(BASE, { waitUntil: 'load' });
await page.setInputFiles('#file-input', FILE);
await page.waitForSelector('.transport .button--play:not([disabled])', { timeout: 15000 });
await page.waitForTimeout(300);

const canvas = await page.locator('#waveform').boundingBox();

/** Dispatch one touch frame. `points` is a list of {id, x, y} in CSS pixels. */
async function touch(type, points) {
  await cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: points.map((p) => ({ id: p.id, x: p.x, y: p.y, radiusX: 12, radiusY: 12, force: 1 })),
  });
  // One frame is enough for the app's rAF-driven render to observe the change.
  await page.waitForTimeout(24);
}

const state = () =>
  page.evaluate(() => {
    const editor = window.__app.editor;
    return {
      view: { ...editor.view },
      span: editor.view.end - editor.view.start,
      selection: editor.selection ? { ...editor.selection } : null,
      total: editor.totalSamples,
      playhead: editor.playhead,
    };
  });

const setState = (sel, view) =>
  page.evaluate(
    ([s, v]) => {
      const editor = window.__app.editor;
      if (v) editor.setView(v.start, v.end);
      editor.setSelection(s);
    },
    [sel, view],
  );

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`);
};

const cx = canvas.x + canvas.width / 2;
const cy = canvas.y + canvas.height / 2;

// ---------------------------------------------------------------------------
// 1. A pinch that rotates without changing finger separation must not zoom.
//    The old code measured separation on the x-axis alone, so turning the pair
//    toward vertical collapsed the denominator and the scale factor exploded.
//
//    This has to start zoomed in. From a fully zoomed-out view the runaway
//    zoom-out is absorbed by the clamp at the file length and the bug hides.
// ---------------------------------------------------------------------------
{
  const total = (await state()).total;
  const span = Math.round(total / 8);
  await setState(null, { start: Math.round(total * 0.4), end: Math.round(total * 0.4) + span });
  const before = await state();
  const R = 110;
  await touch('touchStart', [
    { id: 1, x: cx - R, y: cy },
    { id: 2, x: cx + R, y: cy },
  ]);
  // Quarter turn in 9 steps; separation is constant at 2R the whole way.
  for (let i = 1; i <= 9; i += 1) {
    const a = (Math.PI / 2) * (i / 9);
    const dx = R * Math.cos(a);
    const dy = R * Math.sin(a);
    await touch('touchMove', [
      { id: 1, x: cx - dx, y: cy - dy },
      { id: 2, x: cx + dx, y: cy + dy },
    ]);
  }
  await touch('touchEnd', []);
  const after = await state();
  const ratio = after.span / before.span;
  record(
    'rotating a pinch does not zoom',
    ratio > 0.8 && ratio < 1.25,
    `span ${before.span} -> ${after.span} (x${ratio.toFixed(3)}); separation held at ${2 * R}px through a 90 degree turn`,
  );
}

// ---------------------------------------------------------------------------
// 2. Lifting one finger mid-pinch must hand control to the finger still down.
//    Previously the gesture reset to 'none' and, because gestures only ever
//    started on pointerdown, the remaining finger was dead until it was lifted
//    and pressed again. This is the stuck-scrubber report.
// ---------------------------------------------------------------------------
{
  const total = (await state()).total;
  await setState(null, { start: 0, end: Math.round(total / 2) });
  await touch('touchStart', [
    { id: 1, x: cx - 80, y: cy },
    { id: 2, x: cx + 80, y: cy },
  ]);
  await touch('touchMove', [
    { id: 1, x: cx - 90, y: cy },
    { id: 2, x: cx + 90, y: cy },
  ]);
  // `touchEnd` carries the points being released, so this lifts finger 2 and
  // leaves finger 1 on the glass.
  await touch('touchEnd', [{ id: 2, x: cx + 90, y: cy }]);
  const afterLift = await state();
  for (let i = 1; i <= 6; i += 1) {
    await touch('touchMove', [{ id: 1, x: cx - 90 - i * 14, y: cy }]);
  }
  const afterDrag = await state();
  await touch('touchEnd', []);
  const responded =
    afterDrag.view.start !== afterLift.view.start ||
    JSON.stringify(afterDrag.selection) !== JSON.stringify(afterLift.selection);
  record(
    'the finger still down keeps control after the other lifts',
    responded,
    `after lift view.start=${afterLift.view.start} sel=${JSON.stringify(afterLift.selection)}; ` +
      `after dragging that finger 84px view.start=${afterDrag.view.start} sel=${JSON.stringify(afterDrag.selection)}`,
  );
}

// ---------------------------------------------------------------------------
// 3. Grabbing a handle must move the handle nearest the finger. The old code
//    tested the start edge first and the end edge second, each against the same
//    22px radius, so on any selection narrower than both radii together the
//    start edge won every time and the wrong end of the selection followed the
//    finger.
// ---------------------------------------------------------------------------
{
  const total = (await state()).total;
  await setState(null, { start: 0, end: total });
  const pxToSample = (px) => ((px - canvas.x) / canvas.width) * total;
  const sampleToPx = (s) => canvas.x + (s / total) * canvas.width;

  // A selection about 14px wide: inside the grab radius from either end.
  const left = Math.round(pxToSample(cx - 7));
  const right = Math.round(pxToSample(cx + 7));
  await setState({ start: left, end: right }, { start: 0, end: total });
  const before = await state();

  // Touch just outside the right-hand edge and drag further right. Only the
  // right edge should travel; the left edge is the anchor.
  await touch('touchStart', [{ id: 1, x: sampleToPx(right) + 3, y: cy }]);
  for (let i = 1; i <= 8; i += 1) {
    await touch('touchMove', [{ id: 1, x: sampleToPx(right) + 3 + i * 14, y: cy }]);
  }
  await touch('touchEnd', []);
  const after = await state();
  const leftMoved = Math.abs(after.selection.start - before.selection.start);
  const rightMoved = Math.abs(after.selection.end - before.selection.end);
  record(
    'grabbing a handle moves the nearer edge',
    after.selection != null && leftMoved <= 2 && rightMoved > 2,
    `selection ${JSON.stringify(before.selection)} -> ${JSON.stringify(after.selection)} after grabbing 3px right of the ` +
      `right edge of a 14px-wide selection and dragging 112px right; left edge moved ${leftMoved} samples, right edge moved ${rightMoved}`,
  );
}

// ---------------------------------------------------------------------------
// 4. Holding a drag against the edge must scroll the viewport, otherwise a
//    selection can never be longer than one screenful.
// ---------------------------------------------------------------------------
{
  const total = (await state()).total;
  const span = Math.round(total / 8);
  await setState(null, { start: Math.round(total * 0.4), end: Math.round(total * 0.4) + span });
  const before = await state();
  await touch('touchStart', [{ id: 1, x: cx, y: cy }]);
  await touch('touchMove', [{ id: 1, x: canvas.x + canvas.width - 8, y: cy }]);
  // Hold still inside the edge zone: only auto-scroll can move the view now.
  for (let i = 0; i < 14; i += 1) {
    await touch('touchMove', [{ id: 1, x: canvas.x + canvas.width - 8, y: cy + (i % 2) }]);
    await page.waitForTimeout(30);
  }
  const after = await state();
  await touch('touchEnd', []);
  record(
    'holding a drag at the edge scrolls the viewport',
    after.view.start > before.view.start,
    `view.start ${before.view.start} -> ${after.view.start} while the finger was parked 8px from the right edge`,
  );
}

// ---------------------------------------------------------------------------
// 5. A one-finger drag along the top strip must pan, not select. Panning was
//    two-finger-only, which is the reported difficulty getting to the part of
//    the file the user wanted to edit.
// ---------------------------------------------------------------------------
{
  const total = (await state()).total;
  const span = Math.round(total / 4);
  await setState({ start: 0, end: 1000 }, { start: Math.round(total * 0.4), end: Math.round(total * 0.4) + span });
  const before = await state();
  const stripY = canvas.y + 14;
  await touch('touchStart', [{ id: 1, x: cx, y: stripY }]);
  for (let i = 1; i <= 8; i += 1) {
    await touch('touchMove', [{ id: 1, x: cx - i * 16, y: stripY }]);
  }
  const after = await state();
  await touch('touchEnd', []);
  const panned = after.view.start !== before.view.start;
  const spanHeld = Math.abs(after.span - before.span) <= 2;
  const selectionUntouched = JSON.stringify(after.selection) === JSON.stringify(before.selection);
  record(
    'a one-finger drag in the top strip pans and leaves the selection alone',
    panned && spanHeld && selectionUntouched,
    `view.start ${before.view.start} -> ${after.view.start}, span ${before.span} -> ${after.span}, ` +
      `selection ${JSON.stringify(before.selection)} -> ${JSON.stringify(after.selection)}`,
  );
}

// ---------------------------------------------------------------------------
// 6. Undo must put the selection and the viewport back where they were.
// ---------------------------------------------------------------------------
{
  const total = (await state()).total;
  const sel = { start: Math.round(total * 0.25), end: Math.round(total * 0.45) };
  await setState(sel, { start: 0, end: total });
  const before = await state();
  await page.evaluate(() => window.__app.editor.deleteSelection());
  await page.waitForTimeout(80);
  const afterEdit = await state();
  await page.evaluate(() => window.__app.editor.undo());
  await page.waitForTimeout(120);
  const afterUndo = await state();
  const selBack =
    afterUndo.selection != null &&
    Math.abs(afterUndo.selection.start - before.selection.start) <= 1 &&
    Math.abs(afterUndo.selection.end - before.selection.end) <= 1;
  record(
    'undo restores the selection and the audio',
    selBack && afterUndo.total === before.total,
    `selection ${JSON.stringify(before.selection)} -> after delete ${JSON.stringify(afterEdit.selection)} -> ` +
      `after undo ${JSON.stringify(afterUndo.selection)}; length ${before.total} -> ${afterEdit.total} -> ${afterUndo.total}`,
  );
}

console.log(`\n${results.filter((r) => r.pass).length}/${results.length} passed   jsErrors=${errors.length}`);
if (errors.length) console.log(errors.join('\n'));

await browser.close();
process.exit(0);
