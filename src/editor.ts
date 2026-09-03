/**
 * The editor document: audio, selection, viewport, history and transport.
 *
 * The UI layer never mutates any of this directly — it calls commands here and
 * re-reads state when the change event fires. Keeping it in one place means
 * every edit gets the same treatment: history recorded, peaks rebuilt, the
 * playback buffer swapped, listeners notified.
 */
import { AudioEngine } from './audio/engine';
import { decodeAudioFile } from './audio/decode';
import * as dsp from './audio/dsp';
import { changeSpeed } from './audio/offline';
import { buildPeaks, type PeakPyramid } from './audio/peaks';
import {
  type Pcm,
  type Range,
  byteSize,
  channelCount,
  clampRange,
  duration,
  frameCount,
  samplesToSeconds,
  secondsToSamples,
} from './audio/pcm';
import { History } from './state/history';

export interface Busy {
  label: string;
  /** 0…1, or null when the work has no measurable progress. */
  progress: number | null;
}

export interface Notice {
  kind: 'info' | 'error';
  text: string;
}

/**
 * What undo restores. Storing only the audio was the reason a selection
 * disappeared after undoing a trim or a delete: those commands clear the
 * selection as part of the edit, and there was nothing left to put back.
 * Position is part of the document state, so it travels with it.
 */
interface Snapshot {
  pcm: Pcm;
  selection: Range | null;
  playhead: number;
  view: Range;
}

/** Smallest window the viewport will zoom into, in samples. */
const MIN_VIEW_SAMPLES = 64;

export class Editor {
  readonly engine = new AudioEngine();

  pcm: Pcm | null = null;
  peaks: PeakPyramid | null = null;
  fileName = '';
  /** Sample range the user has selected, or null for "no selection". */
  selection: Range | null = null;
  /** Sample range currently drawn on screen. */
  view: Range = { start: 0, end: 0 };
  clipboard: Pcm | null = null;
  loop = false;
  busy: Busy | null = null;
  notice: Notice | null = null;
  /** True once the buffer differs from the file that was loaded. */
  dirty = false;

  private playheadSamples = 0;
  /**
   * Bumped whenever the sample data changes. The waveform keys its offscreen
   * cache on this, so it can tell "same audio, different viewport" from "new
   * audio" without comparing buffers.
   */
  revision = 0;
  private readonly history = new History<Snapshot>({ sizeOf: (state) => byteSize(state.pcm) });
  private readonly listeners = new Set<() => void>();

  constructor() {
    this.engine.onStateChange = () => this.emit();
  }

  // ---------------------------------------------------------------- lifecycle

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(): void {
    for (const listener of this.listeners) listener();
  }

  // ------------------------------------------------------------------ loading

  async loadFile(file: File): Promise<void> {
    await this.load(await file.arrayBuffer(), file.name);
  }

  async load(data: ArrayBuffer, name: string): Promise<void> {
    await this.runTask(`Opening ${name}`, async () => {
      // `acquireContext`, never `ensureContext`: decoding needs a context
      // object, not a running one, and awaiting a resume outside a user gesture
      // can hang forever. See AudioEngine.acquireContext.
      const ctx = this.engine.acquireContext();
      const { pcm, via } = await decodeAudioFile(data, ctx);
      if (frameCount(pcm) === 0) throw new Error('That file contains no audio.');

      this.history.clear();
      this.fileName = name;
      this.setPcm(pcm, { resetView: true });
      this.selection = null;
      this.playheadSamples = 0;
      this.dirty = false;
      if (via === 'wav-fallback') {
        this.notice = { kind: 'info', text: 'Opened with the built-in WAV reader.' };
      }
    });
  }

  /** Drops the document without touching history limits or settings. */
  close(): void {
    this.history.clear();
    this.pcm = null;
    this.revision++;
    this.peaks = null;
    this.fileName = '';
    this.selection = null;
    this.view = { start: 0, end: 0 };
    this.playheadSamples = 0;
    this.dirty = false;
    this.engine.setPcm(null);
    this.emit();
  }

  // ------------------------------------------------------------------ queries

  get hasAudio(): boolean {
    return this.pcm != null && frameCount(this.pcm) > 0;
  }

  get sampleRate(): number {
    return this.pcm?.sampleRate ?? 48000;
  }

