import { describe, expect, it } from 'vitest';
import { History } from '../src/state/history';

const sizeOf = (value: string) => value.length;

describe('History', () => {
  it('starts with nothing to undo or redo', () => {
    const history = new History<string>({ sizeOf });
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
    expect(history.undo('a')).toBeNull();
  });

  it('returns the previous state and remembers the label', () => {
    const history = new History<string>({ sizeOf });
    history.record('Trim', 'original');
    expect(history.undoLabel).toBe('Trim');

    const undone = history.undo('trimmed');
    expect(undone).toEqual({ label: 'Trim', value: 'original' });
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(true);
  });

  it('redoes what was undone', () => {
    const history = new History<string>({ sizeOf });
    history.record('Fade', 'a');
    history.undo('b');
    expect(history.redo('a')).toEqual({ label: 'Fade', value: 'b' });
    expect(history.canUndo).toBe(true);
  });

  it('walks back through several edits in order', () => {
    const history = new History<string>({ sizeOf });
    history.record('one', 'v0');
    history.record('two', 'v1');
    history.record('three', 'v2');

    expect(history.undo('v3')?.value).toBe('v2');
    expect(history.undo('v2')?.value).toBe('v1');
    expect(history.undo('v1')?.value).toBe('v0');
    expect(history.canUndo).toBe(false);
  });

  it('drops the redo stack once a new edit lands', () => {
    const history = new History<string>({ sizeOf });
    history.record('one', 'a');
    history.undo('b');
    expect(history.canRedo).toBe(true);

    history.record('two', 'c');
    expect(history.canRedo).toBe(false);
  });

  it('discards the oldest states past the entry limit', () => {
    const history = new History<string>({ sizeOf, maxEntries: 2 });
    history.record('one', 'a');
    history.record('two', 'b');
    history.record('three', 'c');

    expect(history.depth).toBe(2);
    expect(history.undo('d')?.value).toBe('c');
    expect(history.undo('c')?.value).toBe('b');
    expect(history.canUndo).toBe(false);
  });

  it('discards the oldest states past the byte budget', () => {
    const history = new History<string>({ sizeOf, maxBytes: 10 });
    history.record('one', 'aaaaa');
    history.record('two', 'bbbbb');
    history.record('three', 'ccccc');

    expect(history.bytes).toBeLessThanOrEqual(10);
    expect(history.depth).toBe(2);
  });

  it('always keeps one undo step, however large the state', () => {
    const history = new History<string>({ sizeOf, maxBytes: 4 });
    history.record('huge', 'x'.repeat(1000));
    expect(history.canUndo).toBe(true);
    expect(history.undo('y')?.value).toHaveLength(1000);
  });

  it('gives up redo before undo when the byte budget is tight', () => {
    // Undo is the operation a user reaches for after a mistake; redo only
    // matters after an undo. When something has to be evicted, the reachable
    // past is worth more than a speculative future.
    const history = new History<string>({ sizeOf, maxBytes: 12 });
    history.record('one', 'aaa');
    history.record('two', 'bbb');
    history.undo('ccc');
    history.undo('ddd');
    expect(history.canRedo).toBe(true);

    // Redoing pushes an 11-byte state onto the past, taking the total to 14.
    const deep = 'x'.repeat(11);
    history.redo(deep);

    expect(history.bytes).toBeLessThanOrEqual(12);
    expect(history.canUndo).toBe(true);
    expect(history.canRedo).toBe(false);
  });

  it('keeps the byte count honest across every operation', () => {
    const history = new History<string>({ sizeOf });
    history.record('one', 'aaaa');
    history.record('two', 'bb');
    expect(history.bytes).toBe(6);

    history.undo('cccccc');
    expect(history.bytes).toBe(4 + 6);

    history.redo('bb');
    expect(history.bytes).toBe(4 + 2);

    history.record('three', 'd');
    expect(history.bytes).toBe(4 + 2 + 1);
  });

  it('holds a long session at the byte ceiling, not above it', () => {
    const history = new History<string>({ sizeOf, maxEntries: 1000, maxBytes: 4096 });
    const chunk = 'y'.repeat(256);

    for (let i = 0; i < 400; i++) {
      history.record(`edit ${i}`, chunk);
      expect(history.bytes).toBeLessThanOrEqual(4096);
    }

    // 4096 / 256, exactly: no drift from the running total falling out of step
    // with the entries it is meant to describe.
    expect(history.depth).toBe(16);
    expect(history.undoLabel).toBe('edit 399');
  });

  it('clears both stacks', () => {
    const history = new History<string>({ sizeOf });
    history.record('one', 'a');
    history.undo('b');
    history.clear();
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
    expect(history.bytes).toBe(0);
  });
});
