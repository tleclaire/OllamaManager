/**
 * Models + running set + selection + details (§4.6).
 * The store OWNS its 5s polling timers — poll cadence is domain behavior,
 * not presentation. Every mutating action refreshes tags afterward
 * (inventory can change underneath us; self-healing UI).
 */
import { config } from "../config";
import type { ApiError, ModelDetails, OllamaModel, OllamaTransport, RunningModel } from "../services/ollamaApi";
import { OllamaApiClient } from "../services/ollamaApi";
import { StoreBase } from "./base";
import { type TimerDeps, realTimerDeps } from "../lib/timers";

export type ApiStatus = "checking" | "ok" | "down";

export type ModelsState = {
  tags: OllamaModel[];
  running: RunningModel[];
  selected: string | null;
  apiStatus: ApiStatus;
  lastError?: string;
  lastRefresh: number;
  details?: ModelDetails;
  detailsModel?: string;
  detailsLoading: boolean;
};

export interface OllamaApiLike {
  listModels(): Promise<OllamaModel[]>;
  listRunning(): Promise<RunningModel[]>;
  showModel(name: string): Promise<ModelDetails>;
  deleteModel(name: string): Promise<void>;
  copyModel(source: string, destination: string): Promise<void>;
  unload(model: string): Promise<void>;
}

/**
 * Canonical, deterministic model order.
 *
 * Ollama's `/api/tags` does NOT return a stable order: it sorts by `modified_at`,
 * but models whose timestamps land in the same second tie, and the tie order
 * falls back to Go map iteration — a random *rotation* of one fixed cycle. Measured
 * on a live instance: 30 polls produced exactly 6 distinct orders, all rotations
 * of the same 6-model cycle (upstream: ollama/ollama#12866 has no sorting at all).
 * Since the store polls every 5s, that made the list visibly reshuffle. Sorting
 * here gives every consumer (ModelsPane, chat picker, details) one stable order:
 * newest first, name ascending as a deterministic tiebreak.
 */
export function compareModels(a: OllamaModel, b: OllamaModel): number {
  const ta = Date.parse(a.modified_at);
  const tb = Date.parse(b.modified_at);
  const va = Number.isNaN(ta) ? 0 : ta;
  const vb = Number.isNaN(tb) ? 0 : tb;
  if (va !== vb) return vb - va; // newest first
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

export class ModelsStore extends StoreBase<ModelsState> {
  private readonly api: OllamaApiLike;
  private readonly timers: TimerDeps;
  private pollTimer: unknown = null;
  private inFlight = new Set<string>();

  constructor(deps: { api?: OllamaApiLike; transport?: OllamaTransport; timers?: TimerDeps }) {
    super({
      tags: [],
      running: [],
      selected: null,
      apiStatus: "checking",
      lastRefresh: 0,
      detailsLoading: false,
    });
    this.api = deps.api ?? new OllamaApiClient({ transport: deps.transport });
    this.timers = deps.timers ?? realTimerDeps;
  }

  /** Boot polling (called by runtime.start()). */
  start(): void {
    if (this.pollTimer) return;
    void this.refreshTags();
    void this.refreshRunning();
    this.pollTimer = this.timers.setInterval(() => {
      void this.refreshTags();
      void this.refreshRunning();
    }, config.poll.tagsMs);
  }

  stop(): void {
    if (this.pollTimer) {
      this.timers.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async refreshTags(): Promise<void> {
    if (this.inFlight.has("tags")) return; // previous cycle still running — skip, tick is the backoff
    this.inFlight.add("tags");
    try {
      const tags = [...(await this.api.listModels())].sort(compareModels);
      this.update({ tags, apiStatus: "ok", lastError: undefined, lastRefresh: this.timers.now() });
    } catch (err) {
      this.recordError(err);
    } finally {
      this.inFlight.delete("tags");
    }
  }

  async refreshRunning(): Promise<void> {
    if (this.inFlight.has("running")) return;
    this.inFlight.add("running");
    try {
      const running = await this.api.listRunning();
      this.update({ running });
    } catch (err) {
      this.recordError(err);
    } finally {
      this.inFlight.delete("running");
    }
  }

  select(name: string | null): void {
    this.update({ selected: name });
  }

  async loadDetails(name: string): Promise<void> {
    this.update({ detailsLoading: true, detailsModel: name });
    try {
      const details = await this.api.showModel(name);
      // Only apply if the user has not moved on to another model meanwhile.
      const requested = this.snapshot.detailsModel;
      if (requested === name) {
        this.update({ details, detailsLoading: false });
      }
    } catch (err) {
      this.recordError(err);
      if (this.snapshot.detailsModel === name) {
        this.update({ detailsLoading: false });
      }
    }
  }

  async remove(name: string): Promise<void> {
    await this.mutate(() => this.api.deleteModel(name), `delete ${name}`);
  }

  async copy(source: string, destination: string): Promise<void> {
    await this.mutate(() => this.api.copyModel(source, destination), `copy ${source} → ${destination}`);
  }

  async unload(name: string): Promise<void> {
    await this.mutate(async () => {
      await this.api.unload(name);
      await this.api.listRunning().then((running) => this.update({ running }));
    }, `unload ${name}`);
  }

  /** Run a mutating API call; on success refresh tags (self-healing inventory). */
  private async mutate(action: () => Promise<void>, what: string): Promise<void> {
    try {
      await action();
      await this.refreshTags();
    } catch (err) {
      this.recordError(err, `failed to ${what}`);
    }
  }

  private recordError(err: unknown, prefix?: string): void {
    const apiError = err as ApiError;
    const message = apiError?.message ?? String(err);
    this.update({
      apiStatus: "down",
      lastError: prefix ? `${prefix}: ${message}` : message,
    });
  }
}
