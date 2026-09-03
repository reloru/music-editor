/**
 * Undo restores the whole document position, not just the audio.
 *
 * These run against the real `Editor`, so the Web Audio surface it touches on
 * every edit has to exist. The stubs below are the smallest thing that
 * satisfies it: `Editor.setPcm` builds an `AudioBuffer` for the playback engine,
 * and `runTask` yields a frame before doing work. Neither is under test here, so
 * both are inert.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { Editor } from '../src/editor';
import type { Pcm } from '../src/audio/pcm';

class StubAudioBuffer {
  private readonly data: Float32Array[];

  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    this.data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }

  get duration(): number {
    return this.length / this.sampleRate;
  }

  getChannelData(index: number): Float32Array {
    return this.data[index];
  }
}

class StubAudioContext {
  readonly sampleRate = 48000;
  readonly currentTime = 0;
  readonly state = 'suspended';
  readonly destination = {};

  createBuffer(channels: number, length: number, sampleRate: number): StubAudioBuffer {
    return new StubAudioBuffer(channels, length, sampleRate);
  }

  createGain() {
    return { gain: { setTargetAtTime() {} }, connect() {} };
  }

  createBufferSource() {
    return { buffer: null, connect() {}, start() {}, stop() {}, disconnect() {} };
  }

  async resume(): Promise<void> {}
}

beforeAll(() => {
  const globals = globalThis as Record<string, unknown>;
  globals.window = { AudioContext: StubAudioContext };
  if (!globals.navigator) globals.navigator = {};
  globals.requestAnimationFrame = (callback: (time: number) => void) => {
    queueMicrotask(() => callback(0));
    return 0;
  };
});

const RATE = 48000;

/** A ramp, so a spliced buffer can be checked for which samples survived. */
function makePcm(frames: number, channels = 2): Pcm {
  return {
    sampleRate: RATE,
    channels: Array.from({ length: channels }, (_unused, channel) =>
      Float32Array.from({ length: frames }, (_ignored, i) => (i / frames) * (channel === 0 ? 1 : -1)),
    ),
  };
}

/**
 * Puts a document into an editor without going through file decoding, then
 * gives it a selection, a playhead and a zoomed-in viewport — the state a user
 * is in when they reach for undo.
 */
function loadedEditor(frames = 10000): Editor {
  const editor = new Editor();
  editor.pcm = makePcm(frames);
  editor.view = { start: 0, end: frames };
  return editor;
}

