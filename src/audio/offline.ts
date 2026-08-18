/**
 * Edits that lean on the browser's own audio graph.
 *
 * `OfflineAudioContext` resamples far better than the linear interpolation in
 * `dsp.ts`, and on iOS the work happens in native code, so speed changes on a
 * long track finish in a fraction of the time a JS implementation would take.
 */
import type { Pcm } from './pcm';
import { fromAudioBuffer, toAudioBuffer } from './decode';
import { frameCount } from './pcm';

/**
 * Changes playback speed, taking pitch with it — the tape-speed behaviour,
 * not time-stretching. `rate` above 1 is faster and higher.
 */
export async function changeSpeed(pcm: Pcm, rate: number): Promise<Pcm> {
  if (rate === 1 || frameCount(pcm) === 0) return pcm;
  if (!(rate > 0) || !Number.isFinite(rate)) throw new Error('Speed must be greater than zero');

  const frames = Math.max(1, Math.round(frameCount(pcm) / rate));
  const ctx = new OfflineAudioContext(pcm.channels.length, frames, pcm.sampleRate);

  const source = ctx.createBufferSource();
  source.buffer = toAudioBuffer(pcm, ctx);
  source.playbackRate.value = rate;
  source.connect(ctx.destination);
  source.start();

  return fromAudioBuffer(await ctx.startRendering());
}

/**
 * Resamples to `targetRate` using the platform resampler.
 * Used when exporting at a rate the source does not already use.
 */
export async function resampleTo(pcm: Pcm, targetRate: number): Promise<Pcm> {
  if (targetRate === pcm.sampleRate || frameCount(pcm) === 0) return pcm;

  const frames = Math.max(1, Math.round((frameCount(pcm) * targetRate) / pcm.sampleRate));
  const ctx = new OfflineAudioContext(pcm.channels.length, frames, targetRate);

  const source = ctx.createBufferSource();
  source.buffer = toAudioBuffer(pcm, ctx);
  source.connect(ctx.destination);
  source.start();

  return fromAudioBuffer(await ctx.startRendering());
}