  get totalSamples(): number {
    return this.pcm ? frameCount(this.pcm) : 0;
  }

  get durationSeconds(): number {
    return this.pcm ? duration(this.pcm) : 0;
  }

  get channels(): number {
    return this.pcm ? channelCount(this.pcm) : 0;
  }

  /** Bytes retained by the undo and redo stacks. */
  get historyBytes(): number {
    return this.history.bytes;
  }

  get canUndo(): boolean {
    return this.history.canUndo;
  }

  get canRedo(): boolean {
    return this.history.canRedo;
  }

  get undoLabel(): string | null {
    return this.history.undoLabel;
  }

  get redoLabel(): string | null {
    return this.history.redoLabel;
  }

  get playing(): boolean {
    return this.engine.isPlaying;
  }

  /** Live playhead position in samples; follows the audio clock during playback. */
  get playhead(): number {
    if (this.engine.isPlaying) {
      return Math.round(this.engine.currentTime * this.sampleRate);
    }
    return this.playheadSamples;
  }

  set playhead(samples: number) {
    this.playheadSamples = Math.max(0, Math.min(this.totalSamples, Math.round(samples)));
    this.engine.seek(samplesToSeconds(this.playheadSamples, this.sampleRate));
  }

  /** The selection, or the whole file when nothing is selected. */
  get effectiveRange(): Range {
    if (!this.pcm) return { start: 0, end: 0 };
    return clampRange(this.pcm, this.selection ?? { start: 0, end: frameCount(this.pcm) });
  }

  get hasSelection(): boolean {
    return this.selection != null && this.selection.end > this.selection.start;
  }

  // ---------------------------------------------------------------- selection

  setSelection(range: Range | null): void {
    if (!this.pcm || !range) {
      this.selection = null;
    } else {
      const clamped = clampRange(this.pcm, range);
      this.selection = clamped.end > clamped.start ? clamped : null;
    }
    this.emit();
  }

  selectAll(): void {
    if (!this.pcm) return;
    this.selection = { start: 0, end: frameCount(this.pcm) };
    this.emit();
  }

  clearSelection(): void {
    this.selection = null;
    this.emit();
  }

  // ----------------------------------------------------------------- viewport

  setView(start: number, end: number): void {
    const total = this.totalSamples;
    if (total === 0) {
      this.view = { start: 0, end: 0 };
      return;
    }
    let width = Math.max(MIN_VIEW_SAMPLES, Math.min(total, end - start));
    let from = Math.max(0, Math.min(total - width, start));
    if (width >= total) {
      from = 0;
      width = total;
    }
    this.view = { start: Math.round(from), end: Math.round(from + width) };
    this.emit();
  }

  /** Zooms by `factor` (>1 zooms in) keeping `anchor` fixed on screen. */
  zoomBy(factor: number, anchorSamples?: number): void {
    const { start, end } = this.view;
    const width = end - start;
    if (width <= 0) return;
    const anchor = anchorSamples ?? start + width / 2;
    const nextWidth = width / factor;
    const ratio = (anchor - start) / width;
    this.setView(anchor - nextWidth * ratio, anchor - nextWidth * ratio + nextWidth);
  }

  zoomToFit(): void {
    this.setView(0, this.totalSamples);
  }

  zoomToSelection(): void {
    if (!this.hasSelection || !this.selection) return;
    const padding = Math.max(1, (this.selection.end - this.selection.start) * 0.05);
    this.setView(this.selection.start - padding, this.selection.end + padding);
  }

  panBy(samples: number): void {
    this.setView(this.view.start + samples, this.view.end + samples);
  }

  /** Scrolls the viewport so the playhead stays on screen while playing. */
  followPlayhead(): void {
    const { start, end } = this.view;
    const width = end - start;
    if (width <= 0 || width >= this.totalSamples) return;
    const position = this.playhead;
    if (position < start || position > end - width * 0.1) {
      this.setView(position - width * 0.3, position - width * 0.3 + width);
    }
  }

  // ---------------------------------------------------------------- transport

  async togglePlay(): Promise<void> {
    if (this.engine.isPlaying) {
      this.engine.pause();
      this.playheadSamples = Math.round(this.engine.currentTime * this.sampleRate);
      this.emit();
      return;
    }
    await this.play();
  }

