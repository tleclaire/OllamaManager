/**
 * Live log source: `journalctl -u ollama -f -o json` child process (§4.3).
 *
 * Status machine: starting → live → (restarting → live)* → unavailable.
 * ENOENT/EACCES are TERMINAL states (permanent failures don't burn restart
 * attempts, ADR-5). Restarts use exponential backoff, max 6 attempts.
 * All child processes use fixed argv arrays — never shell strings (§13).
 */
import { config } from "../config";
import { backoffDelay } from "../lib/backoff";
import { Emitter } from "../lib/events";
import { createNdjsonParser } from "../lib/ndjson";
import { type TimerDeps, realTimerDeps } from "../lib/timers";
import { type SpawnFn, type SpawnedProcess, defaultSpawn } from "./types";

export type JournalStatus = "starting" | "live" | "unavailable" | "restarting";
export type LogLevel = "err" | "warn" | "info" | "debug";
export type LogEntry = { ts: number; seq: number; level: LogLevel; message: string };

export type JournalEvents = {
  entry: LogEntry;
  status: { status: JournalStatus; detail?: string };
};

/** journald PRIORITY → our level (7=debug, 6/5=info, 4=warn, ≤3=err). */
function priorityToLevel(priority: unknown): LogLevel {
  const p = typeof priority === "number" ? priority : Number.parseInt(String(priority ?? ""), 10);
  if (Number.isNaN(p) || p <= 3) return "err";
  if (p === 4) return "warn";
  if (p >= 7) return "debug";
  return "info";
}

/** Raw journald JSON line fields we consume. */
interface JournalLine {
  MESSAGE?: unknown;
  PRIORITY?: unknown;
  __REALTIME_TIMESTAMP?: unknown;
}

export class JournalLogSource extends Emitter<JournalEvents> {
  private readonly spawnImpl: SpawnFn;
  private readonly timers: TimerDeps;
  private readonly unit: string;

  private proc: ReturnType<SpawnFn> | null = null;
  private stopped = false;
  private restartTimer: unknown = null;
  private killTimer: unknown = null;
  private attempt = 0;
  private seq = 0;
  private malformedCount = 0;
  private _status: JournalStatus = "starting";
  private detail: string | undefined;

  constructor(deps?: { spawnImpl?: SpawnFn; unit?: string; timers?: TimerDeps }) {
    super();
    this.spawnImpl = deps?.spawnImpl ?? defaultSpawn;
    this.unit = deps?.unit ?? config.journal.unit;
    this.timers = deps?.timers ?? realTimerDeps;
  }

  get status(): JournalStatus {
    return this._status;
  }

  get statusDetail(): string | undefined {
    return this.detail;
  }

  /** Malformed JSON lines seen (exposed for the log store's "dropped" counter). */
  get malformed(): number {
    return this.malformedCount;
  }

  start(): void {
    // Reset the stop flag so a start() after stop() revives the source, like
    // every other service (review fix: stopped was never reset). Guards below
    // still prevent double-spawning a live or already-restarting source.
    this.stopped = false;
    if (this.proc || this.restartTimer) return;
    this.setStatus("starting");
    this.spawnAttempt(1);
  }

  /** Kill the child and clear all timers — leak-free teardown (§4.3). */
  stop(): void {
    this.stopped = true;
    if (this.restartTimer) {
      this.timers.clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.clearKillTimer();
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      proc.kill(15); // SIGTERM
      // Escalate to SIGKILL if it ignores the polite request.
      this.killTimer = this.timers.setTimeout(() => {
        try {
          proc.kill(9);
        } catch {
          // already gone
        }
      }, config.journal.killGraceMs);
    }
  }

  private setStatus(status: JournalStatus, detail?: string): void {
    this._status = status;
    this.detail = detail;
    this.emit("status", { status, detail });
  }

  private clearKillTimer(): void {
    if (this.killTimer) {
      this.timers.clearTimeout(this.killTimer);
      this.killTimer = null;
    }
  }

