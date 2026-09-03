/**
 * Biquad design and evaluation.
 *
 * The coefficient forms here are the ones ffmpeg's own audio filters use
 * (`libavfilter/af_biquads.c`, and the per-filter designs inside
 * `af_crossfeed.c`, `af_asubboost.c`, `af_aexciter.c` and `af_asoftclip.c`), so
 * an effect named after an ffmpeg filter gets the same frequency response.
 *
 * Coefficients are stored normalised by `a0`, un-negated — that is, exactly as
 * the transfer function writes them:
 *
 *   y[n] = b0·x[n] + b1·x[n-1] + b2·x[n-2] − a1·y[n-1] − a2·y[n-2]
 *
 * ffmpeg negates `a1` and `a2` into locals before its inner loops; the runners
 * below subtract instead. Same arithmetic, and keeping the stored form
 * un-negated means a design function can be read straight off the source it
 * came from.
 */

export interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/**
 * How the bandwidth argument of a shelf or peaking design is interpreted.
 * `q` and `slope` are the two ffmpeg width types the filters ported here use.
 */
export type WidthType = 'q' | 'slope';

/**
 * Two conventions for the shelf's transition term, and they are not
 * interchangeable: ffmpeg's `bass`/`treble` use √(2A) while its
 * `lowshelf`/`highshelf` use 2√A. That single difference is the whole
 * distinction between the two filter names.
 */
export type ShelfFlavour = 'bass' | 'shelf';

/** State for `runTdf2`: two words per channel. */
export function tdf2State(): Float64Array {
  return new Float64Array(2);
}

/** State for `runDf1`: x[-1], x[-2], y[-1], y[-2]. */
export function df1State(): Float64Array {
  return new Float64Array(4);
}

/**
 * Transposed direct form II, the form ffmpeg's stateful audio filters run.
 * Cheaper in state than direct form I and better behaved in floating point.
 */
export function runTdf2(filter: Biquad, x: number, w: Float64Array): number {
  const y = x * filter.b0 + w[0];
  w[0] = filter.b1 * x + w[1] - filter.a1 * y;
  w[1] = filter.b2 * x - filter.a2 * y;
  return y;
}

/** Direct form I, which is the default transform for ffmpeg's `bass`. */
export function runDf1(filter: Biquad, x: number, s: Float64Array): number {
  const y = filter.b0 * x + filter.b1 * s[0] + filter.b2 * s[1] - filter.a1 * s[2] - filter.a2 * s[3];
  s[1] = s[0];
  s[0] = x;
  s[3] = s[2];
  s[2] = y;
  return y;
}

/**
 * Scales the numerator so the filter has unity gain at DC.
 *
 * This is `af_biquads.c`'s `normalize` step, and `af_asoftclip.c` applies the
 * same correction unconditionally to its oversampling lowpass.
 */
export function normalizeDcGain(filter: Biquad): Biquad {
  const numerator = filter.b0 + filter.b1 + filter.b2;
  if (Math.abs(numerator) <= 1e-6) return filter;
  const factor = (1 + filter.a1 + filter.a2) / numerator;
  return {
    b0: filter.b0 * factor,
    b1: filter.b1 * factor,
    b2: filter.b2 * factor,
    a1: filter.a1,
    a2: filter.a2,
  };
}

function normalise(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): Biquad {
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** ω₀ = 2πf/fs, the normalised angular frequency every design below starts from. */
function omega(sampleRate: number, frequency: number): number {
  return (2 * Math.PI * frequency) / sampleRate;
}

/**
 * The α term. `q` divides sin ω₀; `slope` is the shelf form, which needs the
 * shelf's own linear gain `a` because the slope is defined against it.
 */
function alphaFor(w0: number, width: number, type: WidthType, a: number): number {
  if (type === 'q') return Math.sin(w0) / (2 * width);
  return (Math.sin(w0) / 2) * Math.sqrt((a + 1 / a) * (1 / width - 1) + 2);
}

export function lowPass(sampleRate: number, frequency: number, q: number): Biquad {
  const w0 = omega(sampleRate, frequency);
  const alpha = alphaFor(w0, q, 'q', 1);
  const cos = Math.cos(w0);
  return normalise((1 - cos) / 2, 1 - cos, (1 - cos) / 2, 1 + alpha, -2 * cos, 1 - alpha);
}

export function highPass(sampleRate: number, frequency: number, q: number): Biquad {
  const w0 = omega(sampleRate, frequency);
  const alpha = alphaFor(w0, q, 'q', 1);
  const cos = Math.cos(w0);
  return normalise((1 + cos) / 2, -(1 + cos), (1 + cos) / 2, 1 + alpha, -2 * cos, 1 - alpha);
}

/**
 * Lowpass whose bandwidth is given as a shelf slope rather than a Q.
 * `af_asubboost.c` designs its band this way; with a gain of 1 the α formula
 * collapses to `sin(w0)/2 · √(2(1/slope − 1) + 2)`, which is what that file
 * writes out by hand.
 */
export function lowPassSlope(sampleRate: number, frequency: number, slope: number): Biquad {
  const w0 = omega(sampleRate, frequency);
  const alpha = alphaFor(w0, slope, 'slope', 1);
  const cos = Math.cos(w0);
  return normalise((1 - cos) / 2, 1 - cos, (1 - cos) / 2, 1 + alpha, -2 * cos, 1 - alpha);
}

export function lowShelf(
  sampleRate: number,
  frequency: number,
  gainDb: number,
  width: number,
  widthType: WidthType = 'q',
  flavour: ShelfFlavour = 'bass',
): Biquad {
  const a = Math.pow(10, gainDb / 40);
  const w0 = omega(sampleRate, frequency);
  const alpha = alphaFor(w0, width, widthType, a);
  const cos = Math.cos(w0);
  // √(A²+1−(A−1)²) reduces to √(2A); ffmpeg writes the long form in `bass`.
  const beta = flavour === 'bass' ? Math.sqrt(2 * a) : 2 * Math.sqrt(a);

  return normalise(
    a * (a + 1 - (a - 1) * cos + beta * alpha),
    2 * a * (a - 1 - (a + 1) * cos),
    a * (a + 1 - (a - 1) * cos - beta * alpha),
    a + 1 + (a - 1) * cos + beta * alpha,
    -2 * (a - 1 + (a + 1) * cos),
    a + 1 + (a - 1) * cos - beta * alpha,
  );
}

export function highShelf(
  sampleRate: number,
  frequency: number,
  gainDb: number,
  width: number,
  widthType: WidthType = 'q',
  flavour: ShelfFlavour = 'shelf',
): Biquad {
  const a = Math.pow(10, gainDb / 40);
  const w0 = omega(sampleRate, frequency);
  const alpha = alphaFor(w0, width, widthType, a);
  const cos = Math.cos(w0);
  const beta = flavour === 'bass' ? Math.sqrt(2 * a) : 2 * Math.sqrt(a);

  return normalise(
    a * (a + 1 + (a - 1) * cos + beta * alpha),
    -2 * a * (a - 1 + (a + 1) * cos),
    a * (a + 1 + (a - 1) * cos - beta * alpha),
    a + 1 - (a - 1) * cos + beta * alpha,
    2 * (a - 1 - (a + 1) * cos),
    a + 1 - (a - 1) * cos - beta * alpha,
  );
}
