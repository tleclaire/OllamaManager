/**
 * Tiny typed emitter (~20 lines, zero deps).
 * Services communicate exclusively through typed events (ARCHITECTURE.md §4.1).
 */
export type Listener<T> = (payload: T) => void;

export class Emitter<Events extends Record<string, unknown>> {
  private listeners = new Map<keyof Events, Set<Listener<never>>>();

  /** Register a listener; returns an unsubscribe function. */
  on<K extends keyof Events>(event: K, fn: Listener<Events[K]>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn as Listener<never>);
    return () => {
      set?.delete(fn as Listener<never>);
    };
  }

  /** Invoke all listeners for an event. Listener exceptions are contained. */
  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        (fn as Listener<Events[K]>)(payload);
      } catch {
        // A broken subscriber must never break the emitting service.
      }
    }
  }

  /** Remove every listener (used by stop()/teardown paths). */
  clear(): void {
    this.listeners.clear();
  }
}
