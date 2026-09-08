/**
 * Active model pulls (§4.6). An 18 GB pull emits thousands of NDJSON chunks —
 * progress updates land in a mutable pending map and are flushed to the
 * snapshot at most every 100 ms (trailing edge). Finished pulls stay visible
 * for pullPruneMs, then are dropped (feedback without leak).
 */
import { config } from "../config";
import { type TimerDeps, realTimerDeps } from "../lib/timers";
import { StoreBase, TrailingEdgeFlush } from "./base";
import { OllamaApiClient, type PullProgress } from "../services/ollamaApi";

export type PullDone = "completed" | "aborted" | "failed";

export type PullEntry = {
  model: string;
  progress: PullProgress;
  pct: number;
  startedAt: number;
  done?: PullDone;
  error?: string;
};

export type PullState = {
  pulls: Record<string, PullEntry>;
};

export class PullStore extends StoreBase<PullState> {
  private readonly api: OllamaApiClient;
  private readonly timers: TimerDeps;
  private readonly flusher: TrailingEdgeFlush;
  private readonly pruneMs: number;
  private controllers = new Map<string, AbortController>();
  /** Mutable working copy; flush() copies it into the snapshot. */
  private working = new Map<string, PullEntry>();
  private pruneTimers = new Map<string, unknown>();

  constructor(deps: { api: OllamaApiClient; timers?: TimerDeps; flushMs?: number; pruneMs?: number }) {
    super({ pulls: {} });
    this.api = deps.api;
    this.timers = deps.timers ?? realTimerDeps;
    this.flusher = new TrailingEdgeFlush(this.timers, deps.flushMs ?? config.flushMs, () => this.flush());
    this.pruneMs = deps.pruneMs ?? config.pullPruneMs;
  }

  stop(): void {
    this.flusher.cancel();
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    for (const timer of this.pruneTimers.values()) this.timers.clearTimeout(timer);
    this.pruneTimers.clear();
    this.working.clear();
    this.commit({ pulls: {} });
  }

  /** Start (or ignore duplicate start for) a model pull. */
  start(model: string): void {
    if (this.controllers.has(model)) return; // already pulling
    // A finished entry of the SAME model may still sit inside its prune
    // window. Cancel that stale prune timer — it must never touch the fresh
    // entry registered below (review fix: re-pull within pruneMs).
    const stalePrune = this.pruneTimers.get(model);
    if (stalePrune !== undefined) {
      this.timers.clearTimeout(stalePrune);
      this.pruneTimers.delete(model);
    }
    const entry: PullEntry = {
      model,
      progress: { status: "starting…" },
      pct: 0,
      startedAt: this.timers.now(),
    };
    this.working.set(model, entry);
    // Show the new pull immediately (user pressed Enter — needs feedback);
    // subsequent progress updates go through the throttled flush.
    this.flush();

    const controller = new AbortController();
    this.controllers.set(model, controller);

    void this.api
      .pull(
        model,
        (progress) => this.onProgress(model, progress),
        controller.signal,
      )
      .then(() => {
        // Resolves on success AND on abort (first-class abort path, §4.2).
        const current = this.working.get(model);
        if (current && !current.done) {
          this.markDone(model, controller.signal.aborted ? "aborted" : "completed");
        }
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        const current = this.working.get(model);
        if (current && !current.done) this.markDone(model, "failed", message);
      })
      .finally(() => {
        this.controllers.delete(model);
      });
  }

  /** Abort an active pull — one keystroke away by contract (§11). */
  abort(model: string): void {
    this.controllers.get(model)?.abort();
    const current = this.working.get(model);
    if (current && !current.done) this.markDone(model, "aborted");
  }

  /** Percentage helper shared with the UI. */
  static pct(progress: PullProgress): number {
    const { total, completed } = progress;
    if (typeof total !== "number" || typeof completed !== "number" || total <= 0) return 0;
    return Math.min(100, Math.round((completed / total) * 100));
  }

  private onProgress(model: string, progress: PullProgress): void {
    const entry = this.working.get(model);
    if (!entry || entry.done) return;
    entry.progress = progress;
    entry.pct = PullStore.pct(progress);
    this.flusher.schedule();
  }

  private markDone(model: string, done: PullDone, error?: string): void {
    const entry = this.working.get(model);
    if (!entry) return;
    entry.done = done;
    entry.error = error;
    if (done === "completed") entry.pct = 100;
    this.flusher.schedule();
    // Finished pulls stay visible for pruneMs, then are dropped.
    const timer = this.timers.setTimeout(() => {
      this.pruneTimers.delete(model);
      // Identity guard: a re-pull of the same model within the window may
      // have replaced the entry with a fresh, still-active one — only drop
      // the entry this timer was scheduled for.
      if (this.working.get(model) === entry) {
        this.working.delete(model);
        this.flusher.schedule();
      }
    }, this.pruneMs);
    this.pruneTimers.set(model, timer);
  }

  /** Copy the working map into a fresh snapshot record (≤100ms cadence). */
  private flush(): void {
    const pulls: Record<string, PullEntry> = {};
    for (const [model, entry] of this.working) {
      pulls[model] = { ...entry, progress: { ...entry.progress } };
    }
    this.commit({ pulls });
  }
}