  async play(): Promise<void> {
    if (!this.hasAudio) return;
    await this.engine.ensureContext();

    const rate = this.sampleRate;
    const selection = this.hasSelection ? this.selection : null;
    let from = this.playheadSamples;
    let to: number | null = null;

    if (selection) {
      // Play the selection: start at its head unless the playhead is inside it.
      to = selection.end;
      if (from < selection.start || from >= selection.end) from = selection.start;
    }
    if (from >= this.totalSamples) from = 0;

    await this.engine.play({
      from: samplesToSeconds(from, rate),
      to: to != null ? samplesToSeconds(to, rate) : null,
      loop: this.loop,
    });
    this.emit();
  }

  pause(): void {
    this.playheadSamples = Math.round(this.engine.currentTime * this.sampleRate);
    this.engine.pause();
    this.emit();
  }

  /** Stops and drops the playhead at the start of the selection, or of the file. */
  stop(): void {
    const home = this.hasSelection && this.selection ? this.selection.start : 0;
    this.engine.stopAt(samplesToSeconds(home, this.sampleRate));
    this.playheadSamples = home;
    this.emit();
  }

  toggleLoop(): void {
    this.loop = !this.loop;
    if (this.engine.isPlaying) void this.play();
    this.emit();
  }

  seekToSamples(samples: number): void {
    this.playhead = samples;
    this.emit();
  }

  // -------------------------------------------------------------------- edits

  async trimToSelection(): Promise<void> {
    if (!this.hasSelection) {
      this.warn('Select part of the track first.');
      return;
    }
    const range = this.effectiveRange;
    await this.applyEdit('Trim', (pcm) => dsp.declick(dsp.trimTo(pcm, range), { start: 0, end: range.end - range.start }));
    this.selection = null;
    this.playheadSamples = 0;
    this.zoomToFit();
  }

  async deleteSelection(): Promise<void> {
    if (!this.hasSelection) {
      this.warn('Select part of the track first.');
      return;
    }
    const range = this.effectiveRange;
    await this.applyEdit('Delete', (pcm) => dsp.remove(pcm, range));
    this.playheadSamples = range.start;
    this.selection = null;
  }

  copySelection(): void {
    if (!this.pcm || !this.hasSelection) {
      this.warn('Select part of the track first.');
      return;
    }
    this.clipboard = dsp.slice(this.pcm, this.effectiveRange);
    this.notice = { kind: 'info', text: `Copied ${formatDuration(duration(this.clipboard))}` };
    this.emit();
  }

  async cutSelection(): Promise<void> {
    if (!this.pcm || !this.hasSelection) {
      this.warn('Select part of the track first.');
      return;
    }
    this.clipboard = dsp.slice(this.pcm, this.effectiveRange);
    const range = this.effectiveRange;
    await this.applyEdit('Cut', (pcm) => dsp.remove(pcm, range));
    this.playheadSamples = range.start;
    this.selection = null;
  }

  async paste(): Promise<void> {
    const clip = this.clipboard;
    if (!clip) {
      this.warn('Nothing copied yet.');
      return;
    }
    const at = this.hasSelection && this.selection ? this.selection.start : this.playhead;
    const range = this.selection;
    const pasted = frameCount(dsp.conform(clip, this.sampleRate, this.channels));

    await this.applyEdit('Paste', (pcm) =>
      range ? dsp.replaceRange(pcm, range, clip) : dsp.insert(pcm, clip, at),
    );
    this.selection = { start: at, end: at + pasted };
  }

  async silenceSelection(): Promise<void> {
    const range = this.effectiveRange;
    await this.applyEdit('Silence', (pcm) => dsp.silence(pcm, range));
  }

  async fadeIn(): Promise<void> {
    const range = this.effectiveRange;
    await this.applyEdit('Fade in', (pcm) => dsp.fade(pcm, range, 'in'));
  }

  async fadeOut(): Promise<void> {
    const range = this.effectiveRange;
    await this.applyEdit('Fade out', (pcm) => dsp.fade(pcm, range, 'out'));
  }

  async normalize(targetDb = -1): Promise<void> {
    const range = this.effectiveRange;
    await this.applyEdit('Normalize', (pcm) => dsp.normalize(pcm, range, targetDb));
  }

