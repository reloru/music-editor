/**
 * Wires the DOM in `index.html` to the editor.
 *
 * This layer owns no audio state — it reads the editor after every change
 * event, and turns taps into editor commands.
 */
import { Editor, formatDuration, parseTimecode } from '../editor';
import { WaveformView } from './waveform';
import { exportAudio, type ExportFormat } from '../audio/export';
import { slice } from '../audio/dsp';
import { EFFECTS, formatParam, type EffectSpec, type ParamSpec } from '../audio/effect-registry';
import type { EffectValues } from '../audio/effects';
import type { Pcm } from '../audio/pcm';
import type { WavBitDepth } from '../audio/wav';
import { clearSnapshot, loadSnapshot, saveSnapshot } from '../storage/session';

/** How much of the selection an effect preview renders and plays. */
const PREVIEW_SECONDS = 8;

interface ServerConfig {
  sharing: boolean;
  maxShareBytes: number;
  shareTtlSeconds: number;
}

export class App {
  readonly editor = new Editor();
  readonly waveform: WaveformView;
  private readonly elements = queryElements();
  private config: ServerConfig = { sharing: false, maxShareBytes: 0, shareTtlSeconds: 0 };
  private toastTimer = 0;
  private animation = 0;
  private lastNotice: string | null = null;
  /** The effect whose parameter sheet is open, if any. */
  private activeEffect: EffectSpec | null = null;
  /** Per-effect settings, kept for the session so reopening resumes where you left off. */
  private readonly effectValues = new Map<string, EffectValues>();

  constructor() {
    this.waveform = new WaveformView(this.elements.canvas, this.editor);
    this.editor.subscribe(() => this.sync());

    this.bindFileInput();
    this.bindHistory();
    this.bindTransport();
    this.bindTools();
    this.bindReadout();
    this.bindSheets();
    this.bindEffects();
    this.bindKeyboard();
    this.bindLifecycle();
    this.bindAudioUnlock();

    this.sync();
    void this.loadConfig();
    void this.restoreSession();
  }

  // ------------------------------------------------------------------ binding

  private bindFileInput(): void {
    this.elements.fileInput.addEventListener('change', () => {
      const file = this.elements.fileInput.files?.[0];
      if (file) void this.openFile(file);
      // Reset so picking the same file twice still fires a change event.
      this.elements.fileInput.value = '';
    });

    // Desktop convenience; harmless on touch devices.
    document.addEventListener('dragover', (event) => event.preventDefault());
    document.addEventListener('drop', (event) => {
      event.preventDefault();
      const file = event.dataTransfer?.files?.[0];
      if (file) void this.openFile(file);
    });
  }

  private bindHistory(): void {
    this.elements.undo.addEventListener('click', () => this.editor.undo());
    this.elements.redo.addEventListener('click', () => this.editor.redo());
  }