  private spawnAttempt(attempt: number): void {
    if (this.stopped) return;
    this.attempt = attempt;

    let proc: ReturnType<SpawnFn>;
    try {
      // Fixed argv array — user input never reaches a shell (§13).
      proc = this.spawnImpl(["journalctl", "-u", this.unit, "-f", "-o", "json"]);
    } catch (err) {
      this.classifySpawnError(err, attempt);
      return;
    }
    this.proc = proc;
    this.setStatus("live");

    // Track stderr (bounded) for permission-denied classification.
    let stderrTail = "";
    if (proc.stderr) {
      const stderrReader = proc.stderr.getReader();
      const decoder = new TextDecoder();
      void (async () => {
        try {
          for (;;) {
            const { done, value } = await stderrReader.read();
            if (done) break;
            stderrTail = (stderrTail + decoder.decode(value, { stream: true })).slice(-500);
          }
        } catch {
          // stderr stream error — classification falls back to exit-code logic.
        }
      })();
    }

    // stdout → NDJSON → LogEntry
    if (proc.stdout) {
      const decoder = new TextDecoder();
      const parser = createNdjsonParser<JournalLine>((line) => {
        const message = line.MESSAGE;
        if (typeof message !== "string" || message.length === 0) return; // skip, per §4.3
        const micros = Number(line.__REALTIME_TIMESTAMP);
        const ts = Number.isFinite(micros) && micros > 0 ? micros / 1000 : this.timers.now();
        this.seq += 1;
        this.emit("entry", {
          ts,
          seq: this.seq,
          level: priorityToLevel(line.PRIORITY),
          message,
        });
      });
      const reader = proc.stdout.getReader();
      void (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            parser.feed(decoder.decode(value, { stream: true }));
            this.malformedCount = parser.stats().malformed;
          }
          parser.feed(decoder.decode());
          parser.end();
          this.malformedCount = parser.stats().malformed;
        } catch {
          // stdout read error → the exited promise fires and drives recovery.
        }
      })();
    }

    void proc.exited.then((code) => this.onExit(proc, code, attempt, stderrTail));
  }

  private classifySpawnError(err: unknown, attempt: number): void {
    const code = (err as { code?: string })?.code ?? "";
    if (code === "ENOENT") {
      // Binary absence is permanent, not transient (ADR-5) — no restart.
      this.setStatus("unavailable", "journalctl not found");
      return;
    }
    if (code === "EACCES" || code === "EPERM") {
      this.setStatus("unavailable", "permission denied — add user to adm group");
      return;
    }
    this.scheduleRestart(attempt, `spawn failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  private onExit(proc: SpawnedProcess, code: number, attempt: number, stderrTail: string): void {
    // Ignore exits of children this instance no longer owns: torn down by
    // stop() (proc nulled before the exit resolves) or replaced by a fresh
    // start() after stop() — a stale exit must never clobber the new child
    // or schedule a bogus restart.
    if (this.stopped || this.proc !== proc) return;
    this.proc = null;

    // journalctl exits 1 without adm membership and prints a hint on stderr.
    const stderrHint = stderrTail.toLowerCase();
    if (
      code === 1 &&
      (stderrHint.includes("permission") ||
        stderrHint.includes("not seeing messages") ||
        stderrHint.includes("access denied"))
    ) {
      this.setStatus("unavailable", "permission denied — add user to adm group");
      return;
    }
    this.scheduleRestart(attempt, `journalctl exited with code ${code}`);
  }

  private scheduleRestart(attempt: number, reason: string): void {
    if (this.stopped) return;
    if (attempt >= config.journal.restart.maxAttempts) {
      this.setStatus(
        "unavailable",
        `gave up after ${config.journal.restart.maxAttempts} attempts (${reason})`,
      );
      return;
    }
    this.setStatus("restarting", reason);
    const delay = backoffDelay(attempt, {
      baseMs: config.journal.restart.baseMs,
      maxMs: config.journal.restart.maxMs,
    });
    this.restartTimer = this.timers.setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopped) this.spawnAttempt(attempt + 1);
    }, delay);
  }
}
