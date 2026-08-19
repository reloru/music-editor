/**
 * Turning a file the user picked into editable samples.
 *
 * `decodeAudioData` is the fast path — on iOS it hands the work to the hardware
 * decoder, which matters for a 60 MB WAV on a phone. It also has gaps, so a
 * failure on something that is recognisably a WAV falls through to our own
 * parser rather than showing the user an error.
 */
import type { Pcm } from './pcm';
import { decodeWav, isWav } from './wav';

export interface DecodedAudio {
  pcm: Pcm;
  /** How the file was read; surfaced in the UI when the fallback kicks in. */
  via: 'platform' | 'wav-fallback';
}

export async function decodeAudioFile(data: ArrayBuffer, ctx: BaseAudioContext): Promise<DecodedAudio> {
  try {
    // decodeAudioData detaches the ArrayBuffer it is given, so hand it a copy
    // and keep the original intact for the fallback path.
    const audioBuffer = await ctx.decodeAudioData(data.slice(0));
    return { pcm: fromAudioBuffer(audioBuffer), via: 'platform' };
  } catch (error) {
    const bytes = new Uint8Array(data);
    if (isWav(bytes)) {
      return { pcm: decodeWav(bytes), via: 'wav-fallback' };
    }
    throw new Error(
      `Could not decode this file. ${describeError(error)} Try an MP3, WAV, M4A or AAC file.`,
    );
  }
}

export function fromAudioBuffer(buffer: AudioBuffer): Pcm {
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    // getChannelData returns a live view; copy so later edits cannot alias it.
    channels.push(Float32Array.from(buffer.getChannelData(c)));
  }
  return { sampleRate: buffer.sampleRate, channels };
}

export function toAudioBuffer(pcm: Pcm, ctx: BaseAudioContext): AudioBuffer {
  const frames = pcm.channels[0]?.length ?? 0;
  const buffer = ctx.createBuffer(Math.max(1, pcm.channels.length), Math.max(1, frames), pcm.sampleRate);
  for (let c = 0; c < pcm.channels.length; c++) {
    // `set` rather than `copyToChannel`: identical result, and it does not care
    // which flavour of ArrayBuffer backs our Float32Arrays.
    buffer.getChannelData(c).set(pcm.channels[c]);
  }
  return buffer;
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return `${error.message}.`;
  return 'The format is not supported on this device.';
}