  private bindTransport(): void {
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-action]')) {
      button.addEventListener('click', () => {
        switch (button.dataset.action) {
          case 'play':
            void this.editor.togglePlay();
            break;
          case 'stop':
            this.editor.stop();
            break;
          case 'loop':
            this.editor.toggleLoop();
            break;
          case 'zoom-in':
            this.editor.zoomBy(1.8, this.editor.playhead);
            break;
          case 'zoom-out':
            this.editor.zoomBy(1 / 1.8, this.editor.playhead);
            break;
          case 'zoom-fit':
            if (this.editor.hasSelection) this.editor.zoomToSelection();
            else this.editor.zoomToFit();
            break;
        }
      });
    }
  }

  private bindTools(): void {
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-command]')) {
      button.addEventListener('click', () => this.runCommand(button.dataset.command ?? ''));
    }
  }

  private runCommand(command: string): void {
    const editor = this.editor;
    switch (command) {
      case 'select-all':
        editor.selectAll();
        break;
      case 'trim':
        void editor.trimToSelection();
        break;
      case 'cut':
        void editor.cutSelection();
        break;
      case 'copy':
        editor.copySelection();
        break;
      case 'paste':
        void editor.paste();
        break;
      case 'delete':
        void editor.deleteSelection();
        break;
      case 'silence':
        void editor.silenceSelection();
        break;
      case 'fade-in':
        void editor.fadeIn();
        break;
      case 'fade-out':
        void editor.fadeOut();
        break;
      case 'normalize':
        void editor.normalize(-1);
        break;
      case 'reverse':
        void editor.reverse();
        break;
      case 'dc-offset':
        void editor.removeDcOffset();
        break;
      case 'gain':
        this.openGainSheet();
        break;
      case 'speed':
        this.openSpeedSheet();
        break;
      case 'effects':
        this.openEffectsSheet();
        break;
      case 'export':
        this.openExportSheet();
        break;
    }
  }

  /**
   * Makes the three positions in the readout typeable.
   *
   * Each field commits on Enter or blur and reverts on Escape. A field the user
   * has started typing into is left alone by `updateReadout` until it commits,
   * so the document can keep moving underneath — the playhead during playback,
   * the selection during a drag — without overwriting a half-finished entry.
   */
  private bindReadout(): void {
    const editor = this.editor;

    this.bindTimeField(this.elements.readoutPlayhead, (seconds) => {
      if (seconds == null) return false;
      editor.seekToSamples(editor.secondsToSamples(seconds));
      return true;
    });

    // With no selection yet, typing one end anchors the other at the nearest
    // end of the track, so a selection can be made entirely from the keyboard.
    this.bindTimeField(this.elements.readoutSelectionStart, (seconds) => {
      if (seconds == null) {
        editor.clearSelection();
        return true;
      }
      const end = editor.selection?.end ?? editor.totalSamples;
      editor.setSelection({ start: editor.secondsToSamples(seconds), end });
      return true;
    });

    this.bindTimeField(this.elements.readoutSelectionEnd, (seconds) => {
      if (seconds == null) {
        editor.clearSelection();
        return true;
      }
      const start = editor.selection?.start ?? 0;
      editor.setSelection({ start, end: editor.secondsToSamples(seconds) });
      return true;
    });

    // Touching the waveform dismisses the keyboard, and commits whatever was
    // typed, before the gesture underneath it begins. Capture phase on the
    // document so it runs ahead of the canvas's own pointerdown handler.
    document.addEventListener(
      'pointerdown',
      (event) => {
        const active = document.activeElement;
        if (active instanceof HTMLInputElement && active.dataset.timeField === 'true') {
          if (event.target !== active) active.blur();
        }
      },
      true,
    );
  }

  /**
   * `commit` receives the parsed position in seconds, or null when the field
   * was cleared, and reports whether it accepted the value. Anything that fails
   * to parse never reaches it.
   */
  private bindTimeField(input: HTMLInputElement, commit: (seconds: number | null) => boolean): void {
    input.addEventListener('input', () => {
      input.dataset.dirty = 'true';
    });

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        input.blur();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        delete input.dataset.dirty;
        input.blur();
      }
    });

    input.addEventListener('blur', () => {
      const edited = input.dataset.dirty === 'true';
      delete input.dataset.dirty;
      if (!edited) return;

      const text = input.value.trim();
      const seconds = text === '' ? null : parseTimecode(text);
      if (text !== '' && seconds == null) {
        this.showToast('Type a time like 1:23.45, or seconds like 83.45', 'error');
        // Nothing changed in the editor, so put the field back by hand.
        this.updateReadout();
        return;
      }
      // Clamping and inversion are the editor's job — `setSelection` normalises
      // a start typed past the end — so a rejected commit is not expected here.
      if (!commit(seconds)) this.updateReadout();
    });
  }

  private bindSheets(): void {
    const { gainSheet, gainSlider, gainValue, gainHint } = this.elements;
    gainSlider.addEventListener('input', () => {
      gainValue.textContent = `${Number(gainSlider.value) > 0 ? '+' : ''}${Number(gainSlider.value).toFixed(1)} dB`;
    });
    gainSheet.addEventListener('close', () => {
      if (gainSheet.returnValue === 'apply') void this.editor.applyGainDb(Number(gainSlider.value));
    });
    gainHint.textContent = '';

    const { speedSheet, speedSlider, speedValue } = this.elements;
    speedSlider.addEventListener('input', () => {
      speedValue.textContent = `${Number(speedSlider.value).toFixed(2)}×`;
    });
    speedSheet.addEventListener('close', () => {
      if (speedSheet.returnValue === 'apply') void this.editor.changeSpeed(Number(speedSlider.value));
    });

    const { exportSheet, exportFormat } = this.elements;
    exportFormat.addEventListener('change', () => this.syncExportSheet());
    exportSheet.addEventListener('close', () => {
      const mode = exportSheet.returnValue;
      if (mode === 'share' || mode === 'download' || mode === 'link') {
        void this.runExport(mode);
      }
    });
  }

  private bindKeyboard(): void {
    window.addEventListener('keydown', (event) => {
      if (event.target instanceof HTMLInputElement && event.target.type !== 'range') return;
      const meta = event.metaKey || event.ctrlKey;

      if (event.code === 'Space' && !meta) {
        event.preventDefault();
        void this.editor.togglePlay();
      } else if (meta && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) this.editor.redo();
        else this.editor.undo();
      } else if (meta && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        this.editor.selectAll();
      } else if (meta && event.key.toLowerCase() === 'c') {
        this.editor.copySelection();
      } else if (meta && event.key.toLowerCase() === 'x') {
        void this.editor.cutSelection();
      } else if (meta && event.key.toLowerCase() === 'v') {
        void this.editor.paste();
      } else if (event.key === 'Backspace' || event.key === 'Delete') {
        if (this.editor.hasSelection) {
          event.preventDefault();
          void this.editor.deleteSelection();
        }
      }
    });
  }

  private bindLifecycle(): void {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      this.waveform.refreshPalette();
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        void this.snapshot();
      } else {
        void this.editor.engine.resumeAfterInterruption();
      }
    });
    // `pagehide` is the one iOS reliably delivers when a tab is being discarded.
    window.addEventListener('pagehide', () => void this.snapshot());
  }

  /**
   * Starts the audio context on the first touch after it exists.
   *
   * Opening a file creates the context but deliberately does not resume it —
   * see `AudioEngine.acquireContext` for why awaiting that outside a gesture
   * hangs. So the context is left suspended, and this puts it into `running` on
   * the next tap anywhere, which means the transport is already live by the
   * time the user reaches the play button. It unsubscribes once that lands.
   */
  private bindAudioUnlock(): void {
    const unlock = (): void => {
      const context = this.editor.engine.context;
      if (!context) return;
      if (context.state === 'running') {
        document.removeEventListener('pointerdown', unlock, true);
        return;
      }
      void this.editor.engine.ensureContext();
    };
    document.addEventListener('pointerdown', unlock, true);
  }

  // -------------------------------------------------------------------- files

  private async openFile(file: File): Promise<void> {
    await this.editor.loadFile(file);
    if (this.editor.hasAudio) {
      this.editor.zoomToFit();
      void clearSnapshot();
    }
  }

  private async snapshot(): Promise<void> {
    if (!this.editor.pcm || !this.editor.dirty) return;
    await saveSnapshot(this.editor.pcm, this.editor.fileName || 'track.wav');
  }

  private async restoreSession(): Promise<void> {
    const snapshot = await loadSnapshot();
    if (!snapshot || this.editor.hasAudio) return;

    await this.editor.load(await snapshot.blob.arrayBuffer(), snapshot.name);
    if (this.editor.hasAudio) {
      this.editor.dirty = true;
      this.showToast(`Restored your last session (${snapshot.name})`, 'info');
    }
  }

  private async loadConfig(): Promise<void> {
    try {
      const response = await fetch('/api/config');
      if (!response.ok) return;
      this.config = (await response.json()) as ServerConfig;
      this.elements.exportLink.hidden = !this.config.sharing;
    } catch {
      // Offline, or running from `vite dev` without the Worker: sharing stays off.
    }
  }

  // ------------------------------------------------------------------- sheets

  private openGainSheet(): void {
    if (!this.editor.hasAudio) return;
    this.elements.gainHint.textContent = this.editor.hasSelection
      ? 'Applies to the selection.'
      : 'Applies to the whole track.';
    this.elements.gainSlider.value = '0';
    this.elements.gainValue.textContent = '0.0 dB';
    this.elements.gainSheet.showModal();
  }

  private openSpeedSheet(): void {
    if (!this.editor.hasAudio) return;
    this.elements.speedSlider.value = '1';
    this.elements.speedValue.textContent = '1.00×';
    this.elements.speedSheet.showModal();
  }

  // ------------------------------------------------------------------ effects

  private bindEffects(): void {
    const { effectsList, effectSheet, effectPreview, effectReset } = this.elements;

    // One row per registry entry, built once. Availability is re-evaluated
    // every time the list opens, since it depends on the loaded track.
    for (const spec of EFFECTS) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'effect-list__item';
      row.dataset.effect = spec.id;

      const name = document.createElement('span');
      name.className = 'effect-list__name';
      name.textContent = spec.label;
      const hint = document.createElement('span');
      hint.className = 'effect-list__hint';
      hint.textContent = spec.hint;
      row.append(name, hint);

      row.addEventListener('click', () => {
        this.elements.effectsSheet.close('picked');
        this.openEffectSheet(spec);
      });
      effectsList.append(row);
    }

    effectPreview.addEventListener('click', () => void this.toggleEffectPreview());
    effectReset.addEventListener('click', () => {
      if (!this.activeEffect) return;
      this.effectValues.delete(this.activeEffect.id);
      this.renderEffectControls(this.activeEffect);
    });

    effectSheet.addEventListener('close', () => {
      this.editor.stopPreview();
      const spec = this.activeEffect;
      this.activeEffect = null;
      if (spec && effectSheet.returnValue === 'apply') {
        void this.editor.applyEffect(spec, this.valuesFor(spec));
      }
    });

    this.editor.engine.onPreviewEnd = () => this.syncPreviewButton();
  }

  private openEffectsSheet(): void {
    if (!this.editor.hasAudio) return;
    const stereo = this.editor.channels === 2;

    this.elements.effectsScope.textContent = this.editor.hasSelection
      ? 'Applies to the selection.'
      : 'Applies to the whole track.';

    for (const row of this.elements.effectsList.querySelectorAll<HTMLButtonElement>('[data-effect]')) {
      const spec = EFFECTS.find((entry) => entry.id === row.dataset.effect);
      const blocked = Boolean(spec?.stereoOnly) && !stereo;
      row.disabled = blocked;
      const hint = row.querySelector('.effect-list__hint');
      if (hint && spec) hint.textContent = blocked ? 'Needs a stereo track.' : spec.hint;
    }

    this.elements.effectsSheet.showModal();
  }

  private openEffectSheet(spec: EffectSpec): void {
    this.activeEffect = spec;
    this.elements.effectTitle.textContent = spec.label;
    this.elements.effectHint.textContent = spec.hint;
    this.renderEffectControls(spec);
    this.syncPreviewButton();
    this.elements.effectSheet.showModal();
  }

  /** The working values for `spec`: what was last dialled in, or its defaults. */
  private valuesFor(spec: EffectSpec): EffectValues {
    return this.effectValues.get(spec.id) ?? spec.defaults;
  }

  private setValue(spec: EffectSpec, key: string, value: number): void {
    this.effectValues.set(spec.id, { ...this.valuesFor(spec), [key]: value });
    this.syncParamVisibility(spec);
  }

  private renderEffectControls(spec: EffectSpec): void {
    const host = this.elements.effectControls;
    host.textContent = '';
    const values = this.valuesFor(spec);
    for (const param of spec.params) {
      host.append(this.buildParamControl(spec, param, values[param.key]));
    }
    this.syncParamVisibility(spec);
  }

  /**
   * Shows or hides the controls a setting makes inert.
   *
   * Toggling `hidden` rather than re-rendering, because this runs on every
   * `input` event: rebuilding the list would tear out the slider under the
   * finger that is moving it.
   */
  private syncParamVisibility(spec: EffectSpec): void {
    const values = this.valuesFor(spec);
    for (const param of spec.params) {
      if (!param.visibleWhen) continue;
      const control = this.elements.effectControls.querySelector<HTMLElement>(
        `[data-param="${param.key}"]`,
      );
      if (control) control.hidden = !param.visibleWhen(values);
    }
  }

  private buildParamControl(spec: EffectSpec, param: ParamSpec, value: number): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'effect-param';
    wrapper.dataset.param = param.key;

    if (param.kind === 'slider') {
      const head = document.createElement('div');
      head.className = 'effect-param__head';
      const label = document.createElement('label');
      label.className = 'effect-param__label';
      label.htmlFor = `param-${spec.id}-${param.key}`;
      label.textContent = param.label;
      const readout = document.createElement('output');
      readout.className = 'effect-param__value';
      readout.textContent = formatParam(param, value);
      head.append(label, readout);

      const input = document.createElement('input');
      input.id = label.htmlFor;
      input.className = 'slider';
      input.type = 'range';
      input.min = String(param.min);
      input.max = String(param.max);
      input.step = String(param.step);
      input.value = String(value);
      input.addEventListener('input', () => {
        const next = Number(input.value);
        readout.textContent = formatParam(param, next);
        this.setValue(spec, param.key, next);
      });

      wrapper.append(head, input);
      return wrapper;
    }

    // Toggles and choices are both a segmented control; a toggle is the
    // two-option case, which keeps one styling path instead of two.
    const options = param.kind === 'toggle' ? ['Off', 'On'] : param.options;
    const fieldset = document.createElement('fieldset');
    fieldset.className = 'segmented';
    const legend = document.createElement('legend');
    legend.className = 'sheet__label';
    legend.textContent = param.label;
    fieldset.append(legend);

    options.forEach((option, index) => {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = `param-${spec.id}-${param.key}`;
      input.value = String(index);
      input.checked = Math.round(value) === index;
      input.addEventListener('change', () => {
        if (input.checked) this.setValue(spec, param.key, index);
      });
      const text = document.createElement('span');
      text.textContent = option;
      label.append(input, text);
      fieldset.append(label);
    });

    wrapper.append(fieldset);
    return wrapper;
  }

  private async toggleEffectPreview(): Promise<void> {
    const spec = this.activeEffect;
    if (!spec) return;

    if (this.editor.engine.isPreviewing) {
      this.editor.stopPreview();
      this.syncPreviewButton();
      return;
    }

    // The busy overlay lives under the modal, so the button itself has to say
    // that work is happening.
    this.elements.effectPreview.disabled = true;
    this.elements.effectPreview.textContent = 'Rendering…';
    try {
      await this.editor.previewEffect(spec, this.valuesFor(spec), PREVIEW_SECONDS);
    } catch (error) {
      this.showToast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      this.elements.effectPreview.disabled = false;
      this.syncPreviewButton();
    }
  }

  private syncPreviewButton(): void {
    const playing = this.editor.engine.isPreviewing;
    setText(this.elements.effectPreview, playing ? 'Stop preview' : 'Preview');
  }

  private openExportSheet(): void {
    if (!this.editor.hasAudio) return;
    this.elements.exportScopeSelection.disabled = !this.editor.hasSelection;
    if (!this.editor.hasSelection) this.elements.exportScopeAll.checked = true;
    this.syncExportSheet();
    this.elements.exportSheet.showModal();
  }

  private syncExportSheet(): void {
    const format = this.selectedFormat();
    this.elements.exportBitrate.hidden = format !== 'mp3';
    this.elements.exportDepth.hidden = format !== 'wav';

    const seconds = this.exportSeconds();
    const estimate =
      format === 'mp3'
        ? (seconds * this.selectedBitrate() * 1000) / 8
        : seconds * this.editor.sampleRate * this.editor.channels * (this.selectedDepth() / 8);
    this.elements.exportHint.textContent = `${formatDuration(seconds)} · about ${formatBytes(estimate)}`;
  }

  // ------------------------------------------------------------------- export

  private async runExport(mode: 'share' | 'download' | 'link'): Promise<void> {
    const source = this.exportSource();
    if (!source) return;

    const format = this.selectedFormat();
    const result = await this.editor.runTask(
      format === 'mp3' ? 'Encoding MP3' : 'Writing WAV',
      async () =>
        exportAudio(source, {
          format,
          bitrate: this.selectedBitrate(),
          bitDepth: this.selectedDepth(),
          onProgress: (value) => this.editor.setProgress(value),
        }),
    );
    if (!result) return;

    const filename = this.exportFilename(result.extension);
    if (mode === 'link') {
      await this.createShareLink(result.blob, filename);
      return;
    }

    const file = new File([result.blob], filename, { type: result.mimeType });
    const canShareFile =
      mode === 'share' && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });

    if (canShareFile) {
      try {
        await navigator.share({ files: [file], title: filename });
        return;
      } catch (error) {
        // A cancelled share sheet is not a failure; anything else falls back to
        // a plain download so the export is never lost.
        if (error instanceof DOMException && error.name === 'AbortError') return;
      }
    }
    downloadBlob(result.blob, filename);
    this.showToast(`Saved ${filename}`, 'info');
  }

  private async createShareLink(blob: Blob, filename: string): Promise<void> {
    if (blob.size > this.config.maxShareBytes) {
      this.showToast(`Too big to link (limit ${formatBytes(this.config.maxShareBytes)})`, 'error');
      return;
    }

    const result = await this.editor.runTask('Uploading', async () => {
      const response = await fetch('/api/share', {
        method: 'POST',
        headers: { 'content-type': blob.type, 'x-filename': filename },
        body: blob,
      });
      if (!response.ok) {
        const detail = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(detail?.message ?? `Upload failed (${response.status})`);
      }
      return (await response.json()) as { url: string; expiresAt: string };
    });
    if (!result) return;

    const url = new URL(result.url, location.origin).toString();
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ url, title: filename });
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
      }
    }
    await navigator.clipboard?.writeText(url).catch(() => undefined);
    this.showToast('Link copied to clipboard', 'info');
  }

  private exportSource(): Pcm | null {
    if (!this.editor.pcm) return null;
    const selectionOnly = this.elements.exportScopeSelection.checked && this.editor.hasSelection;
    return selectionOnly ? slice(this.editor.pcm, this.editor.effectiveRange) : this.editor.pcm;
  }

  private exportSeconds(): number {
    const selectionOnly = this.elements.exportScopeSelection.checked && this.editor.hasSelection;
    if (!selectionOnly) return this.editor.durationSeconds;
    const range = this.editor.effectiveRange;
    return this.editor.samplesToSeconds(range.end - range.start);
  }

  private exportFilename(extension: string): string {
    const base = (this.editor.fileName || 'track').replace(/\.[^.]+$/, '').slice(0, 60) || 'track';
    return `${base}-edit.${extension}`;
  }

  private selectedFormat(): ExportFormat {
    const checked = this.elements.exportSheet.querySelector<HTMLInputElement>(
      'input[name="format"]:checked',
    );
    return checked?.value === 'wav' ? 'wav' : 'mp3';
  }

  private selectedBitrate(): number {
    const checked = this.elements.exportSheet.querySelector<HTMLInputElement>(
      'input[name="bitrate"]:checked',
    );
    return Number(checked?.value ?? 192);
  }

  private selectedDepth(): WavBitDepth {
    const checked = this.elements.exportSheet.querySelector<HTMLInputElement>(
      'input[name="depth"]:checked',
    );
    const value = Number(checked?.value ?? 16);
    return value === 24 ? 24 : value === 32 ? 32 : 16;
  }

  // --------------------------------------------------------------- rendering

  /**
   * Pushes editor state into the DOM.
   *
   * Every write goes through `setText` / `setFlag`, which compare before
   * assigning. This runs on every `pointermove` of a selection drag — the editor
   * emits a change for each one — and assigning `textContent` or `disabled`
   * unconditionally invalidates style and layout for that element even when the
   * value is identical, which put a dozen avoidable layout invalidations inside
   * every drag frame.
   */
  private sync(): void {
    const editor = this.editor;
    const has = editor.hasAudio;

    const empty = String(!has);
    if (this.elements.app.dataset.empty !== empty) this.elements.app.dataset.empty = empty;
    setText(this.elements.trackName, editor.fileName || 'No track loaded');
    setText(
      this.elements.trackMeta,
      has
        ? `${describeChannels(editor.channels)} · ${(editor.sampleRate / 1000).toFixed(1)} kHz · ${formatDuration(editor.durationSeconds)}`
        : '',
    );

    setFlag(this.elements.undo, !editor.canUndo);
    setFlag(this.elements.redo, !editor.canRedo);
    setAttr(this.elements.undo, 'title', editor.undoLabel ? `Undo ${editor.undoLabel}` : 'Undo');
    setAttr(this.elements.redo, 'title', editor.redoLabel ? `Redo ${editor.redoLabel}` : 'Redo');

    setText(this.elements.play, editor.playing ? '❚❚' : '▶');
    setAttr(this.elements.play, 'aria-label', editor.playing ? 'Pause' : 'Play');
    setAttr(this.elements.loop, 'aria-pressed', String(editor.loop));

    for (const button of this.elements.tools) {
      const command = button.dataset.command ?? '';
      setFlag(button, !has || !this.isCommandAvailable(command));
    }

    this.updateReadout();
    this.updateBusy();
    this.updateNotice();
    this.waveform.requestRender();
    this.updateAnimation();
  }

  private isCommandAvailable(command: string): boolean {
    switch (command) {
      case 'trim':
      case 'cut':
      case 'copy':
      case 'delete':
        return this.editor.hasSelection;
      case 'paste':
        return this.editor.clipboard != null;
      default:
        return true;
    }
  }

  private updateReadout(): void {
    const editor = this.editor;
    setField(this.elements.readoutPlayhead, formatDuration(editor.samplesToSeconds(editor.playhead)));
    setText(this.elements.readoutDuration, formatDuration(editor.durationSeconds));

    // Empty rather than a dash when nothing is selected: the placeholder draws
    // the dash, and an empty field is what the commit handler reads as "clear".
    const selection = editor.hasSelection ? editor.selection : null;
    setField(
      this.elements.readoutSelectionStart,
      selection ? formatDuration(editor.samplesToSeconds(selection.start)) : '',
    );
    setField(
      this.elements.readoutSelectionEnd,
      selection ? formatDuration(editor.samplesToSeconds(selection.end)) : '',
    );
  }

  private updateBusy(): void {
    const busy = this.editor.busy;
    this.elements.busy.hidden = busy == null;
    if (!busy) return;
    this.elements.busyLabel.textContent = busy.label;
    if (busy.progress == null) {
      this.elements.busyBar.dataset.indeterminate = 'true';
      this.elements.busyBar.style.width = '';
    } else {
      delete this.elements.busyBar.dataset.indeterminate;
      this.elements.busyBar.style.width = `${Math.round(busy.progress * 100)}%`;
    }
  }

  private updateNotice(): void {
    const notice = this.editor.notice;
    if (!notice) {
      this.lastNotice = null;
      return;
    }
    const key = `${notice.kind}:${notice.text}`;
    if (key === this.lastNotice) return;
    this.lastNotice = key;
    this.showToast(notice.text, notice.kind);
  }

  private showToast(text: string, kind: 'info' | 'error'): void {
    const toast = this.elements.toast;
    toast.textContent = text;
    toast.dataset.kind = kind;
    toast.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      toast.hidden = true;
    }, kind === 'error' ? 3600 : 2200);
  }

  /** Repaints on every frame while the transport is running, and only then. */
  private updateAnimation(): void {
    if (this.editor.playing && this.animation === 0) {
      const tick = (): void => {
        if (!this.editor.playing) {
          this.animation = 0;
          return;
        }
        this.editor.followPlayhead();
        this.waveform.render();
        this.updateReadout();
        this.animation = requestAnimationFrame(tick);
      };
      this.animation = requestAnimationFrame(tick);
    } else if (!this.editor.playing && this.animation !== 0) {
      cancelAnimationFrame(this.animation);
      this.animation = 0;
    }
  }
}

