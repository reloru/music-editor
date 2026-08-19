/**
 * Playback.
 *
 * Web Audio has no notion of a transport, so this class keeps one: it maps the
 * context clock onto a position inside the buffer, and rebuilds the (one-shot)
 * source node on every start. The iOS-specific handling — creating the context
 * lazily, resuming it after an interruption, and declaring a playback audio
 * session so the ring/silent switch does not mute the editor — lives here too.
 */
import type { Pcm } from './pcm';
import { toAudioBuffer } from './decode';

export type EngineState = 'stopped' | 'playing';

export interface PlayOptions {
  from: number;
  to?: number | null;
  loop?: boolean;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private source: AudioBufferSourceNode | null = null;
  private buffer: AudioBuffer | null = null;

  private startedAt = 0;
  private startOffset = 0;
  private loopRegion: { start: number; end: number } | null = null;
  private state: EngineState = 'stopped';
  private pausedAt = 0;

  onStateChange: ((state: EngineState) => void) | null = null;

  /**
   * Creates the AudioContext. iOS only lets a context leave the `suspended`
   * state inside a user gesture, so every play path calls this first.
   */
  async ensureContext(): Promise<AudioContext> {
    const ctx = this.createContextIfNeeded();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
    return ctx;
  }

  private createContextIfNeeded(): AudioContext {
    if (!this.ctx) {
      const Ctor: typeof AudioContext =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor({ latencyHint: 'interactive' });
      this.gain = this.ctx.createGain();
      this.gain.connect(this.ctx.destination);
      configureAudioSession();
    }
    return this.ctx;
  }

  get context(): AudioContext | null {
    return this.ctx;
  }

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 48000;
  }

  get isPlaying(): boolean {
    return this.state === 'playing';
  }

  get duration(): number {
    return this.buffer?.duration ?? 0;
  }

  /** Swaps in freshly edited audio, keeping the playhead where it was. */
  setPcm(pcm: Pcm | null): void {
    const wasPlaying = this.state === 'playing';
    const position = this.currentTime;
    this.pause();

    if (!pcm) {
      this.buffer = null;
      this.pausedAt = 0;
      return;
    }

    // Building an AudioBuffer needs a context but not a running one, so this
    // works before the user's first gesture has unlocked audio.
    this.buffer = toAudioBuffer(pcm, this.createContextIfNeeded());
    this.pausedAt = Math.min(position, this.buffer.duration);
    if (wasPlaying) void this.play({ from: this.pausedAt });
  }

  /** Position of the playhead in seconds. */
  get currentTime(): number {
    if (this.state !== 'playing' || !this.ctx) return this.pausedAt;

    const elapsed = this.ctx.currentTime - this.startedAt;
    let position = this.startOffset + elapsed;

    if (this.loopRegion) {
      const { start, end } = this.loopRegion;
      const span = end - start;
      if (span > 0 && position >= end) {
        position = start + ((position - start) % span);
      }
    }
    return Math.min(position, this.duration);
  }

  async play(options: PlayOptions): Promise<void> {
    const ctx = await this.ensureContext();
    if (!this.buffer || !this.gain) return;

    this.stopSource();

    const loop = Boolean(options.loop && options.to != null && options.to > options.from);
    const source = ctx.createBufferSource();
    source.buffer = this.buffer;
    source.connect(this.gain);

    const from = clamp(options.from, 0, this.buffer.duration);
    const to = options.to != null ? clamp(options.to, 0, this.buffer.duration) : null;

    if (loop && to != null) {
      source.loop = true;
      source.loopStart = from;
      source.loopEnd = to;
      this.loopRegion = { start: from, end: to };
      source.start(0, from);
    } else {
      this.loopRegion = null;
      const span = to != null && to > from ? to - from : undefined;
      source.start(0, from, span);
    }

    source.onended = () => {
      // A manual stop() clears this.source first, so reaching here means the
      // region really did play out.
      if (this.source === source) {
        this.source = null;
        this.pausedAt = to ?? this.duration;
        this.setState('stopped');
      }
    };

    this.source = source;
    this.startedAt = ctx.currentTime;
    this.startOffset = from;
    this.setState('playing');
  }

  /** Stops and leaves the playhead where it landed. */
  pause(): void {
    if (this.state !== 'playing') return;
    const position = this.currentTime;
    this.stopSource();
    this.pausedAt = position;
    this.setState('stopped');
  }

  /** Stops playback and returns the playhead to `position`. */
  stopAt(position = 0): void {
    this.stopSource();
    this.pausedAt = clamp(position, 0, this.duration);
    this.setState('stopped');
  }

  seek(seconds: number): void {
    const target = clamp(seconds, 0, this.duration);
    if (this.state === 'playing') {
      const region = this.loopRegion;
      void this.play({ from: target, to: region?.end ?? null, loop: Boolean(region) });
    } else {
      this.pausedAt = target;
    }
  }

  setVolume(value: number): void {
    if (this.gain && this.ctx) {
      this.gain.gain.setTargetAtTime(clamp(value, 0, 1), this.ctx.currentTime, 0.01);
    }
  }

  /** Re-arms audio after an interruption (a call, or the tab going background). */
  async resumeAfterInterruption(): Promise<void> {
    if (this.ctx && this.ctx.state === 'suspended' && this.state === 'playing') {
      await this.ctx.resume();
    }
  }

  private stopSource(): void {
    if (!this.source) return;
    const source = this.source;
    this.source = null;
    source.onended = null;
    try {
      source.stop();
    } catch {
      // Already stopped; nothing to do.
    }
    source.disconnect();
  }

  private setState(state: EngineState): void {
    if (this.state === state) return;
    this.state = state;
    this.onStateChange?.(state);
  }
}

/**
 * Safari 16.4+ exposes an audio session type. Declaring `playback` keeps the
 * editor audible when the hardware mute switch is on, which is what anyone
 * editing audio on a phone expects.
 */
function configureAudioSession(): void {
  const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
  if (session) {
    try {
      session.type = 'playback';
    } catch {
      // Not fatal: playback still works, it just respects the mute switch.
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
