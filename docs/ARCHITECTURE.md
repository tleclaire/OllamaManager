# OllamaManager — Architecture Design

| | |
|---|---|
| **Status** | Approved for implementation (design only — no app code yet) |
| **Version** | 1.0 |
| **Date** | 2026-09-08 |
| **Author** | @architect |
| **Scope** | Single-user, single-machine TUI for the local Ollama instance |

---

## 1. Overview

OllamaManager is a keyboard-driven terminal UI (Bun + TypeScript + @opentui/react) that monitors and manages the **local** Ollama instance (`http://127.0.0.1:11434`, verified live, v0.33.3). One screen shows three persistent panes — **Models**, **Stats**, **Logs** — plus toggle views for **model details**, **pull**, and **chat/benchmark**. External data sources: the Ollama HTTP API, a live `journalctl -u ollama -f -o json` child process, `nvidia-smi` polling, and `/proc/<pid>` reads for the server process.

### 1.1 Goals

- **G1** Single-screen TUI: three persistent panes (models, stats, logs), focus-driven keyboard navigation.
- **G2** Full model management: list, details (params/template/modelfile/capabilities), pull with live progress + abort, delete, copy, unload (keep_alive=0), running models (GET /api/ps).
- **G3** Live log streaming from the `ollama` systemd unit; clear, non-fatal UI messaging when journalctl is missing or permission-denied (verified: works as unprivileged user, user in `adm`).
- **G4** Metrics beyond the Ollama API: GPU via `nvidia-smi --query-gpu=...` (RTX 3060 12GB, driver 595.84, verified), CPU/RAM/threads of the ollama server process via `/proc/<pid>/stat` + `/proc/<pid>/status`, pid via `pgrep -o -x ollama`.
- **G5** Chat/benchmark panel: stream a prompt to a selected model, record TTFT, tok/s, eval_count, prompt_eval_count into the stats store; optional preset benchmark prompt.
- **G6** Robustness: every external integration degrades gracefully with visible status; bounded memory everywhere (ring buffers, capped series); auto-restart with backoff for child processes.

### 1.2 Non-Goals (v1)

