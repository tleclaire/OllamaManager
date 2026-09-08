/**
 * Composition root (§4.7): instantiate services with real defaults (or test
 * overrides), inject them into stores, own the start/stop lifecycle.
 * App calls start()/stop() in one useEffect — React stays a view layer.
 */
import { config } from "./config";
import { type TimerDeps, realTimerDeps } from "./lib/timers";
import {
  type ExecFn,
  type ReadTextFileFn,
  type SpawnFn,
  defaultExec,
  defaultReadTextFile,
  defaultSpawn,
} from "./services/types";
import { OllamaApiClient, type OllamaTransport } from "./services/ollamaApi";
import { JournalLogSource } from "./services/journal";
import { GpuMetricsPoller } from "./services/gpu";
import { ProcessStatsPoller } from "./services/procstats";
import { ModelsStore } from "./stores/modelsStore";
import { LogStore } from "./stores/logStore";
import { StatsStore } from "./stores/statsStore";
import { PullStore } from "./stores/pullStore";
import { ChatStore } from "./stores/chatStore";
import { UiStore } from "./stores/uiStore";

export type RuntimeStores = {
  models: ModelsStore;
  logs: LogStore;
  stats: StatsStore;
  pull: PullStore;
  chat: ChatStore;
  ui: UiStore;
};

export type RuntimeServices = {
  api: OllamaApiClient;
  journal: JournalLogSource;
  gpu: GpuMetricsPoller;
  proc: ProcessStatsPoller;
};

export type Runtime = {
  stores: RuntimeStores;
  services: RuntimeServices;
  /** Boot journal source + pollers + store poll timers. */
  start(): void;
  /** Tear down everything: timers, children, subscriptions. */
  stop(): void;
};

export function createRuntime(overrides?: {
  api?: OllamaApiClient;
  transport?: OllamaTransport;
  spawnImpl?: SpawnFn;
  readTextFileImpl?: ReadTextFileFn;
  execPgrepImpl?: ExecFn;
  timers?: TimerDeps;
}): Runtime {
  const timers = overrides?.timers ?? realTimerDeps;
  const spawnImpl = overrides?.spawnImpl ?? defaultSpawn;
  const readTextFileImpl = overrides?.readTextFileImpl ?? defaultReadTextFile;
  const execPgrepImpl = overrides?.execPgrepImpl ?? defaultExec;

  // Services (I/O layer).
  const api = overrides?.api ?? new OllamaApiClient({ transport: overrides?.transport });
  const journal = new JournalLogSource({ spawnImpl, timers });
  const gpu = new GpuMetricsPoller({ spawnImpl, timers });
  const proc = new ProcessStatsPoller({ execPgrepImpl, readTextFileImpl, timers });

  // Stores (state layer; services injected).
  const models = new ModelsStore({ api, timers });
  const logs = new LogStore({ journal, timers });
  const stats = new StatsStore({ gpu, proc });
  const pull = new PullStore({ api, timers });
  const chat = new ChatStore({ api, stats, timers });
  const ui = new UiStore();

  const stores: RuntimeStores = { models, logs, stats, pull, chat, ui };
  const services: RuntimeServices = { api, journal, gpu, proc };
  let started = false;

  const start = (): void => {
    if (started) return;
    started = true;
    logs.start();
    stats.start();
    journal.start();
    gpu.start();
    proc.start();
    models.start();
    // Best-effort teardown of children if the process exits some other way
    // (e.g. exitOnCtrlC bypassing React unmount).
    process.once("exit", () => stop());
  };

  const stop = (): void => {
    if (!started) return;
    started = false;
    models.stop();
    proc.stop();
    gpu.stop();
    journal.stop();
    chat.stop();
    pull.stop();
    logs.stop();
    stats.stop();
  };

  return { stores, services, start, stop };
}

/** Re-export for convenience of test overrides. */
export { config };
