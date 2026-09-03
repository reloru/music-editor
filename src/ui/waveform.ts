/**
 * The waveform: canvas rendering plus every touch gesture the editor supports.
 *
 * Gesture model, chosen to match what phone audio apps do:
 *   one finger drag in a lane  → make or resize a selection (the thing you do most)
 *   one finger drag on the ruler → scroll the viewport
 *   one finger tap             → move the playhead
 *   two finger pinch           → zoom, anchored between the fingers
 *   two finger drag            → pan
 *
 * Three things about this are deliberate rather than incidental:
 *
 *   Selection edges get a 22 px grab zone rather than a hairline, because a
 *   fingertip is about 9 mm across and the visible handle is 2 px wide. On a
 *   selection narrower than 44 px those two zones overlap, so the *nearest*
 *   edge wins instead of whichever happens to be tested first.
 *
 *   Finger count can change mid-gesture. Lifting one finger out of a pinch
 *   re-arms the survivor as a pan rather than leaving the canvas inert until
 *   every finger is off the glass, and it re-arms as a pan rather than a
 *   selection so a stray finger cannot overwrite what you just selected.
 *
 *   Dragging a selection edge past the far side of the screen scrolls the
 *   viewport, because otherwise a selection can never be longer than one
 *   screenful and there is no way to reach audio that is off-screen while
 *   holding an edge.
 *
 * Rendering is split into a cached layer (background, lanes, ruler) and a live
 * layer (selection, playhead). The cached layer costs one `fillRect` per device
 * column per channel — around 7,000 calls on a 3× phone screen — and is only
 * redrawn when the audio, the viewport or the canvas size actually changes, so
 * dragging a handle or following the playhead costs one `drawImage` plus a
 * handful of fills instead.
 */
import type { Editor } from '../editor';
import { createColumn, readColumn, type Column } from '../audio/peaks';
import { dragRange, edgeScrollPush, fingerDistance, pickAnchor } from './gesture-math';

const HANDLE_GRAB_PX = 22;
const TAP_SLOP_PX = 8;
const RULER_HEIGHT_PX = 30;
/**
 * Pan strip at the top of the canvas: 44 px, the same tap minimum every button
 * in the app is held to, and still larger than the drawn ruler so the band
 * forgives a touch that lands just under the tick labels.
 */
const PAN_STRIP_PX = 44;
const MIN_ZOOM_SPAN = 64;
/** How close to an edge a drag has to get before the viewport starts scrolling. */
const EDGE_SCROLL_PX = 36;
/** Viewport widths per second at the fastest edge scroll. */
const EDGE_SCROLL_RATE = 1.1;

interface Palette {
  background: string;
  lane: string;
  centerLine: string;
  peak: string;
  rms: string;
  selection: string;
  selectionEdge: string;
  playhead: string;
  ruler: string;
  rulerText: string;
  clip: string;
}

type Gesture =
  | { kind: 'none' }
  | {
      kind: 'pending';
      pointerId: number;
      startX: number;
      sample: number;
      intent: 'select' | 'pan';
    }
  | { kind: 'select'; pointerId: number; anchor: number }
  | { kind: 'pan'; pointerId: number; startX: number; startViewStart: number; span: number }
  | { kind: 'twoFinger'; startSpan: number; startCenterSample: number; startDistance: number };

export class WaveformView {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private gesture: Gesture = { kind: 'none' };
  private column: Column = createColumn(0);
  private palette: Palette;
  private paletteToken = '';
  private width = 0;
  private height = 0;
  private dpr = 1;
  private frame = 0;
  private resizeObserver: ResizeObserver | null = null;

  /** Cached background + lanes + ruler, keyed by everything that affects them. */
  private readonly cache = document.createElement('canvas');
  private cacheCtx: CanvasRenderingContext2D | null = null;
  private cacheKey = '';

