import { afterEach, describe, expect, it } from 'vitest';
import { findEffect } from '../src/audio/effect-registry';
import * as fx from '../src/audio/effects';
import { createPcm, type Pcm } from '../src/audio/pcm';

const RATE = 44100;

/** Drums, a tone and scattered clicks: enough for every window to find work. */
function signal(frames: number): Pcm {
  const pcm = createPcm(2, frames, RATE);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32 - 0.5);
  for (let c = 0; c < 2; c++) {
    for (let i = 0; i < frames; i++) {
      const beat = i % 11025;
      let v = 0.25 * Math.sin((2 * Math.PI * (220 + c * 3) * i) / RATE) + Math.exp(-beat / 800) * rnd() * 1.2 + 0.02 * rnd();
      if (i % 3000 < 3) v += 0.7 * rnd();
      pcm.channels[c][i] = v;
    }
  }
  return pcm;
}

/** Runs each task through a structured clone, the way a worker boundary would. */
function inlineExecutor(size: number, seen?: { tasks: number }): fx.DeclickExecutor {
  return {
    size,
    async run(specs, onTaskDone) {
      return specs.map((spec) => {
        const task = structuredClone(spec.build());
        if (seen) seen.tasks++;
        const result = structuredClone(fx.runDeclickTask(task));
        onTaskDone(spec);
        return result;
      });
    },
  };
}

function expectIdentical(a: Pcm, b: Pcm): void {
  expect(a.channels.length).toBe(b.channels.length);
  for (let c = 0; c < a.channels.length; c++) {
    expect(a.channels[c].length).toBe(b.channels[c].length);
    // Compare bit patterns, not values: NaN and -0 must match too.
    const x = new Uint32Array(a.channels[c].buffer, a.channels[c].byteOffset, a.channels[c].length);
    const y = new Uint32Array(b.channels[c].buffer, b.channels[c].byteOffset, b.channels[c].length);
    let firstDiff = -1;
    for (let i = 0; i < x.length; i++) {
      if (x[i] !== y[i]) {
        firstDiff = i;
        break;
      }
    }
    expect(firstDiff, `channel ${c} first differing sample`).toBe(-1);
  }
}

describe('declick on several workers', () => {
  afterEach(() => fx.setDeclickExecutor(null));

  const frames = 90_001;
  const pcm = signal(frames);
  const defaults = findEffect('declick')!.defaults;
  const ranges: Array<[string, number, number]> = [
    ['whole track', 0, frames],
    ['mid-file', 30_123, 61_777],
    ['from the true start', 0, 20_000],
    ['to the true end', 70_000, frames],
    ['shorter than a window', 45_000, 45_300],
  ];

  for (const method of [0, 1]) {
    for (const overlap of [75, 50]) {
      for (const [label, start, end] of ranges) {
        it(`matches the single-threaded result: method ${method}, overlap ${overlap}%, ${label}`, async () => {
          const values = { ...defaults, method, overlap };
          const sequential = await fx.declick(pcm, { start, end }, values);

          const seen = { tasks: 0 };
          fx.setDeclickExecutor(inlineExecutor(4, seen));
          const parallel = await fx.declick(pcm, { start, end }, values);

          expectIdentical(parallel, sequential);
          if (end - start > RATE) expect(seen.tasks, 'a long range should split into several tasks').toBeGreaterThan(2);
        });
      }
    }
  }

  it('falls back to the main thread when the executor fails', async () => {
    const values = { ...defaults };
    const expected = await fx.declick(pcm, { start: 0, end: 30_000 }, values);

    fx.setDeclickExecutor({
      size: 4,
      run: () => Promise.reject(new Error('no workers here')),
    });
    const warn = console.warn;
    console.warn = () => {};
    try {
      expectIdentical(await fx.declick(pcm, { start: 0, end: 30_000 }, values), expected);
    } finally {
      console.warn = warn;
    }
  });

  it('reports nondecreasing progress that ends at the whole job', async () => {
    fx.setDeclickExecutor(inlineExecutor(4));
    const reports: number[] = [];
    await fx.declick(pcm, { start: 0, end: frames }, defaults, (f) => reports.push(f));
    expect(reports.length).toBeGreaterThan(2);
    for (let i = 1; i < reports.length; i++) expect(reports[i]).toBeGreaterThanOrEqual(reports[i - 1]);
    expect(reports[reports.length - 1]).toBeCloseTo(1, 10);
  });

  it('does not touch the input or anything outside the range', async () => {
    const before = Float32Array.from(pcm.channels[0]);
    fx.setDeclickExecutor(inlineExecutor(4));
    const out = await fx.declick(pcm, { start: 30_000, end: 60_000 }, defaults);
    expect(Float32Array.from(pcm.channels[0])).toEqual(before);
    expect(out.channels[0].subarray(0, 30_000)).toEqual(pcm.channels[0].subarray(0, 30_000));
    expect(out.channels[0].subarray(60_000)).toEqual(pcm.channels[0].subarray(60_000));
  });
});
