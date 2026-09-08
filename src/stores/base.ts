/**
 * Shared store contract (ARCHITECTURE.md §4.6): immutable snapshot objects,
 * subscribe(cb) → unsubscribe, getSnapshot() with STABLE identity between
 * changes — required by useSyncExternalStore.
 */
export class StoreBase<S extends object> {
  private listeners = new Set<() => void>();
  protected snapshot: S;

  constructor(initial: S) {
    this.snapshot = initial;
  }

  /** Stable identity (class field) so it can be passed directly to useSyncExternalStore. */
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  /** Stable identity; returns the current immutable snapshot. */
  getSnapshot = (): S => {
    return this.snapshot;
  };

  /** Replace the snapshot and notify subscribers (no-op when identity unchanged). */
  protected commit(next: S): void {
    if (next === this.snapshot) return;
    this.snapshot = next;
    for (const listener of [...this.listeners]) listener();
  }

  /** Shallow-merge a patch into a NEW snapshot and notify. */
  protected update(patch: Partial<S>): void {
    this.commit({ ...this.snapshot, ...patch });
  }
}

/**
 * Trailing-edge flush scheduler: coalesces bursts into at most one flush per
 * interval (ADR-6). First schedule() arms a timer; further calls within the
 * window are absorbed; the timer fires the LATEST state at flush time.
 */
export class TrailingEdgeFlush {
  private timer: unknown = null;

  constructor(
    private readonly timers: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void },
    private readonly delayMs: number,
    private readonly flush: () => void,
  ) {}

  schedule(): void {
    if (this.timer !== null) return;
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.delayMs);
  }

  /** Run any pending flush immediately (teardown / tests). */
  cancel(): void {
    if (this.timer !== null) {
      this.timers.clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
