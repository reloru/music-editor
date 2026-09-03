/**
 * Opening a file must not depend on the audio context being allowed to start.
 *
 * The Web Audio API's `resume()` algorithm appends the promise to
 * `[[pending resume promises]]` and aborts the remaining steps when the context
 * is "not allowed to start" — outside a user gesture on iOS — so it settles
 * neither way until a gesture arrives. `Editor.load` used to await that, which
 * left the "Opening…" overlay up until the user tapped Open a second time; that
 * tap was the gesture, so the second attempt then completed instantly.
 *
 * `StuckAudioContext` below reproduces exactly that: a context whose `resume()`
 * never settles. A load that completes against it is a load that does not
 * depend on the gesture.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { Editor } from '../src/editor';
import { createPcm } from '../src/audio/pcm';
import { encodeWav } from '../src/audio/wav';

const RATE = 44100;
const FRAMES = 4410;

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

let resumeCalls = 0;

class StuckAudioContext {
  readonly sampleRate = RATE;
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

  async decodeAudioData(): Promise<StubAudioBuffer> {
    return new StubAudioBuffer(2, FRAMES, RATE);
  }

  /** Never settles, exactly as the spec permits when the context may not start. */
  resume(): Promise<void> {
    resumeCalls++;
    return new Promise<void>(() => {});
  }
}

beforeAll(() => {
  const globals = globalThis as Record<string, unknown>;
  globals.window = { AudioContext: StuckAudioContext };
  if (!globals.navigator) globals.navigator = {};
  // Deliberately never invoked, so a `runTask` that waits only on a frame would
  // hang the way it does behind the iOS file picker sheet. The timer in
  // `nextFrame` is what has to carry it.
  globals.requestAnimationFrame = () => 0;
});

function wavBytes(): ArrayBuffer {
  const pcm = createPcm(2, FRAMES, RATE);
  for (let i = 0; i < FRAMES; i++) {
    pcm.channels[0][i] = Math.sin((2 * Math.PI * 440 * i) / RATE) * 0.5;
    pcm.channels[1][i] = pcm.channels[0][i];
  }
  return encodeWav(pcm, 16);
}

describe('Editor.load', () => {
  it('completes while the audio context is stuck suspended', async () => {
    resumeCalls = 0;
    const editor = new Editor();

    // The real failure was a promise that never settles, so a test that simply
    // awaits would hang the suite rather than fail it. Race it.
    const finished = await Promise.race([
      editor.load(wavBytes(), 'stuck.wav').then(() => 'loaded' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 2000)),
    ]);

    expect(finished).toBe('loaded');
    expect(editor.hasAudio).toBe(true);
    expect(editor.fileName).toBe('stuck.wav');
    expect(editor.totalSamples).toBe(FRAMES);
    expect(editor.busy).toBeNull();
    expect(editor.notice).toBeNull();
  });

  it('does not try to start the context to read a file', async () => {
    resumeCalls = 0;
    const editor = new Editor();
    await editor.load(wavBytes(), 'stuck.wav');
    expect(resumeCalls).toBe(0);
  });

  it('reports an undecodable file rather than hanging on it', async () => {
    const editor = new Editor();
    const junk = new TextEncoder().encode('this is definitely not audio');
    class FailingContext extends StuckAudioContext {
      override async decodeAudioData(): Promise<StubAudioBuffer> {
        throw new Error('Unable to decode audio data');
      }
    }
    (globalThis as Record<string, unknown>).window = { AudioContext: FailingContext };

    await editor.load(junk.buffer as ArrayBuffer, 'broken.mp3');

    expect(editor.hasAudio).toBe(false);
    expect(editor.busy).toBeNull();
    expect(editor.notice?.kind).toBe('error');

    (globalThis as Record<string, unknown>).window = { AudioContext: StuckAudioContext };
  });
});
