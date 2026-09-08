/**
 * Central configuration: every tunable constant in one place.
 * Per ARCHITECTURE.md §1.2 there is deliberately no config-file support.
 */

export const config = {
  /** Local Ollama daemon (no auth by design, localhost-only). */
  baseUrl: "http://127.0.0.1:11434",

  poll: {
    /** nvidia-smi cadence (ADR-8: 2s — smooth sparklines at negligible CPU cost). */
    gpuMs: 2000,
    /** /proc process stats cadence (aligned with GPU tick). */
    procMs: 2000,
    /** GET /api/tags cadence (inventory changes mostly through our own actions). */
    tagsMs: 5000,
    /** GET /api/ps cadence (running set changes on keep_alive expiry). */
    psMs: 5000,
  },

  /** Timeout for non-streaming API calls — a hung API must not freeze a poll cycle. */
  apiTimeoutMs: 5000,

  buffers: {
    /** Live log ring capacity (ADR-6). */
    logRing: 5000,
    /** Log rows handed to the UI (rendering 5000 rows would fight culling). */
    logRenderTail: 500,
    /** Metric series capacity (~5 min at 2s cadence). */
    series: 150,
    /** Sparklines read the last N points. */
    sparklinePoints: 60,
    /** Stored benchmark results. */
    benchmarks: 50,
    /** Chat transcript messages. */
    chatMessages: 200,
  },

  /** Trailing-edge flush interval for high-frequency stores (ADR-6). */
  flushMs: 100,

  /** Finished pulls stay visible for this long, then are pruned. */
  pullPruneMs: 30_000,

  journal: {
    unit: "ollama",
    argv: ["journalctl", "-u", "ollama", "-f", "-o", "json"] as string[],
    /** Backoff restart policy for transient journalctl exits. */
    restart: { baseMs: 1000, maxMs: 30_000, maxAttempts: 6 },
    /** SIGKILL grace period after SIGTERM in stop(). */
    killGraceMs: 2000,
  },

  gpu: {
    argv: [
      "nvidia-smi",
      "--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,fan.speed,power.draw",
      "--format=csv,noheader,nounits",
    ] as string[],
  },

  proc: {
    argv: ["pgrep", "-o", "-x", "ollama"] as string[],
    /** Linux userland default since forever (verified via `getconf CLK_TCK` = 100). */
    clkTck: 100,
    statPath: (pid: number) => `/proc/${pid}/stat`,
    statusPath: (pid: number) => `/proc/${pid}/status`,
  },

  /** Preset prompt for the `b` benchmark run (long enough to measure steady-state tok/s). */
  benchmarkPrompt:
    "Explain in detail how a transformer's self-attention mechanism works, including multi-head attention, positional encoding, and why residual connections help training stability.",
} as const;

export type Config = typeof config;
