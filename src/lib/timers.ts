/**
 * Injectable timer + clock seam. Every polling store and service takes a
 * TimerDeps instance so unit tests run deterministically without jest fake
 * timers (see src/test-support/fakeTimers.ts).
 */
export interface TimerDeps {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** Monotonic-enough wall clock in ms. */
  now(): number;
}

function unbind(handle: unknown): number {
  return handle as number;
}

export const realTimerDeps: TimerDeps = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(unbind(handle)),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(unbind(handle)),
  now: () => Date.now(),
};
