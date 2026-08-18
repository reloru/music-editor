/**
 * The waveform: canvas rendering plus every touch gesture the editor supports.
 *
 * Gesture model, chosen to match what phone audio apps do:
 *   one finger drag  → make or resize a selection (the thing you do most)
 *   one finger tap   → move the playhead
 *   two finger pinch → zoom, anchored between the fingers
 *   two finger drag  → pan
 *
 * Selection edges get a 22 px grab zone rather than a hairline, because a
 * fingertip is about 9 mm across and the visible handle is 2 px wide.
 */
import type { Editor } from '../editor';
import type { Range } from '../audio/pcm';
import { createColumn, readColumn, type Column } from '../audio/peaks';

const HANDLE_GRAB_PX = 22;
const TAP_SLOP_PX = 8;
const RULER_HEIGHT_PX = 22;
const MIN_ZOOM_SPAN = 64;

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
  | { kind: 'pending'; pointerId: number; startX: number; sample: number }
  | { kind: 'select'; pointerId: number; anchor: number }
  | { kind: 'pinch'; startSpan: number; startCenterSample: number; startDistance: number };

export class WaveformView {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private gesture: Gesture = { kind: 'none' };
  private column: Column = createColumn(0);
  private palette: Palette;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private frame = 0;
  private resizeObserver: ResizeObserver | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly editor: Editor,
  ) {
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Canvas 2D is unavailable on this device');
    this.ctx = context;
    this.palette = readPalette(canvas);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();

    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);
    // Safari fires gesture events for pinch on top of pointer events; swallow
    // them so the page itself never zooms while editing.
    canvas.addEventListener('gesturestart', preventDefault as EventListener);
    canvas.addEventListener('gesturechange', preventDefault as EventListener);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
  }

  destroy(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    cancelAnimationFrame(this.frame);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
  }

  refreshPalette(): void {
    this.palette = readPalette(this.canvas);
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
      this.beginPinch();
      return;
    }

    const selection = this.editor.selection;
    const x = this.cssToDevice(event.clientX);
    const grab = HANDLE_GRAB_PX * this.dpr;

    if (selection) {
      // Grabbing an edge keeps the opposite edge anchored.
      if (Math.abs(x - this.xOf(selection.start)) <= grab) {
        this.gesture = { kind: 'select', pointerId: event.pointerId, anchor: selection.end };
        return;
      }
      if (Math.abs(x - this.xOf(selection.end)) <= grab) {
        this.gesture = { kind: 'select', pointerId: event.pointerId, anchor: selection.start };
        return;
      }
    }

    this.gesture = {
      kind: 'pending',
      pointerId: event.pointerId,
      startX: event.clientX,
      sample: this.sampleAtClientX(event.clientX),
    };
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (!this.pointers.has(event.pointerId)) return;
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    event.preventDefault();

    if (this.gesture.kind === 'pinch') {
      this.updatePinch();
      return;
    }

    if (this.gesture.kind === 'pending') {
      if (Math.abs(event.clientX - this.gesture.startX) < TAP_SLOP_PX) return;
      // Movement past the slop turns the touch into a selection drag.
      this.gesture = { kind: 'select', pointerId: event.pointerId, anchor: this.gesture.sample };
    }

    if (this.gesture.kind === 'select' && this.gesture.pointerId === event.pointerId) {
      const current = this.sampleAtClientX(event.clientX);
      this.editor.setSelection(orderedRange(this.gesture.anchor, current));
    }
  };

  private onPointerUp = (event: PointerEvent): void => {
    this.pointers.delete(event.pointerId);
    if (this.canvas.hasPointerCapture(event.pointerId)) {
      this.canvas.releasePointerCapture(event.pointerId);
    }

    if (this.gesture.kind === 'pending' && this.gesture.pointerId === event.pointerId) {
      this.handleTap(this.gesture.sample);
    }

    if (this.pointers.size === 0) {
      this.gesture = { kind: 'none' };
    } else if (this.gesture.kind === 'pinch' && this.pointers.size < 2) {
      this.gesture = { kind: 'none' };
    }
  };

  /** A tap moves the playhead, and clears the selection if it lands outside it. */
  private handleTap(sample: number): void {
    const selection = this.editor.selection;
    const target = Math.round(sample);
    if (selection && (target < selection.start || target > selection.end)) {
      this.editor.clearSelection();
    }
    this.editor.seekToSamples(target);
  }

  private beginPinch(): void {
    const points = [...this.pointers.values()];
    if (points.length < 2) return;
    const distance = Math.max(1, Math.abs(points[0].x - points[1].x));
    const centerClientX = (points[0].x + points[1].x) / 2;
    this.gesture = {
      kind: 'pinch',
      startSpan: this.viewSpan,
      startCenterSample: this.sampleAtClientX(centerClientX),
      startDistance: distance,
    };
  }

  private updatePinch(): void {
    if (this.gesture.kind !== 'pinch') return;
    const points = [...this.pointers.values()];
    if (points.length < 2) return;

    const distance = Math.max(1, Math.abs(points[0].x - points[1].x));
    const scale = distance / this.gesture.startDistance;
    const span = clamp(this.gesture.startSpan / scale, MIN_ZOOM_SPAN, this.editor.totalSamples);

    // Keep the audio that was between the fingers between the fingers.
    const rect = this.canvas.getBoundingClientRect();
    const centerClientX = (points[0].x + points[1].x) / 2;
    const ratio = clamp((centerClientX - rect.left) / Math.max(1, rect.width), 0, 1);
    const start = this.gesture.startCenterSample - span * ratio;
    this.editor.setView(start, start + span);
  }

  private onWheel = (event: WheelEvent): void => {
    if (!this.editor.hasAudio) return;
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      // Trackpad pinch arrives as ctrl+wheel.
      this.editor.zoomBy(Math.exp(-event.deltaY / 200), this.sampleAtClientX(event.clientX));
    } else {
      this.editor.panBy((event.deltaX / Math.max(1, this.canvas.clientWidth)) * this.viewSpan);
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

    ctx.fillStyle = this.palette.background;
    ctx.fillRect(0, 0, width, height);

    const editor = this.editor;
    if (!editor.hasAudio || !editor.pcm || !editor.peaks) return;

    const ruler = RULER_HEIGHT_PX * this.dpr;
    const laneArea = height - ruler;
    const channels = editor.channels;
    const laneHeight = laneArea / channels;

    for (let c = 0; c < channels; c++) {
      this.drawLane(c, ruler + c * laneHeight, laneHeight);
    }

    this.drawSelection(ruler, laneArea);
    this.drawRuler(ruler);
    this.drawPlayhead(ruler, laneArea);
  }

  private drawLane(channelIndex: number, top: number, laneHeight: number): void {
    const { ctx, width } = this;
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

  private drawRuler(height: number): void {
    const { ctx, width } = this;
    const sampleRate = this.editor.sampleRate;
    const secondsVisible = this.viewSpan / sampleRate;

    ctx.fillStyle = this.palette.ruler;
    ctx.fillRect(0, 0, width, height);

    const step = chooseTickStep(secondsVisible);
    const first = Math.floor((this.editor.view.start / sampleRate) / step) * step;
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

function orderedRange(a: number, b: number): Range {
  return { start: Math.min(a, b), end: Math.max(a, b) };
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

function clampUnit(value: number): number {
  return value > 1 ? 1 : value < -1 ? -1 : value;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function preventDefault(event: Event): void {
  event.preventDefault();
}