  async applyGainDb(db: number): Promise<void> {
    if (db === 0) return;
    const range = this.effectiveRange;
    await this.applyEdit(`Gain ${db > 0 ? '+' : ''}${db} dB`, (pcm) => dsp.applyGainDb(pcm, range, db));
  }

  async reverse(): Promise<void> {
    const range = this.effectiveRange;
    await this.applyEdit('Reverse', (pcm) => dsp.reverse(pcm, range));
  }

  async removeDcOffset(): Promise<void> {
    const range = this.effectiveRange;
    await this.applyEdit('Remove DC offset', (pcm) => dsp.removeDcOffset(pcm, range));
  }

  async insertSilence(seconds: number): Promise<void> {
    const at = this.playhead;
    await this.applyEdit(`Insert ${seconds}s silence`, (pcm) => dsp.insertSilence(pcm, at, seconds));
  }

  /** Tape-style speed change: `rate` above 1 is faster and higher-pitched. */
  async changeSpeed(rate: number): Promise<void> {
    if (rate === 1) return;
    const selection = this.hasSelection ? this.effectiveRange : null;
    await this.applyEdit(`Speed ${rate}×`, async (pcm) => {
      if (!selection) return changeSpeed(pcm, rate);
      // Stretch only the selected part and splice it back in.
      const stretched = await changeSpeed(dsp.slice(pcm, selection), rate);
      return dsp.replaceRange(pcm, selection, stretched);
    });
    this.selection = null;
  }

  // ------------------------------------------------------------ undo and redo

  undo(): void {
    if (!this.pcm || !this.history.canUndo) return;
    const entry = this.history.undo(this.snapshot());
    if (!entry) return;
    this.restore(entry.value);
    this.notice = { kind: 'info', text: `Undid ${entry.label.toLowerCase()}` };
    this.dirty = true;
    this.emit();
  }

  redo(): void {
    if (!this.pcm || !this.history.canRedo) return;
    const entry = this.history.redo(this.snapshot());
    if (!entry) return;
    this.restore(entry.value);
    this.notice = { kind: 'info', text: `Redid ${entry.label.toLowerCase()}` };
    this.dirty = true;
    this.emit();
  }

  /** The full document state, for the opposite stack to hold onto. */
  private snapshot(): Snapshot {
    if (!this.pcm) throw new Error('No document to snapshot');
    return {
      pcm: this.pcm,
      selection: this.selection ? { ...this.selection } : null,
      playhead: this.playheadSamples,
      view: { ...this.view },
    };
  }

  /**
   * Puts a whole document state back, position included.
   *
   * `setPcm` re-derives the viewport from the buffer length, so the recorded
   * viewport and selection are applied afterwards and clamped to the buffer
   * they are being restored onto — an undo can only ever widen the buffer back
   * to a length the recorded ranges already fitted, but a truncated redo stack
   * makes no such promise.
   */
  private restore(state: Snapshot): void {
    this.setPcm(state.pcm, { resetView: false });
    const total = frameCount(state.pcm);

    const width = Math.max(MIN_VIEW_SAMPLES, Math.min(total, state.view.end - state.view.start));
    const start = Math.max(0, Math.min(total - width, state.view.start));
    this.view = width >= total ? { start: 0, end: total } : { start, end: start + width };

    if (state.selection) {
      const clamped = clampRange(state.pcm, state.selection);
      this.selection = clamped.end > clamped.start ? clamped : null;
    } else {
      this.selection = null;
    }

    this.playhead = Math.min(state.playhead, total);
  }

  // ----------------------------------------------------------------- internals

  /**
   * Runs one destructive edit: records history, swaps the buffer, rebuilds
   * peaks and keeps the viewport pointing at roughly the same audio.
   */
  async applyEdit(label: string, operation: (pcm: Pcm) => Pcm | Promise<Pcm>): Promise<void> {
    const current = this.pcm;
    if (!current) return;
    // Captured before the operation runs, and before the caller adjusts the
    // selection for the post-edit state.
    const before = this.snapshot();

    await this.runTask(label, async () => {
      const next = await operation(current);
      if (frameCount(next) === 0) {
        throw new Error('That edit would leave an empty track.');
      }
      this.history.record(label, before);
      this.setPcm(next, { resetView: false });
      this.dirty = true;
    });
  }