- Remote Ollama hosts / auth — localhost only, no credentials involved. *(Ollama API has no auth; scope discipline.)*
- Multi-GPU aggregation — first GPU row from nvidia-smi is displayed. *(Single-GPU machine; parsing all rows is trivial to add later.)*
- Config files / theming — all constants in `src/config.ts`. *(YAGNI until a real need exists.)*
- Chat history persistence, multi-turn conversation management — one streaming session per benchmark run is enough for v1. *(The panel's purpose is measurement, not conversation.)*

---

## 2. System Context

```
                         ┌──────────────────────────────────────────────────────┐
                         │        OllamaManager (Bun process, TUI)              │
   keyboard ────────────▶│  ┌─────────────┐   ┌──────────┐   ┌───────────────┐  │
   terminal  ◀───────────│  │  services   │──▶│  stores  │◀──│ ui (React/    │  │
                         │  │  (I/O)      │   │ (state)  │   │ OpenTUI)      │  │
                         │  └──┬───┬───┬──┘   └──────────┘   └───────────────┘  │
                         │     │   │   │        ▲                               │
                         │  runtime.ts (composition root: wiring + lifecycle)   │
                         └─────┼───┼───┼────────┼───────────────────────────────┘
                               │   │   │        │
              ┌────────────────┘   │   │        └──────────────┐
              ▼                    ▼   ▼                        ▼
   ┌──────────────────┐  ┌──────────────┐ ┌─────────────┐  ┌────────────────┐
   │ Ollama HTTP API  │  │ journalctl   │ │ nvidia-smi  │  │ /proc/<pid>/   │
   │ 127.0.0.1:11434  │  │ -u ollama -f │ │ child proc  │  │ stat, status   │
   │ (NDJSON streams) │  │ -o json      │ │ (per tick)  │  │ (file reads)   │
   └──────────────────┘  └──────────────┘ └─────────────┘  └────────────────┘
```

Dependency rule (strict): `ui → stores ← services`; all wiring in `runtime.ts`.
Services never import stores or UI; stores never import services (they receive service instances injected by the runtime); UI never calls services directly — it calls **store actions**.

---

## 3. Layered Architecture

| Layer | Location | Responsibility | Imports allowed |
|---|---|---|---|
| **lib** | `src/lib/` | Pure utilities: NDJSON parser, ring buffer, backoff, emitter, formatters, bench math | lib only |
| **services** | `src/services/` | All external I/O: HTTP, child processes, /proc reads. Emits typed events/results | lib |
| **stores** | `src/stores/` | Application state + actions. Subscribe/snapshot contract for React | lib, services (injected) |
| **runtime** | `src/runtime.ts` | Composition root: instantiate services + stores, inject deps, own lifecycle | all layers |
| **ui** | `src/ui/` | React/OpenTUI components, keybindings, focus management | stores, lib, config |

Every layer decision above has one rationale: keeping UI thin and services framework-agnostic makes each service unit-testable with injected transports and survives OpenTUI API churn (services don't know OpenTUI exists).

### 3.1 State flow (unidirectional)

```
external world ──▶ services (events/callbacks) ──▶ stores (mutate state, notify) ──▶ UI (useSyncExternalStore) ──▶ render
     ▲                                                                                    │
     └────────────── store actions ──▶ services (commands) ◀── UI keybindings ────────────┘
```

React never owns application state; components are pure projections of store snapshots. *(One seam for tests; no prop-drilling; re-renders controllable via throttled snapshots.)*

---

## 4. Component Design

### 4.1 `src/lib/` — utilities (all pure, fully unit-testable)

#### `ndjson.ts` — incremental NDJSON parser
```ts
export function createNdjsonParser<T>(onLine: (obj: T) => void): (chunkText: string) => void
```
- Buffers text, splits on `\n`, trims, skips empty lines, `JSON.parse` per line; malformed lines are counted and skipped (exposed via `parser.stats()`).
- Rationale: chunk boundaries from `ReadableStream` do **not** align with newlines — a hand-rolled 30-line splitter avoids a dependency and handles the boundary case explicitly (tested).
- Usage pattern with Bun fetch: `const reader = (await fetch(...)).body!.getReader()`, decode with `new TextDecoder()` using **streaming mode** `decode(value, { stream: true })` before feeding the parser *(multi-byte UTF-8 chars can split across chunks)*, call `decoder.decode()` (flush) on stream end.

#### `ringbuffer.ts` — fixed-capacity ring buffer
```ts
export class RingBuffer<T> {
  constructor(capacity: number)
  push(item: T): void            // overwrites oldest
  toArray(): T[]                 // oldest → newest
  get length(): number
  sliceLast(n: number): T[]
}
```
- Rationale: logs (cap 5000) and metric series (cap 150) must never grow unbounded; array-shift alternatives are O(n) per append — ring is O(1).

#### `backoff.ts` — restart backoff with jitter
```ts
export function backoffDelay(attempt: number, opts?: { baseMs?: number; maxMs?: number }): number
// base 1s, ×2 per attempt, cap 30s, ±20% jitter
```
- Rationale: thundering-herd-free restarts of journalctl after crashes; jitter prevents tight synchronized loops.

#### `events.ts` — typed emitter
```ts
export class Emitter<Events extends Record<string, unknown>> {
  on<K extends keyof Events>(event: K, fn: (payload: Events[K]) => void): () => void
  emit<K extends keyof Events>(event: K, payload: Events[K]): void
}
```
- Rationale: ~20 lines, zero deps; services communicate exclusively through typed events.

#### `format.ts` — formatters (pure)
`formatBytes(n)`, `formatDurationNs(ns)`, `formatTokensPerSec(count, durationNs)`, `formatUptime`, `pad/cell` helpers for table-ish text.
- Rationale: all display math in one tested place; UI components stay dumb.

#### `bench.ts` — benchmark math (pure)
```ts
export function computeBenchStats(final: GenerateFinalChunk, ttftMs: number, startedAt: number): BenchResult
// tokPerS = eval_count / (eval_duration / 1e9); promptTokPerS likewise; totalMs = now - startedAt
```
- Rationale: TTFT/tok-s correctness is a core feature — the math must be isolated and unit-tested, not buried in a React component.

### 4.2 `src/services/ollamaApi.ts` — OllamaApiClient

Framework-agnostic typed client over the verified REST API. Constructor-injectable transport for tests.

```ts
export type ApiError = { kind: "network" | "status" | "parse"; status?: number; message: string };
export type OllamaModel = { name: string; model: string; size: number; digest: string;
  modified_at: string; details: { family: string; families: string[] | null;
  parameter_size: string; quantization_level: string } };
export type RunningModel = { name: string; model: string; size: number; size_vram: number; expires_at: string };
export type ModelDetails = { license?: string; modelfile: string; parameters: string;
  template: string; details: OllamaModel["details"]; capabilities?: string[] };
export type PullProgress = { status: string; digest?: string; total?: number; completed?: number };
export type GenerateChunk = { model: string; response: string; done: boolean };
export type GenerateFinalChunk = GenerateChunk & {
  load_duration?: number; prompt_eval_count?: number; prompt_eval_duration?: number;
  eval_count?: number; eval_duration?: number };

export interface OllamaTransport { fetch: typeof fetch }   // injectable seam

export class OllamaApiClient {
  constructor(deps?: { baseUrl?: string; transport?: OllamaTransport })
  listModels(): Promise<OllamaModel[]>                    // GET /api/tags
  listRunning(): Promise<RunningModel[]>                  // GET /api/ps
  showModel(name: string): Promise<ModelDetails>          // POST /api/show
  deleteModel(name: string): Promise<void>                // POST /api/delete
  copyModel(source: string, destination: string): Promise<void>  // POST /api/copy
  pull(model: string, onProgress: (p: PullProgress) => void,
       signal: AbortSignal): Promise<void>                // POST /api/pull, NDJSON stream
  generate(model: string, prompt: string, opts: {
    keepAlive?: number | string; signal?: AbortSignal;
    onChunk: (c: GenerateChunk) => void;
  }): Promise<GenerateFinalChunk | null>                  // POST /api/generate, NDJSON stream
  unload(model: string): Promise<void>                    // generate with prompt "" and keep_alive 0
}
```

Implementation notes (contract for the developer):
- Non-streaming calls get a 5s timeout via `AbortSignal.timeout(5000)` *(a hung API must not freeze a poll cycle)*.
- Streaming calls propagate the caller's `AbortSignal` into `fetch`; abort resolves the promise, never throws unhandled *(pull/chat abort must be a first-class path, not an error path)*.
- All errors normalize to `ApiError` — no raw fetch exceptions escape the service *(stores can branch on `kind` without knowing fetch internals)*.
- No retry logic inside the client — retries are the pollers'/stores' job *(single place per concern)*.

### 4.3 `src/services/journal.ts` — JournalLogSource

```ts
export type JournalStatus = "starting" | "live" | "unavailable" | "restarting";
export type LogEntry = { ts: number; seq: number; level: "err" | "warn" | "info" | "debug"; message: string };
export type JournalEvents = {
  entry: LogEntry;
  status: { status: JournalStatus; detail?: string };   // detail = human-readable reason
};

export class JournalLogSource extends Emitter<JournalEvents> {
  constructor(deps?: { spawnImpl?: SpawnFn; unit?: string })   // Bun.spawn injectable
  start(): void
  stop(): void
  get status(): JournalStatus
}
```

Behavior contract:
- Spawns `journalctl -u ollama -f -o json` (fixed argv array, **no shell string** — user input never reaches a shell).
- stdout → TextDecoder(streaming) → `createNdjsonParser` → map fields: `__REALTIME_TIMESTAMP` (µs string) → `ts` (ms), `PRIORITY` (7=debug, 6/5=info, 4=warn, ≤3=err), `MESSAGE` → message. Missing `MESSAGE` → skip entry.
- Exit handling: classify, emit status, restart with backoff (max 6 attempts, then stay `unavailable` with detail):
  - spawn ENOENT → `unavailable` "journalctl not found" — **no restart** *(binary absence is permanent, not transient)*.
  - spawn EACCES / not in `adm` → `unavailable` "permission denied — add user to adm group" — no restart.
  - abnormal exit code otherwise → `restarting` + backoff *(transient journald rotation/restarts are common)*.
- `stop()` kills the child (SIGTERM, then SIGKILL after 2s) and clears timers — leak-free teardown.
- A monotonic `seq` per entry lets the UI dedupe on store flushes.

### 4.4 `src/services/gpu.ts` — GpuMetricsPoller

```ts
export type GpuStatus = "ok" | "unavailable" | "error";
export type GpuSample = { ts: number; utilPct: number; memUsedMb: number;
  memTotalMb: number; tempC: number; fanPct: number | null; powerW: number | null };

export class GpuMetricsPoller extends Emitter<{ sample: GpuSample; status: { status: GpuStatus; detail?: string } }> {
  constructor(deps?: { spawnImpl?: SpawnFn; intervalMs?: number })
  start(): void; stop(): void;
  latest(): GpuSample | null; get status(): GpuStatus
}
```

Behavior contract:
- Every 2s: `nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,fan.speed,power.draw --format=csv,noheader,nounits` (fresh spawn per tick, fixed argv). Parse **first row** of CSV (single-GPU machine; Multi-GPU is a non-goal).
- Verified live output shape: `31, 1148, 12288, 53, 40, 68.12` — split on `, `, trim, `Number()`, empty/`N/A` → `null`.
- ENOENT on first spawn → `unavailable` "nvidia-smi not installed", timer keeps running but skips spawn *(cheap idle; no special-casing later)*. Parse errors → `error` + detail, next tick retries naturally.
- Rationale for per-tick spawn instead of `nvidia-smi -l 2`: our own timer gives one stop/start path, injectable timing, and no long-lived child to babysit; 2s cadence makes spawn cost (~20–50 ms) irrelevant.

### 4.5 `src/services/procstats.ts` — ProcessStatsPoller

```ts
export type ProcStatus = "running" | "idle" | "error";   // "idle" = ollama not running (normal!)
export type ProcSample = { ts: number; pid: number; cpuPct: number; rssBytes: number; threads: number };

export class ProcessStatsPoller extends Emitter<{ sample: ProcSample; status: { status: ProcStatus; detail?: string } }> {
  constructor(deps?: { readTextFileImpl?: ReadTextFileFn; execPgrepImpl?: ExecFn; intervalMs?: number })
  start(): void; stop(): void;
  latest(): ProcSample | null; get status(): ProcStatus
}
```

Behavior contract:
- Every 2s: `pgrep -o -x ollama` (oldest matching pid = the `ollama serve` main process; runner children excluded — per-model VRAM already comes from `/api/ps` `size_vram`).
- Reads `/proc/<pid>/stat`: parse after the **last `)`** (comm may contain spaces/parens); `utime` (field 14) + `stime` (field 15) ticks → CPU% = Δ(u+s) / (Δwall_ms × CLK_TCK / 1000) × 100 with `CLK_TCK = 100` as a named constant *(Linux userland default since forever; assumption documented, single override point)*.
- Reads `/proc/<pid>/status`: `VmRSS:` (kB → bytes), `Threads:`. *(status/stat are world-readable even for root-owned processes; verified assumption from requirements.)*
- CPU% needs a previous sample: first tick after (re)discovering a pid emits CPU 0 with a "warming" note; missing pid → `idle` (emit a zero-sample so charts decay), re-`pgrep` next tick.
- "idle" is a **normal** status, not an error *(Ollama being down is a legitimate system state; the UI must show it calmly)*.

### 4.6 `src/stores/` — state + actions

Store contract (all stores): immutable snapshot objects, `subscribe(cb): () => void`, `getSnapshot(): S` (stable identity between changes — required by `useSyncExternalStore`). High-frequency stores coalesce notifications.

#### `modelsStore.ts`
```ts
type ModelsState = {
  tags: OllamaModel[]; running: RunningModel[]; selected: string | null;
  apiStatus: "checking" | "ok" | "down"; lastError?: string; lastRefresh: number;
  details?: ModelDetails; detailsLoading: boolean;
};
```
Actions: `refreshTags()`, `refreshRunning()`, `select(name)`, `loadDetails(name)`, `remove(name)`, `copy(source, dest)`, `unload(name)`. Every mutating action refreshes tags afterward *(inventory can change underneath us; self-healing UI)*. Owns an `OllamaApiClient` (injected) and the 5s tags/ps timers — **the store, not the UI, owns its polling** *(poll cadence is domain behavior, not presentation)*. On consecutive failures: `apiStatus: "down"` + error detail; polling continues *(no backoff needed at 5s cadence — tick is the backoff)*.

#### `logStore.ts`
```ts
type LogsState = { entries: LogEntry[];        // ring-backed snapshot (bounded)
                   journalStatus: JournalStatus; journalDetail?: string; dropped?: number };
```
- Internal `RingBuffer<LogEntry>` (cap 5000 from config); `append()` batches into a pending array; **flush to snapshot at most every 100 ms (trailing edge)** *(NDJSON bursts of >100 lines/s must not trigger >10 renders/s)*.
- Renders only the last ~500 entries (`sliceLast(500)`) via the `scrollbox` viewport *(5000 live rows would fight culling for no benefit; full buffer stays available for future export/filter)*.

#### `statsStore.ts`
```ts
type StatsState = {
  gpu: GpuSample | null; gpuStatus: GpuStatus; gpuSeries: RingBuffer<GpuSample>;   // cap 150 (~5 min @ 2s)
  proc: ProcSample | null; procStatus: ProcStatus; cpuSeries: RingBuffer<number>;  // cap 150
  benchmarks: BenchResult[];                                                        // cap 50, newest first
};
```
Subscribes to both pollers internally (runtime injects them). Fixed-cap series everywhere *(memory bounded by design, not by discipline)*. Renders sparklines from the last ~60 points.

#### `pullStore.ts`
```ts
type PullState = { pulls: Record<string, { model: string; progress: PullProgress; pct: number;
                   startedAt: number; done?: "completed" | "aborted" | "failed"; error?: string }> };
```
Actions: `start(model)` (creates `AbortController`, streams → throttled 100 ms snapshot updates — an 18 GB pull emits thousands of chunks and must not re-render per chunk), `abort(model)` (aborts controller, marks done), internal pruning: finished pulls stay visible for 30 s then are dropped *(feedback without leak)*.

#### `chatStore.ts`
```ts
type ChatState = {
  model: string | null; prompt: string; streaming: boolean; aborted: boolean;
  messages: { role: "user" | "assistant"; content: string; ttftMs?: number }[];     // cap 200
  current: { ttftMs?: number; firstTokenAt?: number; chars: number } | null;
  lastBench: BenchResult | null;
};
```
Actions: `send(prompt)` (stream via client; **TTFT = wall-clock from fetch start until the first chunk with non-empty `response`**), `abort()`, `runBenchmark()` (sends the preset prompt from config, computes `BenchResult` via `lib/bench.ts`, pushes to `statsStore.benchmarks`). Chunks append to the last assistant message through the same 100 ms flush pattern *(long generations are the same burst problem as logs)*.

### 4.7 `src/runtime.ts` — composition root

```ts
export function createRuntime(overrides?: {
  api?: OllamaApiClient; spawnImpl?: SpawnFn; readTextFileImpl?: ReadTextFileFn; timers?: TimerDeps;
}): Runtime
// Runtime = { stores: {...}; start(): void; stop(): void; api: OllamaApiClient }
```
- Instantiates all services with real defaults (or test overrides), injects them into stores, `start()` boots journal source + pollers + store poll timers, `stop()` tears down everything (timers, children, subscriptions) — App calls this in one `useEffect` *(React stays a view layer; lifecycle is testable without rendering)*.

### 4.8 `src/ui/` — React layer

- **`App.tsx`** — shell: view switch (`main | details | pull`) + chat pane flag (`chatOpen`), global `useKeyboard` handler, focus-pane state, runtime boot/teardown in `useEffect`, `useRenderer()` for clean quit (`renderer.destroy()`).
- **View switch, not modal overlay** — details/pull replace the main grid; chat is a pane right of the main panes (v1.1 change from the original chat-as-view: user wants Stats/Logs visible while chatting). Toggle (not modal) rationale unchanged: avoids depending on z-order/overlay behavior of a pre-1.0 library; streaming data continues updating in stores the whole time *(logs never stop flowing)*.
- **`keybindings.ts`** — single source of truth: keymap table + human-readable help lines (rendered by the help overlay). Rationale: keybinding drift between handler and help text is the classic TUI bug — one table prevents it.
- **Panes** (`panes/`): `ModelsPane` (`<select>` focused by focus-pane state; shows size/params/quant + ● running indicator from `/api/ps`), `StatsPane` (GPU/CPU/RAM readouts, ▁▂▄▇ sparklines from series, running models with `expires_at`, ollama pid CPU/RSS), `LogsPane` (`<scrollbox focused stickyScroll stickyStart="bottom">` — the documented streaming-log pattern; manual scroll-up pauses stickiness, `g`/`End` jumps to bottom to re-stick).
- **Views**: `PullView` (model-name `<input>`, start/abort, live per-pull progress bars with pct + MB), `DetailsView` (capabilities, parameters, template, modelfile in a scrollbox), `ChatView` (transcript, prompt `<input>`, streaming indicator, TTFT/tok-s of last + benchmark summary), `ConfirmDialog` (delete/copy confirmation — destructive ops are never single-keystroke).
- **`StatusBar.tsx`** — one line: API/journal/GPU/proc status dots + hint text.
- **`hooks/useStore.ts`** — `useStore(store, selector)` thin wrapper over `useSyncExternalStore` (selector slices keep component re-renders narrow).
- **Focus/key routing contract** (the part most likely to bite): App's global handler checks `uiStore.textCapture` (set true while any `<input>` is focused) and ignores everything except `Escape` when set. Rationale: chat/pull inputs must own the keyboard; global hotkeys must not fire while typing. Known-unknown: whether `<select>` swallows `Tab` — **Phase 1 spike explicitly verifies this** and the handler design (single global `useKeyboard` in App vs. per-pane handlers) is adjusted once, in one file.

---

## 5. Keybinding Map

Global (all views unless input is capturing text):

| Key | Action | View |
|---|---|---|
| `1` / `2` / `3` | Focus Models / Stats / Logs pane | main |
| `Tab` / `Shift+Tab` | Cycle pane focus forward/backward | main |
| `m` | Model actions on selected model (details/delete/copy/unload) | main |
| `Enter` | Model details for selected model | main (models focused) |
| `p` | Pull view (download new model) | main |
| `c` | Toggle chat pane (right column) | main |
| `r` | Refresh models + running now | main |
| `?` | Help overlay (keymap from `keybindings.ts`) | any |
| `q` | Quit (clean `renderer.destroy()`) | any |
| `Ctrl+C` | Quit (renderer `exitOnCtrlC`) | any |
| `Esc` | Back to main view / dismiss overlay | non-main |

Pane-local (when focused):

| Key | Action | Pane |
|---|---|---|
| `↑`/`↓` or `j`/`k` | Move selection | Models |
| `d` | Delete selected model (ConfirmDialog) | Models |
| `u` | Unload selected running model | Models |
| `y` | Copy model (prompt for destination name) | Models |
| `↑`/`↓` `PgUp`/`PgDn` | Scroll | Logs |
| `g` / `End` | Jump to bottom (re-enable sticky) | Logs |

View-local:

| Key | Action | View |
|---|---|---|
| `Enter` | Send prompt / start pull | Chat / Pull |
| `a` | Abort stream / pull | Chat / Pull |
| `b` | Run preset benchmark prompt | Chat |
| `Esc` | (input focused) blur input; (else) close chat pane / leave view | Chat / Pull / Details |

Rationale for `Esc`-twice in Chat: matches terminal-muscle-memory (vim-like), avoids trapping users in an input.

---

## 6. Layout Sketch (≈120×40)

```
┌ OllamaManager ────────────────────────────────── api ● ok │ journal ● live │ gpu ● ok │ proc ● running ┐
│ ┌ Models (1) ───────────────────────┐ ┌ Stats (2) ──────────────────────────────────────────────┐ │
│ │ ▸ qwen3.5:9b          6.6 GB  Q4  │ │ GPU   util 31%   VRAM 1.1/12.0 GB   temp 53°C           │ │
│ │   qwen2.5-coder:14b  9.0 GB  Q4 ● │ │       ▂▂▃▅▇▅▃▂▂▁▂▃▄▅▆▇▇▆▅▄▃▂▂▃▄▅▅▆▇                    │ │
│ │   llama3.1:8b        4.7 GB  Q4   │ │ ollama (pid 73805)   CPU 45%   RSS 6.1 GB   threads 38  │ │
│ │   qwen2.5:0.5b       0.4 GB  Q8   │ │       ▁▂▂▄▇▇▅▃▂▂▁▁▂▃▃▄▅▆▆▅▄▃▂▁▁▂▃▄▄▅                    │ │
│ │                                   │ │ Running: qwen2.5-coder:14b  VRAM 9.6 GB  expires 4m32s  │ │
│ │                                   │ │ Benchmark: qwen3.5:9b  TTFT 212ms  42.6 tok/s           │ │
│ └───────────────────────────────────┘ └─────────────────────────────────────────────────────────┘ │
│ ┌ Logs (3) ───────────────────────────────────────────────────────────────────────────────────────┐ │
│ │ Sep 08 15:47:01 INFO [GPU] compute 8.6 driver 595.84 ...                                        │ │
│ │ Sep 08 15:47:02 INFO llama runner started                                                       │ │
│ │ ... (sticky-bottom streaming; ↑ pauses stick, g re-sticks)                                      │ │
│ └─────────────────────────────────────────────────────────────────────────────────────────────────┘ │
│ [1-3] panes  Tab cycle  m actions  p pull  c chat  r refresh  ? help  q quit                       │
└──────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Flex plan: root `<box flexDirection="column">`; top row `<box flexDirection="row" flexGrow={1}>` with Models pane `width="38%"`, Stats pane `flexGrow={1}`; Logs pane `flexGrow={1}` below; StatusBar fixed height 1. Borders `borderStyle="double"`, focused pane's border/title colored (yellow) *(focus must be visible at a glance; color is the cheapest signal)*. Chat pane: right column `width="34%"` inside the main row, transcript scrollbox + bench strip + input row. **Yoga rule (learned live): every `flexGrow` child needs `flexBasis: 0`** — with the default `auto`, scrollbox content height drives flex-shrink and collapses sibling panes.

---

## 7. Poll Cadences & Data-Volume Rationale

| Source | Cadence | Rationale |
|---|---|---|
| `nvidia-smi` | 2 s | Spawn costs ~20–50 ms; 2 s yields a smooth, readable VRAM/util trend at negligible CPU cost. Faster would burn CPU for eye-candy; slower makes sparklines useless. |
| `/proc` process stats | 2 s | Aligned with the GPU tick → one "metrics tick" concept; `/proc` reads are microseconds. CPU% is a Δ over elapsed wall time — 2 s is a stable Δ window. |
| `GET /api/tags` | 5 s + on-action + manual `r` | Model inventory rarely changes except through our own actions — every mutating store action triggers an immediate refresh. Tags stats disk stat for every model; 5 s keeps it bounded. |
| `GET /api/ps` | 5 s | Running set changes on keep_alive expiry (default 5 min); 5 s detection latency is plenty for a human-facing indicator. |
| journalctl | continuous (`-f`) | Push, not poll — this is the correct tool for logs. |
| Ollama API streaming (pull/generate) | continuous NDJSON | Push. Throttled at the store (100 ms flush), never at the transport. |

No WebSocket/SSE exists for tags/ps in the Ollama API — polling is the only option; the cadences above are the cheapest defensible ones.

---

## 8. Planned File Tree

```
OllamaManager/
├── docs/
│   └── ARCHITECTURE.md              # this document
├── package.json                     # deps: react@>=19.2, @opentui/react@0.5.11, @opentui/core@0.5.11 (exact pins)
├── tsconfig.json                    # jsxImportSource: "@opentui/react", jsx: react-jsx, moduleResolution bundler, types: bun
├── Notizen                          # user notes — DO NOT TOUCH
├── src/
│   ├── index.tsx                    # entry: createCliRenderer({exitOnCtrlC:true}) + createRoot + <App/>; top-level await (Bun)
│   ├── config.ts                    # constants: base URL, poll intervals, buffer caps, journal args, benchmark prompt, keybinding labels
│   ├── runtime.ts                   # composition root: service/store wiring, start/stop lifecycle, test overrides
│   ├── lib/
│   │   ├── ndjson.ts                # incremental NDJSON line splitter (chunk-boundary safe, streaming TextDecoder usage)
│   │   ├── ringbuffer.ts            # fixed-capacity O(1)-push ring buffer
│   │   ├── backoff.ts               # exponential backoff with jitter (journal restarts)
│   │   ├── events.ts                # tiny typed emitter
│   │   ├── format.ts                # bytes/duration/tok-per-s/table formatting (pure)
│   │   └── bench.ts                 # TTFT/tok-s benchmark math (pure, from GenerateFinalChunk)
│   ├── services/
│   │   ├── ollamaApi.ts             # typed Ollama REST client + NDJSON streams, AbortController, ApiError normalization
│   │   ├── journal.ts               # journalctl child process, JSON-line → LogEntry, status machine, backoff restart
│   │   ├── gpu.ts                   # nvidia-smi poller (2s), CSV row → GpuSample, status machine
│   │   ├── procstats.ts             # pgrep + /proc/<pid>/{stat,status} poller (2s), CPU%/RSS/threads
│   │   └── __fixtures__/            # sample NDJSON/CSV/proc files for tests
│   ├── stores/
│   │   ├── modelsStore.ts           # tags/ps/selection/details + apiStatus; owns 5s polling + mutate actions
│   │   ├── logStore.ts              # ring buffer (5000) + journal status; 100ms flush
│   │   ├── statsStore.ts            # GPU/proc samples, 150-pt series, benchmark results (cap 50)
│   │   ├── pullStore.ts             # active pulls, progress, abort controllers, pruning
│   │   ├── chatStore.ts             # chat session, streaming state, TTFT capture, benchmark trigger
│   │   └── uiStore.ts               # focusPane, view, textCapture flag (tiny)
│   ├── hooks/
│   │   └── useStore.ts              # useSyncExternalStore wrapper with selector
│   └── ui/
│       ├── App.tsx                  # shell: view switch, global keybindings, runtime lifecycle, focus routing
│       ├── keybindings.ts           # single-source keymap table + help text
│       ├── StatusBar.tsx            # integration status dots + hints
│       ├── panes/
│       │   ├── ModelsPane.tsx       # select list, running indicator, pane-local actions
│       │   ├── StatsPane.tsx        # GPU/CPU/RAM readouts, sparklines, running models, last bench
│       │   └── LogsPane.tsx         # scrollbox sticky log viewer
│       ├── views/
│       │   ├── PullView.tsx         # pull input + progress + abort
│       │   ├── DetailsView.tsx      # model details scrollbox (params/template/modelfile/capabilities)
│       │   ├── ChatView.tsx         # chat/benchmark streaming panel
│       │   ├── HelpOverlay.tsx      # keymap help
│       │   └── ConfirmDialog.tsx    # destructive-action confirmation
│       └── theme.ts                 # color constants only (fg colors, status dot colors)
├── tests live colocated as src/**/*.test.ts (bun test)
│   ├── lib/ndjson.test.ts           # chunk-boundary cases, malformed lines, CRLF
│   ├── lib/ringbuffer.test.ts       # eviction, sliceLast, capacity edge
│   ├── lib/backoff.test.ts          # sequence, cap, jitter bounds
│   ├── lib/bench.test.ts            # tok/s + TTFT math incl. nanosecond handling
│   ├── services/ollamaApi.test.ts   # fixture streams, abort semantics, error normalization (injected fetch)
│   ├── services/journal.test.ts     # fixture spawn, field mapping, restart/exit classification
│   ├── services/gpu.test.ts         # CSV parsing, N/A fields, ENOENT path
│   ├── services/procstats.test.ts   # /proc fixtures, CPU% delta math, pid-vanish → idle
│   └── stores/*.test.ts             # state transitions, throttle flush, caps
```

~26 source files, zero runtime deps beyond react/@opentui. *(Flat-ish structure under 4 folders — a project this size does not need deeper nesting.)*

---

## 9. Technology Decisions

| Area | Decision | Rationale | Alternatives considered |
|---|---|---|---|
| Runtime | Bun (user-confirmed, hard requirement) | Required; also gives test runner + spawn for free | Node — excluded by requirement |
| TUI | @opentui/react 0.5.11 + @opentui/core 0.5.11 (exact pins, no `^`) | User requirement; pre-1.0 → pin exact versions so upstream churn can't break a working build silently | Ink — excluded |
| React | **react ≥ 19.2.0** (verified official minimum for @opentui/react); pin exact resolved version | Renderer requires 19.2+; guessing a version risks a broken peer install | 18 — incompatible |
| State | Custom emitter stores + `useSyncExternalStore` | Zero deps, full control over snapshot throttling for high-frequency streams | zustand — extra dep for no gain at this size |
| HTTP/streaming | Built-in `fetch` + `ReadableStream` + `AbortController` | Bun-native; NDJSON is ~30 lines to parse by hand | undici/axios — deps for nothing |
| Child processes | `Bun.spawn` with **argv arrays only** | Injection-safe by construction; injectable for tests | shell strings — rejected (injection risk) |
| Testing | `bun test` (built-in) | Zero dev-dep overhead; fast; watch mode built in | vitest — extra config, no benefit here |
| Keymap | `useKeyboard` from @opentui/react (already a dependency) | Brief-verified API; avoids adding `@opentui/keymap` package | @opentui/keymap `KeymapProvider` — noted as fallback if `useKeyboard` proves insufficient in the Phase 1 spike |
| Time | `Date.now()` for wall-clock TTFT; monotonic `seq` for log ordering | Wall-clock is what a human benchmark expects; seq prevents clock-jitter reordering in logs | `performance.now` — unnecessary precision here |

Dependency manifest (final):
- **Runtime deps:** `react` (≥19.2, pinned), `@opentui/react` 0.5.11, `@opentui/core` 0.5.11 — nothing else.
- **Dev deps:** `typescript`, `@types/react`, `@types/bun`.

tsconfig note (to finalize during implementation per brief): `jsx: "react-jsx"`, `jsxImportSource: "@opentui/react"`, `moduleResolution: "bundler"`, `types: ["bun"]`, `strict: true`. The `/** @jsxImportSource @opentui/react */` pragma at the top of `index.tsx`/`App.tsx` is the belt-and-suspenders fallback documented by OpenTUI.

---

## 10. Design Patterns Applied

- **Composition root + dependency injection** (`runtime.ts`, constructor-injected `fetch`/`spawn`/fs) — every service unit-testable without network/processes.
- **Unidirectional dataflow / observer stores** — services emit → stores reduce → UI subscribes; no two-way binding anywhere.
- **Ring buffer** — all unbounded inputs (logs, series) are capacity-bounded by construction, not by hope.
- **Status machine per integration** — each external source has an explicit small enum (`live/restarting/unavailable`, `ok/error/unavailable`, `running/idle/error`) instead of booleans — the UI can always render *why* something is degraded.
- **Backpressure by coalescing** — 100 ms trailing-edge flushes at the store boundary; transport never throttled (no lost data), rendering never flooded.
- **Adapter** — services translate raw externals (JSON journal lines, CSV rows, /proc text, NDJSON streams) into typed domain events.

---

## 11. Robustness & Error Handling

| Failure | Detection | UI surface | Recovery |
|---|---|---|---|
| Ollama API down/restarting | 5s poll `fetch` network error | StatusBar api ● down, Models pane shows last-known list + banner | Poll continues every 5s; auto-recovers on next success; actions surface `ApiError.kind` inline |
| journalctl binary missing | spawn ENOENT | Logs pane banner: "journalctl not found — log streaming unavailable" | None (permanent); rest of app fully functional |
| journalctl permission denied | spawn EACCES / exit 1 | Logs pane banner: "permission denied — add user to adm group" | None (permanent) |
| journalctl crashes | child exit event | StatusBar journal ● restarting → ● live | Restart with backoff (1s→30s, cap 6 attempts → unavailable); ring buffer survives restarts |
| nvidia-smi missing | spawn ENOENT | Stats GPU section: "nvidia-smi not available" | None (permanent); CPU/RAM stats unaffected |
| nvidia-smi transient error | per-tick parse/spawn failure | GPU fields show `—` + error detail | Next tick retries (tick = backoff) |
| ollama process not running | pgrep empty | Proc section: "idle — ollama not running" | Normal state; re-`pgrep` every tick |
| Pull network failure mid-stream | fetch rejects / stream error | Pull row marked failed + error message | User can retry; aborted controller cleaned up |
| Malformed NDJSON line | parser stats | Silent for logs (counter only); inline error for API streams | Skip line, continue — never crash on upstream garbage |

Rules: (1) no external failure crashes the app or the render loop; (2) every degraded integration is *visible* and *named*; (3) permanent failures (ENOENT/EACCES) are distinguished from transient ones and don't burn restart attempts.

**Memory bounds:** logs ring 5000 (render tail 500) · metric series 150 pts · benchmarks 50 · chat messages 200 · pull map pruned 30 s after completion · malformed-line counters are numbers, not arrays. No unbounded collection exists in the design.

---

## 12. Testing Strategy

- Runner: `bun test`, tests colocated (`*.test.ts`), fixtures in `services/__fixtures__/`.
- Injectable seams (the only reason DI exists): `fetchImpl` (API), `spawnImpl` (journal/gpu), `readTextFileImpl` + `execPgrepImpl` (procstats). Real child processes/network are **never** required by unit tests.
- UI stays thin: components are projections of store snapshots; the testable logic lives in lib/stores. TUI rendering is validated by a manual checklist per phase (pre-1.0 lib has no reliable render-testing story — fighting that would cost more than it buys).

Phase-imperative tests:

| Phase | Mandatory tests |
|---|---|
| 2 | ndjson (chunk-boundary + malformed), ringbuffer, backoff, bench math, ollamaApi (fixtures + abort), journal (mapping + exit classification), gpu (CSV), procstats (Δ-CPU% + pid-vanish) |
| 3 | store transitions: modelsStore refresh/error states, logStore 100 ms flush + ring cap, pullStore throttled progress + abort cleanup |
| 4 | chatStore TTFT capture + benchmark push into statsStore |
| 5 | format utils regression |

Manual UI checklist (each phase): focus cycling, log stick/pause/re-stick, input keyboard capture, resize behavior, quit cleanliness.

---

## 13. Security Considerations

- **No shell interpolation, ever**: all child processes use fixed argv arrays; model names go through argv elements or JSON bodies, never command strings. *(Primary injection surface in this app is the model-name string typed by the user — closed by construction.)*
- Outbound to `http://127.0.0.1:11434` only; the app binds nothing. *(Smallest possible network posture.)*
- journalctl runs read-only via `adm` group; no elevation, no sudo anywhere.
- Destructive ops (delete, copy-overwrite) require explicit confirmation dialog. *(One keystroke must never delete gigabytes.)*
- No secrets: Ollama API is unauthenticated by design (localhost); nothing is stored beyond process memory.

---

## 14. Risks

**Top 3:**

| # | Risk | Prob. | Impact | Mitigation |
|---|---|---|---|---|
| 1 | **OpenTUI is pre-1.0 (0.5.11) — component/prop APIs may shift** (`select`/`scrollbox` props, hook signatures) | High (over project life) | Medium | Pin exact versions (no `^`); OpenTUI imports confined to `src/ui/` (services/lib never touch it); verified-API facts in this doc act as the contract; upgrades are deliberate, single-layer changes |
| 2 | **Focus & key-routing edge cases** — `<select>`/`<input>`/`<scrollbox>` internal key handling vs. global handler (does `select` swallow `Tab`? does `input` blur on Escape?) | Medium | Medium | Phase 1 spike verifies these three behaviors before any pane is built; single global `useKeyboard` in App with `textCapture` guard keeps routing in one file; keymap package (`@opentui/keymap`) documented as fallback |
| 3 | **NDJSON burst backpressure** — 18 GB pulls and long generations emit thousands of chunks; naive per-chunk `setState` would flood the React renderer | High (if ignored) | High (frozen UI) | Store-level 100 ms trailing-edge flush; ring buffers for logs/series; `useSyncExternalStore` (batched); abort always one keystroke away; renderer cost bounded by viewport culling |

Secondary risks: `CLK_TCK=100` assumption (mitigated: named constant, verify via `getconf CLK_TCK` during Phase 2); journalctl JSON field casing varies by systemd version (mitigated: fixture recorded from this machine — verified live); Bun not yet installed on this machine (prerequisite, see Roadmap Phase 1); `exitOnCtrlC` + `renderer.destroy()` double-exit paths (mitigated: `q` path and Ctrl+C path both end in `destroy()`, spike-verified).

---

## 15. Decision Records (summary)

| ID | Decision | Confidence | Alternatives rejected |
|---|---|---|---|
| ADR-1 | Bun + TS + @opentui/react 0.5.11, react ≥19.2 pinned exact | HIGH (user-fixed) | Node, Ink |
| ADR-2 | 4-layer strict DI: services / stores / ui / runtime composition root | HIGH | UI-calls-services-directly (untestable seam) |
| ADR-3 | Custom emitter stores + useSyncExternalStore, throttled snapshots | HIGH | zustand/redux (deps, no throttle control) |
| ADR-4 | Child processes via Bun.spawn argv-arrays, per-tick spawn for pollers | HIGH | long-lived `nvidia-smi -l`, shell strings |
| ADR-5 | journalctl with backoff restart; ENOENT/EACCES are terminal states | HIGH | infinite restart (burns CPU on permanent failures) |
| ADR-6 | Logs ring 5000 / series 150 / flush 100 ms | MEDIUM (tunable constants) | unbounded arrays, per-chunk renders |
| ADR-7 | Toggle views (not modal overlays) for details/pull; chat as right-hand pane (v1.1) | MEDIUM | modals (z-order behavior unverified in pre-1.0 lib) |
| ADR-8 | GPU 2s / proc 2s / tags+ps 5s poll cadences | HIGH | faster (CPU waste) / slower (stale UI) |
| ADR-9 | Chat TTFT = wall-clock to first non-empty response chunk; tok/s = eval_count/eval_duration | HIGH (API-verified) | token-estimation approaches |

---

## 16. Implementation Roadmap

> Prerequisite (before Phase 1): **install Bun** (`curl -fsSL https://bun.sh/install | bash`) — verified absent on this machine. README/`git init` are explicitly out of scope for this doc (handled separately later).

### Phase 1 — Scaffold + Shell (~2–4 h)
1. Install Bun; `bun init`; add deps (`@opentui/react@0.5.11 @opentui/core@0.5.11 react` — record resolved react version, pin exactly); dev deps (`typescript @types/react @types/bun`).
2. `tsconfig.json` (jsx fields per §9; verify against scaffold if `bun create tui --template react` is used as reference).
3. `index.tsx` entry + empty `App.tsx` with three bordered panes (static placeholder content), StatusBar, focus-pane state, Tab/1-3/`q` keybindings, runtime lifecycle stub (no services yet).
4. **Spike (timeboxed ≤45 min, findings → comments in `keybindings.ts`):** (a) does `<select>` swallow `Tab`? (b) `Escape` blur behavior of `<input>`; (c) `scrollbox` stickyScroll pause/resume; (d) quit via `q` → `renderer.destroy()` + `exitOnCtrlC` interplay.

**Acceptance:** app runs via `bun run src/index.tsx` (and `bun dev` script with `--watch`); three panes render at 120×40 with visible focus highlight; Tab/1/2/3 cycle focus; `q` exits cleanly with no lingering terminal state; spike findings documented.

### Phase 2 — Services + Stores (~4–6 h)
5. `lib/` complete (ndjson, ringbuffer, backoff, events, format, bench) + their tests.
6. `ollamaApi.ts` + fixture tests (tags/ps/show/pull/delete/copy/generate streams, abort semantics).
7. `journal.ts`, `gpu.ts`, `procstats.ts` + tests with injected spawn/fs.
8. Stores (models, logs, stats, pull, chat, ui) with 100 ms flush + caps + store tests.
9. `runtime.ts` wiring; verify live against the running Ollama instance (verified present: v0.33.3).

**Acceptance:** `bun test` green (all §12 Phase-2 tests); with the app still showing placeholder panes, a temp debug hook (or `bun test` integration test) demonstrates: live tags fetch, live journal entries flowing, live GPU samples; killing journalctl mid-stream triggers restart→backoff→live; stopping `ollama.service` flips apiStatus to `down` without crashing.

### Phase 3 — Panes (~6–8 h)
10. `ModelsPane` + selection + details/loading wiring; `StatsPane` + sparklines; `LogsPane` with sticky scroll + re-stick; StatusBar dots live.
11. `PullView` (input, start, progress bars, abort), `DetailsView`, `ConfirmDialog`, delete/copy/unload actions through stores.

**Acceptance:** end-to-end against live Ollama: list shows real models with size/quant/params; details view shows real modelfile/parameters/capabilities (e.g., qwen3.5:9b → tools+thinking); pulling a small model (e.g., `qwen2.5:0.5b`) shows live progress and aborts instantly on `a`; delete asks and works; unload removes model from running list; logs pane streams real journal lines and never freezes under `journalctl` flood (test: `logger` burst or restart loop); memory stays flat over 10 min (ring caps verified via debug line).

### Phase 4 — Chat / Benchmark (~4–6 h)
12. `ChatView`: transcript, input, streaming render, abort; TTFT capture at first non-empty chunk.
13. `bench.ts` integration: preset prompt run (`b`), result → `statsStore.benchmarks`; StatsPane shows last benchmark line.

**Acceptance:** streaming chat with a real model renders token-by-token (throttled, no flicker-flood); `a` aborts mid-stream cleanly; benchmark run records TTFT/tok-s/eval_count/prompt_eval_count that are consistent with `ollama ps`/expected RTX-3060 performance for that model class; results survive subsequent pulls/refreshes.

### Phase 5 — Polish (~2–4 h)
14. Help overlay from `keybindings.ts`; error banners for all §11 failure rows; graceful text when journalctl unavailable.
15. Robustness pass: restart-chaos test (stop/start ollama, kill journalctl repeatedly, unplugged nvidia-smi path) while UI stays responsive; caps verified; quit-teardown verified (no orphan journalctl processes after exit).
16. Format regression tests; final manual checklist sweep.

**Acceptance:** all §11 rows individually demonstrable; `pgrep journalctl` after quit shows no orphans; 10-minute chaos run with flat memory; every keybinding in §5 works as documented (help overlay matches reality).

**Total estimate:** ~18–28 h implementation (planning aid, not a commitment).

---

## 17. Open Items (resolve during implementation, not design blockers)

1. Pin the exact resolved `react` version (≥19.2.0) that `bun install` selects with `@opentui/react@0.5.11`.
2. Final tsconfig fields (per brief: verify during implementation; §9 documents the intended set).
3. Spike outcomes from Phase 1 step 4 (Tab/Escape/stickyScroll/quit) — may adjust the key-routing implementation inside `App.tsx` only; the keybinding *map* (§5) is stable regardless.
4. `getconf CLK_TCK` on this machine to confirm the CLK_TCK=100 constant.
