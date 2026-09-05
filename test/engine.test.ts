/**
 * `AudioEngine`'s handling of Safari's non-standard `interrupted` context
 * state — see the comment on `ensureContext` for the sourcing (WebKit bug
 * 263627, and open issues against both the Web Audio spec and Tone.js).
 *
 * The bug this pins: gating a resume attempt on `state === 'suspended'`
 * silently skips it whenever the browser reports `interrupted` instead,
 * which is exactly the state Safari uses after the kind of interruption a
 * long-running synchronous task invites. `resumeAfterInterruption` exists
 * specifically to recover from that, so a stub that never leaves
 * `interrupted` is the direct way to prove the gate no longer excludes it.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { AudioEngine } from '../src/audio/engine';

class StubAudioBuffer {
  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {}
  get duration(): number {
    return this.length / this.sampleRate;
  }
  getChannelData(): Float32Array {
    return new Float32Array(this.length);
  }
}

/** A context stuck in Safari's `interrupted` state; `resume()` fixes it, if called. */
class InterruptedAudioContext {
  state: 'interrupted' | 'running' = 'interrupted';
  readonly sampleRate = 44100;
  readonly currentTime = 0;
  readonly destination = {};
  resumeCalls = 0;

  createBuffer(channels: number, length: number, sampleRate: number): StubAudioBuffer {
    return new StubAudioBuffer(channels, length, sampleRate);
  }
  createGain() {
    return { gain: { setTargetAtTime() {} }, connect() {} };
  }
  createBufferSource() {
    return { buffer: null, connect() {}, start() {}, stop() {}, disconnect() {} };
  }
  async resume(): Promise<void> {
    this.resumeCalls++;
    this.state = 'running';
  }
}

beforeAll(() => {
  const globals = globalThis as Record<string, unknown>;
  globals.requestAnimationFrame = (callback: (time: number) => void) => {
    queueMicrotask(() => callback(0));
    return 0;
  };
});

function setup(): { engine: AudioEngine; stub: InterruptedAudioContext } {
  (globalThis as Record<string, unknown>).window = { AudioContext: InterruptedAudioContext };
  const engine = new AudioEngine();
  const stub = engine.acquireContext() as unknown as InterruptedAudioContext;
  return { engine, stub };
}

describe('AudioEngine and the Safari `interrupted` state', () => {
  it('ensureContext resumes a context reporting `interrupted`, not just `suspended`', async () => {
    const { engine, stub } = setup();
    expect(stub.state).toBe('interrupted');

    await engine.ensureContext();

    expect(stub.resumeCalls, 'resume() was never called for an interrupted context').toBe(1);
    expect(stub.state).toBe('running');
  });

  it('resumeAfterInterruption resumes an `interrupted` context while playback was active', async () => {
    const { engine, stub } = setup();

    // Simulate the engine believing it is mid-playback when the interruption
    // hit, without needing a full play() call (which needs a real buffer).
    (engine as unknown as { state: string }).state = 'playing';

    await engine.resumeAfterInterruption();

    expect(stub.resumeCalls, 'resume() was never called for an interrupted context').toBe(1);
    expect(stub.state).toBe('running');
  });

  it('resumeAfterInterruption does nothing while stopped, interrupted or not', async () => {
    const { engine, stub } = setup();

    await engine.resumeAfterInterruption();

    expect(stub.resumeCalls).toBe(0);
  });
});