describe('Editor undo', () => {
  it('brings the selection back after a delete', () => {
    const editor = loadedEditor();
    editor.setSelection({ start: 2000, end: 3000 });
    editor.playhead = 2500;

    return editor.deleteSelection().then(() => {
      // The edit itself clears the selection: the samples it referred to are gone.
      expect(editor.selection).toBeNull();
      expect(editor.totalSamples).toBe(9000);

      editor.undo();

      expect(editor.totalSamples).toBe(10000);
      expect(editor.selection).toEqual({ start: 2000, end: 3000 });
      expect(editor.playhead).toBe(2500);
    });
  });

  it('brings the selection back after a trim', async () => {
    const editor = loadedEditor();
    editor.setSelection({ start: 4000, end: 6000 });
    editor.playhead = 5000;

    await editor.trimToSelection();
    expect(editor.selection).toBeNull();
    expect(editor.totalSamples).toBe(2000);

    editor.undo();

    expect(editor.totalSamples).toBe(10000);
    expect(editor.selection).toEqual({ start: 4000, end: 6000 });
    expect(editor.playhead).toBe(5000);
  });

  it('brings the selection back after a cut', async () => {
    const editor = loadedEditor();
    editor.setSelection({ start: 100, end: 900 });

    await editor.cutSelection();
    expect(editor.selection).toBeNull();

    editor.undo();
    expect(editor.selection).toEqual({ start: 100, end: 900 });
  });

  it('restores the viewport, so undo does not also lose the user their place', async () => {
    const editor = loadedEditor();
    editor.setView(6000, 6500);
    editor.setSelection({ start: 6100, end: 6200 });
    const view = { ...editor.view };

    await editor.deleteSelection();
    editor.undo();

    expect(editor.view).toEqual(view);
    expect(editor.selection).toEqual({ start: 6100, end: 6200 });
  });

  it('leaves a selection alone for edits that do not move samples', async () => {
    const editor = loadedEditor();
    editor.setSelection({ start: 1000, end: 2000 });

    await editor.fadeIn();
    expect(editor.selection).toEqual({ start: 1000, end: 2000 });

    editor.undo();
    expect(editor.selection).toEqual({ start: 1000, end: 2000 });
  });

  it('walks a multi-edit stack back through each selection in turn', async () => {
    const editor = loadedEditor();

    editor.setSelection({ start: 1000, end: 2000 });
    await editor.deleteSelection();
    editor.setSelection({ start: 3000, end: 3500 });
    await editor.deleteSelection();

    editor.undo();
    expect(editor.selection).toEqual({ start: 3000, end: 3500 });
    expect(editor.totalSamples).toBe(9000);

    editor.undo();
    expect(editor.selection).toEqual({ start: 1000, end: 2000 });
    expect(editor.totalSamples).toBe(10000);
  });

  it('redoes back to the post-edit position', async () => {
    const editor = loadedEditor();
    editor.setSelection({ start: 2000, end: 3000 });
    await editor.deleteSelection();
    editor.undo();

    expect(editor.canRedo).toBe(true);
    editor.redo();

    expect(editor.totalSamples).toBe(9000);
    expect(editor.selection).toBeNull();
  });

  it('clamps a restored selection onto a buffer that cannot hold it', async () => {
    const editor = loadedEditor();
    editor.setSelection({ start: 8000, end: 9500 });
    await editor.trimToSelection();
    editor.undo();
    // Redo returns to the 1500-sample trim result while the stored selection
    // refers to offsets in the 10000-sample original.
    editor.redo();

    expect(editor.totalSamples).toBe(1500);
    expect(editor.selection).toBeNull();
    expect(editor.playhead).toBeLessThanOrEqual(1500);
    expect(editor.view.end).toBeLessThanOrEqual(1500);
  });

  it('never restores a viewport wider than the buffer or narrower than the floor', async () => {
    const editor = loadedEditor();
    editor.setSelection({ start: 0, end: 200 });
    editor.setView(0, 200);

    await editor.deleteSelection();
    editor.undo();

    expect(editor.view.start).toBeGreaterThanOrEqual(0);
    expect(editor.view.end).toBeLessThanOrEqual(editor.totalSamples);
    expect(editor.view.end - editor.view.start).toBeGreaterThan(0);
  });

  it('does nothing when there is no history', () => {
    const editor = loadedEditor();
    expect(editor.canUndo).toBe(false);
    editor.undo();
    expect(editor.totalSamples).toBe(10000);
  });

  it('does not snapshot a document it does not have', () => {
    const editor = new Editor();
    expect(() => editor.undo()).not.toThrow();
    expect(() => editor.redo()).not.toThrow();
  });

  it('accounts for the retained audio, not just the entry count', async () => {
    const editor = loadedEditor();
    expect(editor.historyBytes).toBe(0);

    editor.setSelection({ start: 0, end: 100 });
    await editor.fadeIn();

    // One snapshot of a 10000-frame stereo float buffer.
    expect(editor.historyBytes).toBe(10000 * 2 * 4);
  });

  it('invalidates the render cache when the document is dropped', () => {
    const editor = loadedEditor();
    const before = editor.revision;
    editor.close();
    expect(editor.revision).toBeGreaterThan(before);
    expect(editor.pcm).toBeNull();
  });

  it('advances the revision on every edit, so a cached waveform cannot go stale', async () => {
    const editor = loadedEditor();
    const before = editor.revision;

    editor.setSelection({ start: 0, end: 500 });
    await editor.reverse();
    const afterEdit = editor.revision;
    expect(afterEdit).toBeGreaterThan(before);

    editor.undo();
    expect(editor.revision).toBeGreaterThan(afterEdit);
  });
});