  private setPcm(pcm: Pcm, options: { resetView: boolean }): void {
    const previousTotal = this.totalSamples;
    this.pcm = pcm;
    this.revision++;
    this.peaks = buildPeaks(pcm);
    this.engine.setPcm(pcm);

    const total = frameCount(pcm);
    if (options.resetView || previousTotal === 0 || this.view.end <= this.view.start) {
      this.view = { start: 0, end: total };
    } else {
      // Keep the window where it was, but never past the (possibly shorter) end.
      const width = Math.min(total, this.view.end - this.view.start);
      const start = Math.max(0, Math.min(total - width, this.view.start));
      this.view = { start, end: start + width };
    }

    this.playheadSamples = Math.min(this.playheadSamples, total);
    if (this.selection) {
      const clamped = clampRange(pcm, this.selection);
      this.selection = clamped.end > clamped.start ? clamped : null;
    }
  }

  /**
   * Runs `work` behind the busy overlay, turning any failure into a notice
   * instead of an unhandled rejection.
   */
  async runTask<T>(label: string, work: () => Promise<T>): Promise<T | undefined> {
    this.busy = { label, progress: null };
    this.notice = null;
    this.emit();
    // Let the browser paint the busy state before the main thread gets blocked.
    await nextFrame();
    try {
      return await work();
    } catch (error) {
      this.notice = { kind: 'error', text: error instanceof Error ? error.message : String(error) };
      return undefined;
    } finally {
      this.busy = null;
      this.emit();
    }
  }

  setProgress(value: number | null): void {
    if (this.busy) {
      this.busy = { label: this.busy.label, progress: value };
      this.emit();
    }
  }

  private warn(text: string): void {
    this.notice = { kind: 'error', text };
    this.emit();
  }

  // ------------------------------------------------------------------ helpers

  secondsToSamples(seconds: number): number {
    return secondsToSamples(seconds, this.sampleRate);
  }

  samplesToSeconds(samples: number): number {
    return samplesToSeconds(samples, this.sampleRate);
  }
}

/**
 * Yields one frame, or 50 ms, whichever lands first.
 *
 * `runTask` uses this to let the busy overlay paint before the main thread is
 * blocked, which makes it a step every long operation has to pass through.
 * requestAnimationFrame does not fire while the document is hidden, and iOS
 * puts the file picker over the page as a sheet — so a callback scheduled
 * either side of one can be deferred indefinitely, and with it the whole task.
 * The timer is the floor.
 */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    requestAnimationFrame(finish);
    setTimeout(finish, 50);
  });
}

/**
 * Reads a position the user typed into one of the readout fields.
 *
 * Accepts `s`, `m:s`, and `h:m:s`, with an optional fraction on the last part,
 * and treats a comma as a decimal point — the iOS decimal keypad emits whichever
 * separator the locale uses, and it has no colon key at all, so plain seconds is
 * the only form some users can type without switching keyboards.
 *
 * Minutes and seconds are not bounded at 60: `1:90` is 150 seconds. That makes
 * arithmetic on a position ("thirty seconds later") something you can type
 * directly instead of having to carry.
 *
 * Returns null for anything it cannot read, including the empty string, so the
 * caller decides whether that clears the value or is an error.
 */
export function parseTimecode(text: string): number | null {
  const cleaned = text.trim().replace(/,/g, '.');
  const match = /^(?:(\d+):)?(?:(\d+):)?(\d+(?:\.\d*)?|\.\d+)$/.exec(cleaned);
  if (!match) return null;

  // With one colon the leading group is minutes; with two it is hours.
  const [hours, minutes] =
    match[2] == null ? [0, Number(match[1] ?? 0)] : [Number(match[1]), Number(match[2])];
  const seconds = Number(match[3]);
  const total = hours * 3600 + minutes * 60 + seconds;
  return Number.isFinite(total) ? total : null;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const minutes = Math.floor(seconds / 60);
  const whole = Math.floor(seconds % 60);
  const hundredths = Math.floor((seconds % 1) * 100);
  return `${minutes}:${String(whole).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}`;
}
