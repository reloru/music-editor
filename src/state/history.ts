/**
 * Undo/redo with a memory budget.
 *
 * Every entry is a whole document state, and the audio inside one is large:
 * five minutes of stereo 48 kHz float is about 115 MB. Mobile Safari discards a
 * tab long before the theoretical address space runs out, so the stacks are
 * bounded by total bytes as well as entry count.
 *
 * Two properties matter for not being killed:
 *
 *   1. The budget is small enough that the stacks plus the live document plus
 *      the transient copies an edit makes (`operation` output, the engine's
 *      AudioBuffer, an export's Int16 view) all fit. That is why the default is
 *      160 MB rather than something that merely sounds generous.
 *   2. Redo is discarded before undo. A user who has just undone three times
 *      would rather lose the redo tail than the ability to keep undoing.
 *
 * `bytes` is maintained incrementally: the previous implementation summed both
 * stacks inside the trim loop, which made eviction quadratic in stack depth.
 */
export interface HistoryOptions<T> {
  /** Approximate heap cost of one value, used to enforce `maxBytes`. */
  sizeOf: (value: T) => number;
  maxEntries?: number;
  maxBytes?: number;
}

interface Entry<T> {
  label: string;
  value: T;
  bytes: number;
}

/** Entry cap. Deep stacks are worth less than not being killed mid-session. */
const DEFAULT_MAX_ENTRIES = 12;

/**
 * Byte cap. Chosen against the observed mobile-Safari ceiling rather than the
 * address space: a tab that reaches a few hundred MB of retained typed arrays
 * is a tab that gets discarded on the next memory warning.
 */
const DEFAULT_MAX_BYTES = 160 * 1024 * 1024;

export class History<T> {
  private past: Entry<T>[] = [];
  private future: Entry<T>[] = [];
  private total = 0;
  private readonly sizeOf: (value: T) => number;
  private readonly maxEntries: number;
  private readonly maxBytes: number;

  constructor(options: HistoryOptions<T>) {
    this.sizeOf = options.sizeOf;
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  /** Label of the edit that `undo()` would reverse. */
  get undoLabel(): string | null {
    return this.past.length > 0 ? this.past[this.past.length - 1].label : null;
  }

  /** Label of the edit that `redo()` would reapply. */
  get redoLabel(): string | null {
    return this.future.length > 0 ? this.future[this.future.length - 1].label : null;
  }

  get depth(): number {
    return this.past.length;
  }

  /** Total bytes currently retained by both stacks. */
  get bytes(): number {
    return this.total;
  }

  /**
   * Records the state that existed *before* an edit named `label`.
   * Call this with the outgoing value just before replacing it.
   */
  record(label: string, previous: T): void {
    this.push(this.past, { label, value: previous, bytes: this.sizeOf(previous) });
    this.dropFuture();
    this.trim();
  }

  /** Swaps `current` for the previous state, returning it. */
  undo(current: T): { label: string; value: T } | null {
    const entry = this.pop(this.past);
    if (!entry) return null;
    this.push(this.future, { label: entry.label, value: current, bytes: this.sizeOf(current) });
    this.trim();
    return { label: entry.label, value: entry.value };
  }

  /** Swaps `current` for the state that was undone, returning it. */
  redo(current: T): { label: string; value: T } | null {
    const entry = this.pop(this.future);
    if (!entry) return null;
    this.push(this.past, { label: entry.label, value: current, bytes: this.sizeOf(current) });
    this.trim();
    return { label: entry.label, value: entry.value };
  }

  clear(): void {
    this.past = [];
    this.future = [];
    this.total = 0;
  }

  // ---------------------------------------------------------------- internals

  private push(stack: Entry<T>[], entry: Entry<T>): void {
    stack.push(entry);
    this.total += entry.bytes;
  }

  private pop(stack: Entry<T>[]): Entry<T> | undefined {
    const entry = stack.pop();
    if (entry) this.total -= entry.bytes;
    return entry;
  }

  private shift(stack: Entry<T>[]): void {
    const entry = stack.shift();
    if (entry) this.total -= entry.bytes;
  }

  private dropFuture(): void {
    while (this.future.length > 0) this.shift(this.future);
  }

  private trim(): void {
    while (this.past.length > this.maxEntries) this.shift(this.past);
    while (this.future.length > this.maxEntries) this.shift(this.future);

    // Over budget: give up redo first, then the oldest undo steps. One undo
    // step always survives, however big a single state is — an editor that
    // cannot undo the edit you just made is worse than one that risks the
    // memory.
    while (this.total > this.maxBytes && this.future.length > 0) this.shift(this.future);
    while (this.total > this.maxBytes && this.past.length > 1) this.shift(this.past);
  }
}