  private edgeScrollFrame = 0;
  private edgeScrollAt = 0;
  private edgeScrollVelocity = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly editor: Editor,
  ) {
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Canvas 2D is unavailable on this device');
    this.ctx = context;
    this.palette = readPalette(canvas);
    this.paletteToken = paletteToken(this.palette);
    this.cacheCtx = this.cache.getContext('2d', { alpha: false });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();

    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);
    // Losing capture without a pointerup happens when the browser takes the
    // gesture over; treat it as a release so no gesture is left half-open.
    canvas.addEventListener('lostpointercapture', this.onLostCapture);
    // Safari fires gesture events for pinch on top of pointer events; swallow
    // them so the page itself never zooms while editing.
    canvas.addEventListener('gesturestart', preventDefault as EventListener);
    canvas.addEventListener('gesturechange', preventDefault as EventListener);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    // iOS changes the visual viewport without resizing any element when the URL
    // bar collapses, which leaves the backing store the wrong size.
    window.visualViewport?.addEventListener('resize', this.onViewportResize);
  }

  destroy(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    cancelAnimationFrame(this.frame);
    this.stopEdgeScroll();
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerUp);
    this.canvas.removeEventListener('lostpointercapture', this.onLostCapture);
    this.canvas.removeEventListener('gesturestart', preventDefault as EventListener);
    this.canvas.removeEventListener('gesturechange', preventDefault as EventListener);
    this.canvas.removeEventListener('wheel', this.onWheel);
    window.visualViewport?.removeEventListener('resize', this.onViewportResize);
  }

  refreshPalette(): void {
    this.palette = readPalette(this.canvas);
    this.paletteToken = paletteToken(this.palette);
    this.render();
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    // Cap the backing store on 3× screens: a 430 pt wide canvas at DPR 3 is
    // 1290 device pixels, which is plenty, but tall lanes at DPR 3 on a big
    // buffer cost real fill rate.
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.width = Math.round(rect.width * this.dpr);
    this.height = Math.round(rect.height * this.dpr);
    if (this.canvas.width !== this.width || this.canvas.height !== this.height) {
      this.canvas.width = this.width;
      this.canvas.height = this.height;
    }
    if (this.column.min.length !== this.width) {
      this.column = createColumn(this.width);
    }
    this.render();
  }

  private onViewportResize = (): void => {
    this.resize();
  };

  // ------------------------------------------------------------- coordinates

  private get viewSpan(): number {
    return Math.max(1, this.editor.view.end - this.editor.view.start);
  }

  /** Device-pixel x for a sample position. */
  private xOf(sample: number): number {
    return ((sample - this.editor.view.start) / this.viewSpan) * this.width;
  }

  /** Sample position for a client-space x coordinate. */
  private sampleAtClientX(clientX: number): number {
    const rect = this.canvas.getBoundingClientRect();
    const ratio = (clientX - rect.left) / Math.max(1, rect.width);
    return this.editor.view.start + ratio * this.viewSpan;
  }

  private cssToDevice(clientX: number): number {
    const rect = this.canvas.getBoundingClientRect();
    return (clientX - rect.left) * this.dpr;
  }

  // ---------------------------------------------------------------- gestures

  private onPointerDown = (event: PointerEvent): void => {
    if (!this.editor.hasAudio) return;
    this.canvas.setPointerCapture(event.pointerId);
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    event.preventDefault();

    if (this.pointers.size >= 2) {
      this.stopEdgeScroll();
      this.beginTwoFinger();
      return;
    }

    const edge = this.grabbedEdge(event.clientX);
    if (edge != null) {
      this.gesture = { kind: 'select', pointerId: event.pointerId, anchor: edge };
      return;
    }

    const rect = this.canvas.getBoundingClientRect();
    const intent = event.clientY - rect.top <= PAN_STRIP_PX ? 'pan' : 'select';
    this.gesture = {
      kind: 'pending',
      pointerId: event.pointerId,
      startX: event.clientX,
      sample: this.sampleAtClientX(event.clientX),
      intent,
    };
  };

  /**
   * The sample to anchor against when a touch lands on a selection edge, or
   * null when it lands anywhere else.
   *
   * The anchor is the *opposite* edge, so dragging one side leaves the other
   * where it is. When both grab zones cover the touch — any selection narrower
   * than twice the grab radius — the nearer edge wins, and an exact tie is
   * broken by which half of the selection the touch is in.
   */
  private grabbedEdge(clientX: number): number | null {
    const selection = this.editor.selection;
    if (!selection) return null;

    // The grab radius is a screen distance, so the comparison happens in pixels
    // and only the answer comes back in samples.
    const side = pickAnchor(
      this.cssToDevice(clientX),
      this.xOf(selection.start),
      this.xOf(selection.end),
      HANDLE_GRAB_PX * this.dpr,
    );
    if (side == null) return null;
    return side === 'left' ? selection.start : selection.end;
  }

  private onPointerMove = (event: PointerEvent): void => {
    if (!this.pointers.has(event.pointerId)) return;
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    event.preventDefault();

    if (this.gesture.kind === 'twoFinger') {
      this.updateTwoFinger();
      return;
    }

    if (this.gesture.kind === 'pending' && this.gesture.pointerId === event.pointerId) {
      if (Math.abs(event.clientX - this.gesture.startX) < TAP_SLOP_PX) return;
      // Movement past the slop turns the touch into whichever drag the strip it
      // started in implies.
      this.gesture =
        this.gesture.intent === 'pan'
          ? {
              kind: 'pan',
              pointerId: event.pointerId,
              startX: this.gesture.startX,
              startViewStart: this.editor.view.start,
              span: this.viewSpan,
            }
          : { kind: 'select', pointerId: event.pointerId, anchor: this.gesture.sample };
    }

    if (this.gesture.kind === 'select' && this.gesture.pointerId === event.pointerId) {
      this.applySelection(this.gesture.anchor, this.sampleAtClientX(event.clientX));
      this.updateEdgeScroll(event.clientX);
      return;
    }

    if (this.gesture.kind === 'pan' && this.gesture.pointerId === event.pointerId) {
      const rect = this.canvas.getBoundingClientRect();
      const moved = ((event.clientX - this.gesture.startX) / Math.max(1, rect.width)) * this.gesture.span;
      const start = this.gesture.startViewStart - moved;
      this.editor.setView(start, start + this.gesture.span);
    }
  };

  private onPointerUp = (event: PointerEvent): void => {
    this.pointers.delete(event.pointerId);
    if (this.canvas.hasPointerCapture(event.pointerId)) {
      this.canvas.releasePointerCapture(event.pointerId);
    }
    this.endGestureFor(event.pointerId);
  };

  private onLostCapture = (event: PointerEvent): void => {
    if (!this.pointers.has(event.pointerId)) return;
    this.pointers.delete(event.pointerId);
    this.endGestureFor(event.pointerId);
  };

  private endGestureFor(pointerId: number): void {
    const gesture = this.gesture;

    if (gesture.kind === 'pending' && gesture.pointerId === pointerId) {
      this.handleTap(gesture.sample);
      this.gesture = { kind: 'none' };
    } else if (
      (gesture.kind === 'select' || gesture.kind === 'pan') &&
      gesture.pointerId === pointerId
    ) {
      this.stopEdgeScroll();
      this.gesture = { kind: 'none' };
    } else if (gesture.kind === 'twoFinger') {
      // A pinch that loses a finger becomes a one-finger pan on the survivor,
      // not a dead canvas and not a new selection.
      if (this.pointers.size >= 2) this.beginTwoFinger();
      else if (this.pointers.size === 1) this.beginResidualPan();
      else this.gesture = { kind: 'none' };
    }

    if (this.pointers.size === 0) {
      this.stopEdgeScroll();
      this.gesture = { kind: 'none' };
    }
  }

  /** A tap moves the playhead, and clears the selection if it lands outside it. */
  private handleTap(sample: number): void {
    const selection = this.editor.selection;
    const target = Math.round(sample);
    if (selection && (target < selection.start || target > selection.end)) {
      this.editor.clearSelection();
    }
    this.editor.seekToSamples(target);
  }

  /** See `dragRange`: this is what keeps a shrinking drag from jamming. */
  private applySelection(anchor: number, moving: number): void {
    this.editor.setSelection(dragRange(anchor, moving, this.editor.totalSamples));
  }

  private beginTwoFinger(): void {
    const points = [...this.pointers.values()];
    if (points.length < 2) return;
    const centerClientX = (points[0].x + points[1].x) / 2;
    this.gesture = {
      kind: 'twoFinger',
      startSpan: this.viewSpan,
      startCenterSample: this.sampleAtClientX(centerClientX),
      startDistance: fingerDistance(points[0], points[1]),
    };
  }

  private beginResidualPan(): void {
    const entry = [...this.pointers.entries()][0];
    if (!entry) {
      this.gesture = { kind: 'none' };
      return;
    }
    const [pointerId, point] = entry;
    this.gesture = {
      kind: 'pan',
      pointerId,
      startX: point.x,
      startViewStart: this.editor.view.start,
      span: this.viewSpan,
    };
  }

  /**
   * Zoom and pan from two fingers at once.
   *
   * Distance is Euclidean. Measuring it along x alone — as this did — makes a
   * vertical or diagonal pinch collapse the denominator towards zero and the
   * zoom factor towards infinity, which is why two-finger navigation used to
   * jump unpredictably.
   */
  private updateTwoFinger(): void {
    if (this.gesture.kind !== 'twoFinger') return;
    const points = [...this.pointers.values()];
    if (points.length < 2) return;

    const scale = fingerDistance(points[0], points[1]) / this.gesture.startDistance;
    const span = clamp(this.gesture.startSpan / scale, MIN_ZOOM_SPAN, this.editor.totalSamples);

    // Keep the audio that was between the fingers between the fingers. Because
    // the ratio is recomputed from where the fingers are now, translating both
    // fingers together pans without any separate pan branch.
    const rect = this.canvas.getBoundingClientRect();
    const centerClientX = (points[0].x + points[1].x) / 2;
    const ratio = clamp((centerClientX - rect.left) / Math.max(1, rect.width), 0, 1);
    const start = this.gesture.startCenterSample - span * ratio;
    this.editor.setView(start, start + span);
  }

  // ------------------------------------------------------------- edge scroll

  /**
   * Scrolls the viewport while a selection drag sits near a screen edge, at a
   * rate proportional to how far into the edge zone the finger is.
   */
  private updateEdgeScroll(clientX: number): void {
    const rect = this.canvas.getBoundingClientRect();
    const push = edgeScrollPush(clientX - rect.left, rect.width, EDGE_SCROLL_PX);

    this.edgeScrollVelocity = push * this.viewSpan * EDGE_SCROLL_RATE;
    if (push === 0) {
      this.stopEdgeScroll();
    } else if (this.edgeScrollFrame === 0) {
      // The clock is deliberately not seeded here. A requestAnimationFrame
      // callback is handed the frame's start time, which can predate the
      // `performance.now()` of the event handler that scheduled it, so seeding
      // from this side yields a negative first delta. The tick establishes its
      // own baseline instead.
      this.edgeScrollAt = 0;
      this.edgeScrollFrame = requestAnimationFrame(this.edgeScrollTick);
    }
  }

  private edgeScrollTick = (now: number): void => {
    this.edgeScrollFrame = 0;
    if (this.gesture.kind !== 'select' || this.edgeScrollVelocity === 0) return;

    // Stop only when the viewport really cannot travel any further the way the
    // finger is pushing. A frame that happens to move nothing is not a reason to
    // tear the loop down: the first frame moves nothing by design, and a frame
    // whose delta rounds below one sample would otherwise end auto-scroll for
    // the rest of the drag.
    const { start, end } = this.editor.view;
    const blocked = this.edgeScrollVelocity > 0 ? end >= this.editor.totalSamples : start <= 0;
    if (blocked) {
      this.stopEdgeScroll();
      return;
    }

    if (this.edgeScrollAt === 0) {
      this.edgeScrollAt = now;
    } else {
      // Clamped so a frame lost to a long task cannot fling the viewport.
      const dt = Math.min(0.05, Math.max(0, (now - this.edgeScrollAt) / 1000));
      this.edgeScrollAt = now;
      this.editor.panBy(this.edgeScrollVelocity * dt);

      const point = this.pointers.get(this.gesture.pointerId);
      if (point) this.applySelection(this.gesture.anchor, this.sampleAtClientX(point.x));
    }

    this.edgeScrollFrame = requestAnimationFrame(this.edgeScrollTick);
  };

  private stopEdgeScroll(): void {
    if (this.edgeScrollFrame !== 0) cancelAnimationFrame(this.edgeScrollFrame);
    this.edgeScrollFrame = 0;
    this.edgeScrollVelocity = 0;
  }

  private onWheel = (event: WheelEvent): void => {
    if (!this.editor.hasAudio) return;
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      // Trackpad pinch arrives as ctrl+wheel.
      this.editor.zoomBy(Math.exp(-event.deltaY / 200), this.sampleAtClientX(event.clientX));
    } else {
      const along = Math.abs(event.deltaX) >= Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      this.editor.panBy((along / Math.max(1, this.canvas.clientWidth)) * this.viewSpan);
    }
  };

  // --------------------------------------------------------------- rendering

  /** Schedules a repaint on the next frame, coalescing multiple calls. */
  requestRender(): void {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.render());
  }

  render(): void {
    const { ctx, width, height } = this;
    if (width === 0 || height === 0) return;

    const editor = this.editor;
    if (!editor.hasAudio || !editor.pcm || !editor.peaks) {
      ctx.fillStyle = this.palette.background;
      ctx.fillRect(0, 0, width, height);
      this.cacheKey = '';
      return;
    }

    const ruler = RULER_HEIGHT_PX * this.dpr;
    const laneArea = height - ruler;

    const key = [
      width,
      height,
      editor.revision,
      editor.view.start,
      editor.view.end,
      editor.channels,
      this.paletteToken,
    ].join('|');
    if (key !== this.cacheKey) {
      this.paintCache(ruler, laneArea);
      this.cacheKey = key;
    }

    ctx.drawImage(this.cache, 0, 0);
    this.drawSelection(ruler, laneArea);
    this.drawPlayhead(ruler, laneArea);
  }

  /** Redraws the parts that only change when the audio or viewport does. */
  private paintCache(ruler: number, laneArea: number): void {
    const { width, height } = this;
    if (this.cache.width !== width || this.cache.height !== height) {
      this.cache.width = width;
      this.cache.height = height;
    }
    const ctx = this.cacheCtx ?? this.cache.getContext('2d', { alpha: false });
    if (!ctx) return;
    this.cacheCtx = ctx;

    ctx.fillStyle = this.palette.background;
    ctx.fillRect(0, 0, width, height);

    const channels = Math.max(1, this.editor.channels);
    const laneHeight = laneArea / channels;
    for (let c = 0; c < channels; c++) {
      this.drawLane(ctx, c, ruler + c * laneHeight, laneHeight);
    }
    this.drawRuler(ctx, ruler);
  }

  private drawLane(
    ctx: CanvasRenderingContext2D,
    channelIndex: number,
    top: number,
    laneHeight: number,
  ): void {
    const { width } = this;
    const editor = this.editor;
    if (!editor.pcm || !editor.peaks) return;

    const center = top + laneHeight / 2;
    const half = (laneHeight / 2) * 0.92;

    ctx.fillStyle = this.palette.lane;
    ctx.fillRect(0, top, width, laneHeight);

    readColumn(editor.pcm, editor.peaks, channelIndex, editor.view.start, editor.view.end, this.column);

    // Peak envelope first, then the RMS body on top: the two-tone look makes
    // quiet passages readable at a glance instead of a solid block.
    ctx.fillStyle = this.palette.peak;
    for (let x = 0; x < width; x++) {
      const top_ = center - clampUnit(this.column.max[x]) * half;
      const bottom = center - clampUnit(this.column.min[x]) * half;
      ctx.fillRect(x, top_, 1, Math.max(1, bottom - top_));
    }

    ctx.fillStyle = this.palette.rms;
    for (let x = 0; x < width; x++) {
      const rms = Math.min(1, this.column.rms[x]) * half;
      ctx.fillRect(x, center - rms, 1, Math.max(1, rms * 2));
    }

    ctx.fillStyle = this.palette.centerLine;
    ctx.fillRect(0, Math.round(center), width, 1);

    // Anything that exceeded full scale gets a marker; float headroom means the
    // samples survive, but the user still needs to know before export.
    ctx.fillStyle = this.palette.clip;
    for (let x = 0; x < width; x++) {
      if (this.column.max[x] > 1 || this.column.min[x] < -1) {
        ctx.fillRect(x, top + 1, 1, 3 * this.dpr);
      }
    }
  }

  private drawSelection(top: number, laneArea: number): void {
    const selection = this.editor.selection;
    if (!selection) return;
    const { ctx } = this;

    const left = this.xOf(selection.start);
    const right = this.xOf(selection.end);

    ctx.fillStyle = this.palette.selection;
    ctx.fillRect(left, top, Math.max(1, right - left), laneArea);

    ctx.fillStyle = this.palette.selectionEdge;
    const edge = Math.max(2, 2 * this.dpr);
    ctx.fillRect(left - edge / 2, top, edge, laneArea);
    ctx.fillRect(right - edge / 2, top, edge, laneArea);

    // Grips: visual confirmation that the edges are draggable.
    const gripHeight = 28 * this.dpr;
    const gripWidth = 6 * this.dpr;
    const gripTop = top + laneArea / 2 - gripHeight / 2;
    roundedRect(ctx, left - gripWidth / 2, gripTop, gripWidth, gripHeight, gripWidth / 2);
    roundedRect(ctx, right - gripWidth / 2, gripTop, gripWidth, gripHeight, gripWidth / 2);
  }

  private drawPlayhead(top: number, laneArea: number): void {
    const { ctx } = this;
    const x = this.xOf(this.editor.playhead);
    if (x < -4 || x > this.width + 4) return;

    ctx.fillStyle = this.palette.playhead;
    ctx.fillRect(x - this.dpr, top, 2 * this.dpr, laneArea);

    const size = 5 * this.dpr;
    ctx.beginPath();
    ctx.moveTo(x - size, top);
    ctx.lineTo(x + size, top);
    ctx.lineTo(x, top + size * 1.4);
    ctx.closePath();
    ctx.fill();
  }

  private drawRuler(ctx: CanvasRenderingContext2D, height: number): void {
    const { width } = this;
    const sampleRate = this.editor.sampleRate;
    const secondsVisible = this.viewSpan / sampleRate;

    ctx.fillStyle = this.palette.ruler;
    ctx.fillRect(0, 0, width, height);

    const step = chooseTickStep(secondsVisible);
    const first = Math.floor(this.editor.view.start / sampleRate / step) * step;
    const last = this.editor.view.end / sampleRate;

    ctx.fillStyle = this.palette.rulerText;
    ctx.font = `${11 * this.dpr}px -apple-system, system-ui, sans-serif`;
    ctx.textBaseline = 'middle';

    for (let t = first; t <= last; t += step) {
      const x = this.xOf(t * sampleRate);
      if (x < 0 || x > width) continue;
      ctx.fillRect(x, height - 6 * this.dpr, 1, 6 * this.dpr);
      ctx.fillText(formatTick(t, step), x + 4 * this.dpr, height / 2);
    }
  }
}

