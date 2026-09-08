/**
 * Fixed-capacity ring buffer (ARCHITECTURE.md §4.1).
 * O(1) push; evicts the oldest element when full. Logs (cap 5000) and metric
 * series (cap 150) must never grow unbounded — bounded by construction.
 */
export class RingBuffer<T> {
  private buf: (T | undefined)[];
  private head = 0; // index of the oldest element
  private count = 0;
  private evictedTotal = 0;

  constructor(public readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(`capacity must be a positive integer, got ${capacity}`);
    }
    this.buf = new Array<T | undefined>(capacity);
  }

  /** Append an item; overwrites the oldest when at capacity. */
  push(item: T): void {
    const tail = (this.head + this.count) % this.capacity;
    this.buf[tail] = item;
    if (this.count < this.capacity) {
      this.count++;
    } else {
      this.head = (this.head + 1) % this.capacity;
      this.evictedTotal++;
    }
  }

  get length(): number {
    return this.count;
  }

  /** Total number of items evicted by the ring (useful "dropped" signal). */
  get evicted(): number {
    return this.evictedTotal;
  }

  /** Snapshot, oldest → newest. */
  toArray(): T[] {
    const out: T[] = new Array(this.count);
    for (let i = 0; i < this.count; i++) {
      out[i] = this.buf[(this.head + i) % this.capacity] as T;
    }
    return out;
  }

  /** The last `n` items, oldest → newest. Returns fewer when the ring is smaller. */
  sliceLast(n: number): T[] {
    const take = Math.max(0, Math.min(n, this.count));
    const start = this.count - take;
    const out: T[] = new Array(take);
    for (let i = 0; i < take; i++) {
      out[i] = this.buf[(this.head + start + i) % this.capacity] as T;
    }
    return out;
  }

  clear(): void {
    this.buf.fill(undefined);
    this.head = 0;
    this.count = 0;
  }
}
