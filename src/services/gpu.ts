/**
 * GPU metrics via a fresh `nvidia-smi` spawn per 2s tick (§4.4, ADR-4).
 * Per-tick spawn gives one stop/start path, injectable timing, and no
 * long-lived child to babysit; spawn cost (~20–50ms) is irrelevant at 2s.
 */
import { config } from "../config";
import { Emitter } from "../lib/events";
import { type TimerDeps, realTimerDeps } from "../lib/timers";
import { type SpawnFn, defaultSpawn } from "./types";

export type GpuStatus = "ok" | "unavailable" | "error";
export type GpuSample = {
  ts: number;
  utilPct: number;
  memUsedMb: number;
  memTotalMb: number;
  tempC: number;
  fanPct: number | null;
  powerW: number | null;
};

export type GpuEvents = {
  sample: GpuSample;
  status: { status: GpuStatus; detail?: string };
};

export class GpuMetricsPoller extends Emitter<GpuEvents> {
  private readonly spawnImpl: SpawnFn;
  private readonly timers: TimerDeps;
  private readonly intervalMs: number;

  private timer: unknown = null;
  private _latest: GpuSample | null = null;
  private _status: GpuStatus = "unavailable";
  private detail: string | undefined;
  /** Set once when the binary is missing — permanent, timer keeps running but skips spawn. */
  private permanentlyUnavailable = false;

  constructor(deps?: { spawnImpl?: SpawnFn; intervalMs?: number; timers?: TimerDeps }) {
    super();
    this.spawnImpl = deps?.spawnImpl ?? defaultSpawn;
    this.intervalMs = deps?.intervalMs ?? config.poll.gpuMs;
    this.timers = deps?.timers ?? realTimerDeps;
  }

  get status(): GpuStatus {
    return this._status;
  }

  get statusDetail(): string | undefined {
    return this.detail;
  }

  latest(): GpuSample | null {
    return this._latest;
  }

  start(): void {
    if (this.timer) return;
    this.tick(); // first sample immediately, then steady cadence
    this.timer = this.timers.setInterval(() => this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      this.timers.clearInterval(this.timer);
      this.timer = null;
    }
  }

  private setStatus(status: GpuStatus, detail?: string): void {
    this._status = status;
    this.detail = detail;
    this.emit("status", { status, detail });
  }

  private tick(): void {
    if (this.permanentlyUnavailable) return; // cheap idle; no special-casing later
    let proc: ReturnType<SpawnFn>;
    try {
      proc = this.spawnImpl(config.gpu.argv);
    } catch (err) {
      const code = (err as { code?: string })?.code ?? "";
      if (code === "ENOENT") {
        this.permanentlyUnavailable = true;
        this.setStatus("unavailable", "nvidia-smi not installed");
        return;
      }
      this.setStatus("error", `spawn failed: ${err instanceof Error ? err.message : String(err)}`);
      return; // next tick retries naturally (tick = backoff)
    }

    void (async () => {
      try {
        const stdout = proc.stdout ? await new Response(proc.stdout).text() : "";
        const code = await proc.exited;
        if (code !== 0) {
          this.setStatus("error", `nvidia-smi exited with code ${code}`);
          return;
        }
        const sample = parseGpuCsv(stdout, this.timers.now());
        if (!sample) {
          this.setStatus("error", "unparseable nvidia-smi output");
          return;
        }
        this._latest = sample;
        this.setStatus("ok");
        this.emit("sample", sample);
      } catch (err) {
        this.setStatus("error", `nvidia-smi read failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  }
}

/**
 * Parse the FIRST row of CSV output (single-GPU machine; multi-GPU is a
 * non-goal). Verified live shape: `31, 1148, 12288, 53, 40, 68.12`.
 * Empty/"N/A" fields → null for nullable metrics.
 */
export function parseGpuCsv(csv: string, nowMs: number): GpuSample | null {
  const row = csv
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!row) return null;
  const cells = row.split(",").map((c) => c.trim());
  if (cells.length < 4) return null;

  const num = (raw: string | undefined): number | null => {
    if (raw === undefined) return null;
    const v = raw === "" || raw.toUpperCase() === "N/A" ? Number.NaN : Number(raw);
    return Number.isFinite(v) ? v : null;
  };

  const utilPct = num(cells[0]);
  const memUsedMb = num(cells[1]);
  const memTotalMb = num(cells[2]);
  const tempC = num(cells[3]);
  if (utilPct === null || memUsedMb === null || memTotalMb === null || tempC === null) return null;

  return {
    ts: nowMs,
    utilPct,
    memUsedMb,
    memTotalMb,
    tempC,
    fanPct: num(cells[4]),
    powerW: num(cells[5]),
  };
}
