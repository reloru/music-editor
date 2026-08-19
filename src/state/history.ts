/**
 * Undo/redo with a memory budget.
 *
 * Every entry is a whole buffer, and a buffer is large: five minutes of stereo
 * 48 kHz float is about 115 MB. Safari on iOS will kill a tab that grows too
 * far, so the stack is bounded by total bytes as well as entry count and drops
 * the oldest states first.
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

export class History<T> {
  private past: Entry<T>[] = [];
  private future: Entry<T>[] = [];
  private readonly sizeOf: (value: T) => number;
  private readonly maxEntries: number;
  private readonly maxBytes: number;

  constructor(options: HistoryOptions<T>) {
    this.sizeOf = options.sizeOf;
    this.maxEntries = options.maxEntries ?? 24;
    this.maxBytes = options.maxBytes ?? 512 * 1024 * 1024;
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

  /**
   * Records the state that existed *before* an edit named `label`.
   * Call this with the outgoing value just before replacing it.
   */
  record(label: string, previous: T): void {
    this.past.push({ label, value: previous, bytes: this.sizeOf(previous) });
    this.future = [];
    this.trim();
  }

  /** Swaps `current` for the previous state, returning it. */
  undo(current: T): { label: string; value: T } | null {
    const entry = this.past.pop();
    if (!entry) return null;
    this.future.push({ label: entry.label, value: current, bytes: this.sizeOf(current) });
    return { label: entry.label, value: entry.value };
  }

  /** Swaps `current` for the state that was undone, returning it. */
  redo(current: T): { label: string; value: T } | null {
    const entry = this.future.pop();
    if (!entry) return null;
    this.past.push({ label: entry.label, value: current, bytes: this.sizeOf(current) });
    return { label: entry.label, value: entry.value };
  }

  clear(): void {
    this.past = [];
    this.future = [];
  }

  /** Total bytes currently retained by both stacks. */
  get bytes(): number {
    let total = 0;
    for (const entry of this.past) total += entry.bytes;
    for (const entry of this.future) total += entry.bytes;
    return total;
  }

  private trim(): void {
    while (this.past.length > this.maxEntries) this.past.shift();
    // Always keep one step of undo, however big the buffer is.
    while (this.past.length > 1 && this.bytes > this.maxBytes) this.past.shift();
  }
}
