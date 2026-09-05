/**
 * What the UI needs to know about each effect: what it is called, what it does,
 * and what its controls are.
 *
 * Every parameter's name, default, minimum and maximum is the corresponding
 * `AVOption` from the ffmpeg filter the effect was ported from, so a setting
 * here means what the same setting means there. Where a range is narrower than
 * ffmpeg's, it is because the far end is unusable rather than merely extreme,
 * and the comment says so.
 *
 * The sheet builds itself from this table — adding an effect is adding an entry
 * — so nothing in the UI layer knows the name of a single parameter.
 */
import * as fx from './effects';
import type { EffectValues } from './effects';
import type { Pcm, Range } from './pcm';

/**
 * Controls that some settings make inert are hidden rather than shown doing
 * nothing — a third chorus voice when only two are running, a bit-crusher
 * sweep depth with the sweep off. On a phone the vertical space this saves is
 * the difference between scrolling past dead controls and not.
 */
interface ParamBase {
  key: string;
  label: string;
  visibleWhen?: (values: EffectValues) => boolean;
}

export type ParamSpec =
  | (ParamBase & {
      kind: 'slider';
      min: number;
      max: number;
      step: number;
      /** Appended to the value in the readout, e.g. `ms`, `Hz`, `dB`. */
      unit?: string;
      /** Decimal places in the readout; defaults to what `step` implies. */
      decimals?: number;
    })
  | (ParamBase & { kind: 'toggle' })
  | (ParamBase & { kind: 'choice'; options: string[] });

export interface EffectSpec {
  id: string;
  label: string;
  /** One line, shown under the name in the list and at the top of the sheet. */
  hint: string;
  /** Filters ffmpeg itself restricts to a stereo layout. */
  stereoOnly?: boolean;
  params: ParamSpec[];
  defaults: EffectValues;
  apply(pcm: Pcm, range: Range, values: EffectValues): Pcm;
  /**
   * How many samples outside its range this effect reads (never writes) for
   * context — currently only `declick`, which needs real audio around a
   * selection to avoid the fade its own reconstruction has at a true cold
   * start. Absent for every effect that only ever looks inside its range.
   * Preview uses this to keep enough real margin in the clip it slices out.
   */
  contextSamples?(sampleRate: number, values: EffectValues): number;
}

const slider = (
  key: string,
  label: string,
  min: number,
  max: number,
  step: number,
  unit?: string,
  decimals?: number,
  visibleWhen?: (values: EffectValues) => boolean,
): ParamSpec => ({ kind: 'slider', key, label, min, max, step, unit, decimals, visibleWhen });

const toggle = (key: string, label: string): ParamSpec => ({ kind: 'toggle', key, label });

const choice = (key: string, label: string, options: string[]): ParamSpec => ({
  kind: 'choice',
  key,
  label,
  options,
});

/** Chorus exposes one group of four controls per voice, shown as voices are added. */
const voiceParams = (index: number): ParamSpec[] => {
  const shown = (values: EffectValues): boolean => values.voices >= index;
  return [
    slider(`delay${index}`, `Voice ${index} delay`, 20, 100, 1, 'ms', 0, shown),
    slider(`decay${index}`, `Voice ${index} level`, 0.05, 0.9, 0.01, '', 2, shown),
    slider(`speed${index}`, `Voice ${index} speed`, 0.05, 5, 0.05, 'Hz', 2, shown),
    slider(`depth${index}`, `Voice ${index} depth`, 0.5, 10, 0.5, 'ms', 1, shown),
  ];
};