// ----------------------------------------------------------------- utilities

function setText(element: HTMLElement, value: string): void {
  if (element.textContent !== value) element.textContent = value;
}

/**
 * Writes a readout field, unless the user is mid-edit in it.
 *
 * Focus alone is not the guard — you can tap a field, then drag the waveform,
 * and the field should follow the drag. Only an actual keystroke sets `dirty`,
 * and committing or reverting clears it.
 */
function setField(input: HTMLInputElement, value: string): void {
  if (input.dataset.dirty === 'true') return;
  if (input.value !== value) input.value = value;
}

function setFlag(element: HTMLButtonElement, disabled: boolean): void {
  if (element.disabled !== disabled) element.disabled = disabled;
}

function setAttr(element: HTMLElement, name: string, value: string): void {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

function queryElements() {
  const need = <T extends Element>(selector: string): T => {
    const element = document.querySelector<T>(selector);
    if (!element) throw new Error(`Missing element: ${selector}`);
    return element;
  };

  return {
    app: need<HTMLElement>('#app'),
    canvas: need<HTMLCanvasElement>('#waveform'),
    fileInput: need<HTMLInputElement>('#file-input'),
    trackName: need<HTMLElement>('#track-name'),
    trackMeta: need<HTMLElement>('#track-meta'),
    undo: need<HTMLButtonElement>('#undo'),
    redo: need<HTMLButtonElement>('#redo'),
    play: need<HTMLButtonElement>('[data-action="play"]'),
    loop: need<HTMLButtonElement>('[data-action="loop"]'),
    tools: Array.from(document.querySelectorAll<HTMLButtonElement>('.tool')),
    readoutPlayhead: need<HTMLInputElement>('#readout-playhead'),
    readoutSelectionStart: need<HTMLInputElement>('#readout-selection-start'),
    readoutSelectionEnd: need<HTMLInputElement>('#readout-selection-end'),
    readoutDuration: need<HTMLElement>('#readout-duration'),
    busy: need<HTMLElement>('#busy'),
    busyLabel: need<HTMLElement>('#busy-label'),
    busyBar: need<HTMLElement>('#busy-bar'),
    toast: need<HTMLElement>('#toast'),
    gainSheet: need<HTMLDialogElement>('#gain-sheet'),
    gainSlider: need<HTMLInputElement>('#gain-slider'),
    gainValue: need<HTMLElement>('#gain-value'),
    gainHint: need<HTMLElement>('#gain-hint'),
    speedSheet: need<HTMLDialogElement>('#speed-sheet'),
    speedSlider: need<HTMLInputElement>('#speed-slider'),
    speedValue: need<HTMLElement>('#speed-value'),
    effectsSheet: need<HTMLDialogElement>('#effects-sheet'),
    effectsList: need<HTMLElement>('#effects-list'),
    effectsScope: need<HTMLElement>('#effects-scope'),
    effectSheet: need<HTMLDialogElement>('#effect-sheet'),
    effectTitle: need<HTMLElement>('#effect-title'),
    effectHint: need<HTMLElement>('#effect-hint'),
    effectControls: need<HTMLElement>('#effect-controls'),
    effectPreview: need<HTMLButtonElement>('#effect-preview'),
    effectReset: need<HTMLButtonElement>('#effect-reset'),
    exportSheet: need<HTMLDialogElement>('#export-sheet'),
    exportFormat: need<HTMLElement>('#export-format'),
    exportBitrate: need<HTMLElement>('#export-bitrate'),
    exportDepth: need<HTMLElement>('#export-depth'),
    exportHint: need<HTMLElement>('#export-hint'),
    exportLink: need<HTMLButtonElement>('#export-link'),
    exportScopeAll: need<HTMLInputElement>('input[name="scope"][value="all"]'),
    exportScopeSelection: need<HTMLInputElement>('input[name="scope"][value="selection"]'),
  };
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Safari needs the URL to outlive the click by a moment.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function describeChannels(count: number): string {
  if (count === 1) return 'Mono';
  if (count === 2) return 'Stereo';
  return `${count} channels`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
