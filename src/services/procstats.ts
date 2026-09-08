/**
 * ollama server process stats: pgrep + /proc/<pid>/stat|status (§4.5).
 *
 * - `pgrep -o -x ollama` → oldest matching pid (the `ollama serve` main
 *   process; per-model VRAM comes from /api/ps, not runner children).
 * - /proc/<pid>/stat: parse AFTER the last `)` (comm may contain spaces and
 *   parens). utime is field 14, stime field 15, num_threads field 20
 *   (1-based with pid=1, comm=2 → offsets 11/12/17 in the post-comm split).
 * - CPU% = Δ(utime+stime) / (Δwall_s × CLK_TCK) × 100.
 * - "idle" (ollama not running) is a NORMAL status, not an error.
 */
import { config } from "../config";
import { Emitter } from "../lib/events";
import { type TimerDeps, realTimerDeps } from "../lib/timers";
import { type ExecFn, type ReadTextFileFn, defaultExec, defaultReadTextFile } from "./types";

export type ProcStatus = "running" | "idle" | "error";
export type ProcSample = { ts: number; pid: number; cpuPct: number; rssBytes: number; threads: number };

export type ProcEvents = {
  sample: ProcSample;
  status: { status: ProcStatus; detail?: string };
};

interface CpuTicks {
  pid: number;
  ticks: number;
  atMs: number;
}

export class ProcessStatsPoller extends Emitter<ProcEvents> {
  private readonly readTextFile: ReadTextFileFn;
  private readonly execPgrep: ExecFn;
  private readonly timers: TimerDeps;
  private readonly intervalMs: number;

  private timer: unknown = null;
  private _latest: ProcSample | null = null;
  private _status: ProcStatus = "idle";
  private detail: string | undefined;
  private prevCpu: CpuTicks | null = null;

  constructor(deps?: {
    readTextFileImpl?: ReadTextFileFn;
    execPgrepImpl?: ExecFn;
    intervalMs?: number;
    timers?: TimerDeps;
  }) {
    super();
    this.readTextFile = deps?.readTextFileImpl ?? defaultReadTextFile;
    this.execPgrep = deps?.execPgrepImpl ?? defaultExec;
    this.intervalMs = deps?.intervalMs ?? config.poll.procMs;
    this.timers = deps?.timers ?? realTimerDeps;
  }

  get status(): ProcStatus {
    return this._status;
  }

  get statusDetail(): string | undefined {
    return this.detail;
  }

  latest(): ProcSample | null {
    return this._latest;
  }

  start(): void {
    if (this.timer) return;
    this.tick();
    this.timer = this.timers.setInterval(() => this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      this.timers.clearInterval(this.timer);
      this.timer = null;
    }
  }

  private setStatus(status: ProcStatus, detail?: string): void {
    this._status = status;
    this.detail = detail;
    this.emit("status", { status, detail });
  }

  private async tick(): Promise<void> {
    const nowMs = this.timers.now();

    // 1. Discover pid (oldest ollama process; runner children excluded).
    let pid: number | null = null;
    try {
      const res = await this.execPgrep(config.proc.argv);
      if (res.exitCode === 0) {
        const parsed = Number.parseInt(res.stdout.trim(), 10);
        if (Number.isInteger(parsed) && parsed > 0) pid = parsed;
      }
    } catch (err) {
      this.setStatus("error", `pgrep failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    // 2. No pid → idle (normal state); emit a zero-sample so charts decay.
    if (pid === null) {
      this.prevCpu = null;
      const zero: ProcSample = { ts: nowMs, pid: 0, cpuPct: 0, rssBytes: 0, threads: 0 };
      this._latest = zero;
      this.setStatus("idle");
      this.emit("sample", zero);
      return;
    }

    // 3. Read /proc/<pid>/stat and /proc/<pid>/status.
    let stat: string;
    let statusFile: string;
    try {
      [stat, statusFile] = await Promise.all([
        this.readTextFile(config.proc.statPath(pid)),
        this.readTextFile(config.proc.statusPath(pid)),
      ]);
    } catch (err) {
      // Root-owned proc entries can be unreadable — degrade to error, keep polling.
      this.setStatus("error", `/proc/${pid} unreadable: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const threadsFromStat = parseStatThreads(stat);
    const rssBytes = parseStatusRss(statusFile);
    const threads = parseStatusThreads(statusFile) ?? threadsFromStat;
    if (threads === null || rssBytes === null) {
      this.setStatus("error", `unparseable /proc/${pid} content`);
      return;
    }

    const ticks = parseStatCpuTicks(stat);
    if (ticks === null) {
      this.setStatus("error", `unparseable /proc/${pid}/stat`);
      return;
    }

    // 4. CPU% needs a previous sample from the SAME pid.
    let cpuPct = 0;
    let note: string | undefined;
    if (this.prevCpu && this.prevCpu.pid === pid) {
      const deltaTicks = ticks - this.prevCpu.ticks;
      const deltaMs = Math.max(1, nowMs - this.prevCpu.atMs);
      const elapsedSec = deltaMs / 1000;
      cpuPct = Math.max(0, (deltaTicks / (elapsedSec * config.proc.clkTck)) * 100);
      note = undefined;
    } else {
      // First tick after (re)discovering a pid has no Δ window yet.
      note = "warming up — first sample";
    }
    this.prevCpu = { pid, ticks, atMs: nowMs };

    const sample: ProcSample = { ts: nowMs, pid, cpuPct, rssBytes, threads };
    this._latest = sample;
    this.setStatus("running", note);
    this.emit("sample", sample);
  }
}

/** utime (field 14) + stime (field 15) in clock ticks; null when unparseable. */
export function parseStatCpuTicks(stat: string): number | null {
  const closeIdx = stat.lastIndexOf(")");
  if (closeIdx === -1) return null;
  // rest[0] = field 3 (state); utime = field 14 → rest[11]; stime = field 15 → rest[12].
  const rest = stat.slice(closeIdx + 1).trim().split(/\s+/);
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
  return utime + stime;
}

/** num_threads = field 20 → rest[17] in the post-comm split. */
export function parseStatThreads(stat: string): number | null {
  const closeIdx = stat.lastIndexOf(")");
  if (closeIdx === -1) return null;
  const rest = stat.slice(closeIdx + 1).trim().split(/\s+/);
  const threads = Number(rest[17]);
  return Number.isFinite(threads) ? threads : null;
}

/** `VmRSS:  123456 kB` → bytes. */
export function parseStatusRss(status: string): number | null {
  const m = /VmRSS:\s+(\d+)\s+kB/.exec(status);
  if (!m) return null;
  const kb = Number(m[1]);
  return Number.isFinite(kb) ? kb * 1024 : null;
}

/** `Threads:  38` → 38. */
export function parseStatusThreads(status: string): number | null {
  const m = /Threads:\s+(\d+)/.exec(status);
  if (!m) return null;
  const t = Number(m[1]);
  return Number.isFinite(t) ? t : null;
}
