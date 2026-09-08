/**
 * Log state backed by a bounded ring buffer (§4.6).
 * append() batches into pending; flush to snapshot at most every 100 ms
 * (trailing edge) — NDJSON bursts of >100 lines/s must not trigger >10
 * renders/s (ADR-6).
 */
import { config } from "../config";
import { RingBuffer } from "../lib/ringbuffer";
import { type TimerDeps, realTimerDeps } from "../lib/timers";
import { StoreBase, TrailingEdgeFlush } from "./base";
import type { JournalLogSource, JournalStatus, LogEntry } from "../services/journal";

export type LogsState = {
  /** Ring-backed snapshot (bounded by config.buffers.logRing). */
  entries: LogEntry[];
  journalStatus: JournalStatus;
  journalDetail?: string;
  /** Lines lost to ring eviction + malformed journal lines. */
  dropped: number;
  /** Monotonic total count of appended entries (drives UI keys). */
  totalAppended: number;
};

export class LogStore extends StoreBase<LogsState> {
  private readonly journal: JournalLogSource;
  private readonly timers: TimerDeps;
  private readonly ring: RingBuffer<LogEntry>;
  private readonly flusher: TrailingEdgeFlush;
  private unsubscribe: (() => void) | null = null;
  private lastSeq = 0;

  constructor(deps: {
    journal: JournalLogSource;
    timers?: TimerDeps;
    cap?: number;
    flushMs?: number;
  }) {
    super({
      entries: [],
      journalStatus: "starting",
      dropped: 0,
      totalAppended: 0,
    });
    this.journal = deps.journal;
    this.timers = deps.timers ?? realTimerDeps;
    this.ring = new RingBuffer<LogEntry>(deps.cap ?? config.buffers.logRing);
    this.flusher = new TrailingEdgeFlush(this.timers, deps.flushMs ?? config.flushMs, () => this.flush());
  }

  /** Wire journal events (called by runtime.start()). */
  start(): void {
    if (this.unsubscribe) return;
    const offEntry = this.journal.on("entry", (entry) => this.append(entry));
    const offStatus = this.journal.on("status", (s) => {
      this.update({ journalStatus: s.status, journalDetail: s.detail });
    });
    this.unsubscribe = () => {
      offEntry();
      offStatus();
    };
    // Reflect current status for sources started before the store attached.
    this.update({ journalStatus: this.journal.status, journalDetail: this.journal.statusDetail });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.flusher.cancel();
  }

  /** Enqueue an entry; snapshot updates are flushed on the trailing edge. */
  append(entry: LogEntry): void {
    // Dedupe on the monotonic seq (§4.3) — restarts must not duplicate lines.
    if (entry.seq <= this.lastSeq) return;
    this.lastSeq = entry.seq;
    this.ring.push(entry);
    this.flusher.schedule();
  }

  /** Rebuild the snapshot from the ring; called at most once per flushMs. */
  flush(): void {
    this.update({
      entries: this.ring.toArray(),
      dropped: this.ring.evicted + this.journal.malformed,
      totalAppended: this.lastSeq,
    });
  }
}