function chooseTickStep(secondsVisible: number): number {
  // Aim for roughly six labels across the width.
  const target = secondsVisible / 6;
  const steps = [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  for (const step of steps) {
    if (step >= target) return step;
  }
  return steps[steps.length - 1];
}

function formatTick(seconds: number, step: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  const decimals = step < 0.01 ? 3 : step < 1 ? 2 : 0;
  return `${minutes}:${rest.toFixed(decimals).padStart(decimals > 0 ? decimals + 3 : 2, '0')}`;
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
  ctx.fill();
}

function readPalette(element: HTMLElement): Palette {
  const style = getComputedStyle(element);
  const read = (name: string, fallback: string): string => style.getPropertyValue(name).trim() || fallback;
  return {
    background: read('--wave-bg', '#0d1117'),
    lane: read('--wave-lane', '#141b24'),
    centerLine: read('--wave-center', '#2a3441'),
    peak: read('--wave-peak', '#3d7dff'),
    rms: read('--wave-rms', '#9fc4ff'),
    selection: read('--wave-selection', 'rgba(61, 125, 255, 0.22)'),
    selectionEdge: read('--wave-selection-edge', '#7aa7ff'),
    playhead: read('--wave-playhead', '#ff9f43'),
    ruler: read('--wave-ruler', '#11161d'),
    rulerText: read('--wave-ruler-text', '#8493a8'),
    clip: read('--wave-clip', '#ff4d4f'),
  };
}

/** Cheap identity for a palette, so a theme change invalidates the cache. */
function paletteToken(palette: Palette): string {
  return Object.values(palette).join(',');
}

function clampUnit(value: number): number {
  return value > 1 ? 1 : value < -1 ? -1 : value;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function preventDefault(event: Event): void {
  event.preventDefault();
}