export const EFFECTS: readonly EffectSpec[] = [
  // ------------------------------------------------------------------- tone
  {
    id: 'bass',
    label: 'Bass',
    hint: 'Shelf boost or cut for the low end.',
    params: [
      slider('frequency', 'Frequency', 20, 500, 5, 'Hz', 0),
      slider('width', 'Q', 0.1, 2, 0.05, '', 2),
      // ffmpeg allows ±900 dB, which is only meaningful as "no limit".
      slider('gain', 'Gain', -24, 24, 0.5, 'dB', 1),
    ],
    defaults: { frequency: 100, width: 0.5, gain: 6 },
    apply: fx.bass,
  },
  {
    id: 'crystalizer',
    label: 'Crystalizer',
    hint: 'Sharpens transients and lifts the top end.',
    params: [slider('intensity', 'Intensity', -10, 10, 0.1, '', 1), toggle('clip', 'Clip to ±1')],
    defaults: { intensity: 2, clip: 1 },
    apply: fx.crystalizer,
  },
  {
    id: 'aexciter',
    label: 'Exciter',
    hint: 'Adds high harmonics that were never in the source.',
    params: [
      slider('levelIn', 'Input', 0, 4, 0.05, '×', 2),
      slider('levelOut', 'Output', 0, 4, 0.05, '×', 2),
      slider('amount', 'Amount', 0, 8, 0.1, '', 1),
      slider('drive', 'Drive', 0.1, 10, 0.1, '', 1),
      slider('blend', 'Blend', -10, 10, 0.1, '', 1),
      slider('freq', 'From', 2000, 12000, 100, 'Hz', 0),
      slider('ceil', 'Ceiling', 9999, 20000, 100, 'Hz', 0),
    ],
    defaults: { levelIn: 1, levelOut: 1, amount: 1, drive: 8.5, blend: 0, freq: 7500, ceil: 9999 },
    apply: fx.aexciter,
  },
  {
    id: 'asubboost',
    label: 'Sub boost',
    hint: 'Resonant tail under the bass, levelled against the dry signal.',
    params: [
      slider('dry', 'Dry', 0, 1, 0.01, '', 2),
      slider('wet', 'Wet', 0, 1, 0.01, '', 2),
      slider('boost', 'Max boost', 1, 12, 0.1, '×', 1),
      slider('decay', 'Decay', 0, 1, 0.01, '', 2),
      slider('feedback', 'Feedback', 0, 1, 0.01, '', 2),
      slider('cutoff', 'Cutoff', 50, 900, 5, 'Hz', 0),
      slider('slope', 'Slope', 0.05, 1, 0.01, '', 2),
      slider('delay', 'Delay', 1, 100, 1, 'ms', 0),
    ],
    defaults: {
      dry: 1,
      wet: 1,
      boost: 2,
      decay: 0,
      feedback: 0.9,
      cutoff: 100,
      slope: 0.5,
      delay: 20,
    },
    apply: fx.asubboost,
  },
  {
    id: 'telephone',
    label: 'Telephone',
    hint: 'The 300–3000 Hz band a phone line passed, and nothing else.',
    params: [
      slider('highpass', 'High-pass', 100, 1000, 10, 'Hz', 0),
      slider('lowpass', 'Low-pass', 1000, 8000, 50, 'Hz', 0),
      slider('volume', 'Volume', 0.5, 3, 0.05, '×', 2),
    ],
    defaults: { highpass: 300, lowpass: 3000, volume: 1.3 },
    apply: fx.telephone,
  },

  // ------------------------------------------------------------ distortion
  {
    id: 'acrusher',
    label: 'Bit crusher',
    hint: 'Lo-fi: fewer bits, fewer samples per second, or both.',
    params: [
      slider('levelIn', 'Input', 0.0625, 4, 0.05, '×', 2),
      slider('levelOut', 'Output', 0.0625, 4, 0.05, '×', 2),
      slider('bits', 'Bits', 1, 16, 0.1, '', 1),
      slider('mix', 'Mix', 0, 1, 0.01, '', 2),
      choice('mode', 'Scale', ['Linear', 'Logarithmic']),
      slider('dc', 'DC', 0.25, 4, 0.05, '', 2),
      slider('aa', 'Anti-alias', 0, 1, 0.01, '', 2),
      slider('samples', 'Sample hold', 1, 64, 1, '', 0),
      toggle('lfo', 'Sweep the hold'),
      slider('lfoRange', 'Sweep depth', 1, 250, 1, '', 0, (v) => v.lfo >= 0.5),
      slider('lfoRate', 'Sweep rate', 0.01, 20, 0.01, 'Hz', 2, (v) => v.lfo >= 0.5),
    ],
    defaults: {
      levelIn: 1,
      levelOut: 1,
      bits: 8,
      mix: 0.5,
      mode: 0,
      dc: 1,
      aa: 0.5,
      samples: 1,
      lfo: 0,
      lfoRange: 20,
      lfoRate: 0.3,
    },
    apply: fx.acrusher,
  },
  {
    id: 'asoftclip',
    label: 'Soft clip',
    hint: 'Rounds peaks off instead of squaring them.',
    params: [
      choice('type', 'Curve', ['Hard', 'Tanh', 'Atan', 'Cubic', 'Exp', 'Alg', 'Quintic', 'Sin', 'Erf']),
      slider('threshold', 'Threshold', 0.05, 1, 0.01, '', 2),
      slider('output', 'Output', 0.05, 4, 0.05, '×', 2),
      // Only tanh, atan and alg read `param`; the other six curves have no
      // shape term at all, so the control would sit there doing nothing.
      slider('param', 'Curve amount', 0.01, 3, 0.01, '', 2, (v) => [1, 2, 5].includes(Math.round(v.type))),
      // ffmpeg allows up to 64×; past 8× the cost is linear and the benefit is
      // not, and this runs on a phone.
      slider('oversample', 'Oversample', 1, 8, 1, '×', 0),
    ],
    defaults: { type: 1, threshold: 1, output: 1, param: 1, oversample: 1 },
    apply: fx.asoftclip,
  },

  // ------------------------------------------------------- time and motion
  {
    id: 'aecho',
    label: 'Echo',
    hint: 'Discrete repeats at a fixed spacing.',
    params: [
      slider('inGain', 'Input', 0, 1, 0.01, '', 2),
      slider('outGain', 'Output', 0, 1, 0.01, '', 2),
      slider('delay', 'Delay', 10, 2000, 10, 'ms', 0),
      slider('decay', 'Decay', 0.05, 0.95, 0.01, '', 2),
      slider('repeats', 'Repeats', 1, 4, 1, '', 0),
    ],
    defaults: { inGain: 0.6, outGain: 0.3, delay: 500, decay: 0.5, repeats: 1 },
    apply: fx.aecho,
  },
  {
    id: 'aphaser',
    label: 'Phaser',
    hint: 'A sweeping notch that moves through the signal.',
    params: [
      slider('inGain', 'Input', 0, 1, 0.01, '', 2),
      slider('outGain', 'Output', 0, 2, 0.01, '', 2),
      slider('delay', 'Delay', 0.5, 5, 0.1, 'ms', 1),
      slider('decay', 'Decay', 0, 0.99, 0.01, '', 2),
      slider('speed', 'Speed', 0.1, 2, 0.05, 'Hz', 2),
      choice('type', 'Shape', ['Triangular', 'Sinusoidal']),
    ],
    defaults: { inGain: 0.4, outGain: 0.74, delay: 3, decay: 0.4, speed: 0.5, type: 0 },
    apply: fx.aphaser,
  },
  {
    id: 'chorus',
    label: 'Chorus',
    hint: 'Detuned copies, so one voice sounds like several.',
    params: [
      slider('inGain', 'Input', 0, 1, 0.01, '', 2),
      slider('outGain', 'Output', 0, 1, 0.01, '', 2),
      slider('voices', 'Voices', 1, 3, 1, '', 0),
      ...voiceParams(1),
      ...voiceParams(2),
      ...voiceParams(3),
    ],
    // The two-voice settings from ffmpeg's own documented example.
    defaults: {
      inGain: 0.7,
      outGain: 0.9,
      voices: 2,
      delay1: 55,
      decay1: 0.4,
      speed1: 0.25,
      depth1: 2,
      delay2: 60,
      decay2: 0.32,
      speed2: 0.4,
      depth2: 1.3,
      delay3: 75,
      decay3: 0.3,
      speed3: 0.6,
      depth3: 2.5,
    },
    apply: fx.chorus,
  },
  {
    id: 'flanger',
    label: 'Flanger',
    hint: 'A swept comb — jet-engine sweep at depth, subtle motion below it.',
    params: [
      slider('delay', 'Delay', 0, 30, 0.5, 'ms', 1),
      slider('depth', 'Depth', 0, 10, 0.1, 'ms', 1),
      slider('regen', 'Regeneration', -95, 95, 1, '%', 0),
      slider('width', 'Width', 0, 100, 1, '%', 0),
      slider('speed', 'Speed', 0.1, 10, 0.1, 'Hz', 1),
      choice('shape', 'Shape', ['Sinusoidal', 'Triangular']),
      slider('phase', 'Stereo phase', 0, 100, 1, '%', 0),
      choice('interp', 'Interpolation', ['Linear', 'Quadratic']),
    ],
    defaults: {
      delay: 0,
      depth: 2,
      regen: 0,
      width: 71,
      speed: 0.5,
      shape: 0,
      phase: 25,
      interp: 0,
    },
    apply: fx.flanger,
  },
  {
    id: 'tremolo',
    label: 'Tremolo',
    hint: 'Level modulated by a sine — the vintage amp pulse.',
    params: [
      slider('frequency', 'Rate', 0.1, 20, 0.1, 'Hz', 1),
      slider('depth', 'Depth', 0, 1, 0.01, '', 2),
    ],
    defaults: { frequency: 5, depth: 0.5 },
    apply: fx.tremolo,
  },
  {
    id: 'apulsator',
    label: 'Pulsator',
    hint: 'Auto-pan: the level sweeps between the two ears.',
    stereoOnly: true,
    params: [
      slider('levelIn', 'Input', 0.0625, 4, 0.05, '×', 2),
      slider('levelOut', 'Output', 0.0625, 4, 0.05, '×', 2),
      choice('mode', 'Shape', ['Sine', 'Triangle', 'Square', 'Saw up', 'Saw down']),
      slider('amount', 'Amount', 0, 1, 0.01, '', 2),
      slider('offsetL', 'Left offset', 0, 1, 0.01, '', 2),
      slider('offsetR', 'Right offset', 0, 1, 0.01, '', 2),
      slider('width', 'Pulse width', 0.01, 2, 0.01, '', 2),
      slider('hz', 'Rate', 0.01, 20, 0.01, 'Hz', 2),
    ],
    defaults: {
      levelIn: 1,
      levelOut: 1,
      mode: 0,
      amount: 1,
      offsetL: 0,
      offsetR: 0.5,
      width: 1,
      hz: 2,
    },
    apply: fx.apulsator,
  },

  // ---------------------------------------------------------------- stereo
  {
    id: 'haas',
    label: 'Haas',
    hint: 'Widens by arrival time rather than by level.',
    stereoOnly: true,
    params: [
      slider('levelIn', 'Input', 0.0625, 4, 0.05, '×', 2),
      slider('levelOut', 'Output', 0.0625, 4, 0.05, '×', 2),
      slider('sideGain', 'Side gain', 0.0625, 4, 0.05, '×', 2),
      choice('middleSource', 'Middle from', ['Left', 'Right', 'Mid (L+R)', 'Side (L−R)']),
      toggle('middlePhase', 'Invert middle'),
      slider('leftDelay', 'Left delay', 0, 40, 0.01, 'ms', 2),
      slider('leftBalance', 'Left balance', -1, 1, 0.01, '', 2),
      slider('leftGain', 'Left gain', 0.0625, 4, 0.05, '×', 2),
      toggle('leftPhase', 'Invert left'),
      slider('rightDelay', 'Right delay', 0, 40, 0.01, 'ms', 2),
      slider('rightBalance', 'Right balance', -1, 1, 0.01, '', 2),
      slider('rightGain', 'Right gain', 0.0625, 4, 0.05, '×', 2),
      toggle('rightPhase', 'Invert right'),
    ],
    defaults: {
      levelIn: 1,
      levelOut: 1,
      sideGain: 1,
      middleSource: 2,
      middlePhase: 0,
      leftDelay: 2.05,
      leftBalance: -1,
      leftGain: 1,
      leftPhase: 0,
      rightDelay: 2.12,
      rightBalance: 1,
      rightGain: 1,
      rightPhase: 1,
    },
    apply: fx.haas,
  },
  {
    id: 'stereowiden',
    label: 'Stereo widen',
    hint: 'Pushes the image outwards with a short cross-delay.',
    stereoOnly: true,
    params: [
      slider('delay', 'Delay', 1, 100, 1, 'ms', 0),
      slider('feedback', 'Feedback', 0, 0.9, 0.01, '', 2),
      slider('crossfeed', 'Cross feed', 0, 0.8, 0.01, '', 2),
      slider('drymix', 'Dry mix', 0, 1, 0.01, '', 2),
    ],
    defaults: { delay: 20, feedback: 0.3, crossfeed: 0.3, drymix: 0.8 },
    apply: fx.stereowiden,
  },
  {
    id: 'crossfeed',
    label: 'Crossfeed',
    hint: 'Narrows the bass so headphones stop being tiring.',
    stereoOnly: true,
    params: [
      slider('strength', 'Strength', 0, 1, 0.01, '', 2),
      slider('range', 'Soundstage', 0, 1, 0.01, '', 2),
      slider('slope', 'Slope', 0.01, 1, 0.01, '', 2),
      slider('levelIn', 'Input', 0, 1, 0.01, '', 2),
      slider('levelOut', 'Output', 0, 1, 0.01, '', 2),
    ],
    defaults: { strength: 0.2, range: 0.5, slope: 0.5, levelIn: 0.9, levelOut: 1 },
    apply: fx.crossfeed,
  },

  // ----------------------------------------------------------------- repair
  {
    id: 'declick',
    label: 'Declick',
    hint: 'Finds isolated clicks and pops and fills them in from the model around them.',
    params: [
      slider('window', 'Window', 10, 100, 1, 'ms', 0),
      slider('overlap', 'Overlap', 50, 95, 1, '%', 0),
      slider('arOrder', 'Model order', 0, 25, 1, '%', 0),
      slider('threshold', 'Threshold', 1, 100, 0.5, '', 1),
      slider('burst', 'Burst fusion', 0, 10, 0.1, 'ms', 1),
      choice('method', 'Reconstruction', ['Cross-fade', 'Direct']),
    ],
    defaults: { window: 55, overlap: 75, arOrder: 2, threshold: 2, burst: 2, method: 0 },
    apply: fx.declick,
    contextSamples: fx.declickContextSamples,
  },
  {
    id: 'agate',
    label: 'Noise gate',
    hint: 'Quiets the signal below a threshold — good for hiss or bleed between phrases.',
    // ratio, attack and release are all narrower here than ffmpeg's own
    // 1–9000 / 0.01–9000 ms ranges: past about 30:1 a gate is indistinguishable
    // from fully closed, and a multi-second attack or release has no practical
    // use gating phrases in a stem — both ends are ffmpeg's, tuned for uses
    // this editor does not have.
    params: [
      slider('levelIn', 'Input', 0.0625, 4, 0.05, '×', 2),
      choice('mode', 'Mode', ['Downward', 'Upward']),
      slider('threshold', 'Threshold', 0, 1, 0.005, '', 3),
      slider('range', 'Max reduction', 0, 1, 0.01, '', 2),
      slider('ratio', 'Ratio', 1, 30, 0.5, ':1', 1),
      slider('attack', 'Attack', 0.01, 200, 0.5, 'ms', 2),
      slider('release', 'Release', 1, 2000, 1, 'ms', 0),
      slider('makeup', 'Makeup', 1, 16, 0.1, '×', 1),
      slider('knee', 'Knee', 1, 8, 0.1, '', 1),
      choice('detection', 'Detection', ['Peak', 'RMS']),
      choice('link', 'Channels', ['Average', 'Maximum']),
    ],
    defaults: {
      levelIn: 1,
      mode: 0,
      threshold: 0.125,
      range: 0.06125,
      ratio: 2,
      attack: 20,
      release: 250,
      makeup: 1,
      knee: 2.828427125,
      detection: 1,
      link: 0,
    },
    apply: fx.gate,
  },
  {
    id: 'equalizer',
    label: 'Parametric EQ',
    hint: 'Boosts or cuts a narrow band. Dial out a ringing resonance by ear.',
    params: [
      slider('frequency', 'Frequency', 20, 20000, 10, 'Hz', 0),
      slider('width', 'Q', 0.1, 10, 0.05, '', 2),
      slider('gain', 'Gain', -24, 24, 0.5, 'dB', 1),
    ],
    // ffmpeg's own default is 0 Hz / 0 dB, a true no-op; see effects.ts.
    defaults: { frequency: 1000, width: 1, gain: 0 },
    apply: fx.equalizer,
  },
];

export function findEffect(id: string): EffectSpec | undefined {
  return EFFECTS.find((effect) => effect.id === id);
}

/** Formats one parameter for its readout, using the spec's unit and precision. */
export function formatParam(spec: ParamSpec, value: number): string {
  if (spec.kind === 'toggle') return value >= 0.5 ? 'On' : 'Off';
  if (spec.kind === 'choice') return spec.options[Math.round(value)] ?? spec.options[0];
  const decimals = spec.decimals ?? (Number.isInteger(spec.step) ? 0 : 2);
  return `${value.toFixed(decimals)}${spec.unit ? ` ${spec.unit}` : ''}`.trim();
}
