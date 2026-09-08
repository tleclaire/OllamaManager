/**
 * Deterministic manual timer implementation for unit tests.
 * Implements the TimerDeps seam so stores/services run without real waits.
 */
import type { TimerDeps } from "../lib/timers";

interface Scheduled {
  id: number;
  fn: () => void;
  at: number;
  /** undefined for one-shot timeouts; ms period for intervals. */
  period?: number;
  canceled: boolean;
}

export class FakeTimers implements TimerDeps {
  private items: Scheduled[] = [];
  private nextId = 1;
  /** Current simulated clock (ms). */
  timeMs = 0;

  setInterval(fn: () => void, ms: number): unknown {
    const item: Scheduled = { id: this.nextId++, fn, at: this.timeMs + ms, period: ms, canceled: false };
    this.items.push(item);
    return item.id;
  }

  clearInterval(handle: unknown): void {
    const item = this.byId(handle);
    if (item) item.canceled = true;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const item: Scheduled = { id: this.nextId++, fn, at: this.timeMs + ms, canceled: false };
    this.items.push(item);
    return item.id;
  }

  clearTimeout(handle: unknown): void {
    const item = this.byId(handle);
    if (item) item.canceled = true;
  }

  now(): number {
    return this.timeMs;
  }

  /** Number of currently scheduled (non-canceled) callbacks. */
  get pendingCount(): number {
    return this.items.filter((i) => !i.canceled).length;
  }

  /** Advance the clock, firing every due callback in time order (intervals repeat). */
  advance(ms: number): void {
    const target = this.timeMs + ms;
    // Loop: each pass fires the earliest due item; repeat until none are due.
    for (;;) {
      const due = this.items
        .filter((i) => !i.canceled && i.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timeMs = due.at;
      if (due.period !== undefined) {
        due.at = this.timeMs + due.period;
      } else {
        due.canceled = true;
      }
      due.fn();
    }
    this.timeMs = target;
  }

  private byId(handle: unknown): Scheduled | undefined {
    return this.items.find((i) => i.id === handle);
  }
}
