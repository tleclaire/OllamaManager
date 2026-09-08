import { beforeAll, describe, expect, test } from "bun:test";
import { JournalLogSource, type LogEntry } from "./journal";
import { config } from "../config";
import { FakeTimers } from "../test-support/fakeTimers";
import { type SpawnFn, type SpawnedProcess } from "./types";

const FIXTURES = new URL("./__fixtures__/", import.meta.url).pathname;
let fixtureLines: string;

beforeAll(async () => {
  fixtureLines = await Bun.file(`${FIXTURES}journal-lines.ndjson`).text();
});

/** Let pending microtasks (stream readers) run. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
    await new Promise<void>((r) => setImmediate(r));
  }
}

interface FakeProcHandle {
  proc: SpawnedProcess;
  pushStdout(text: string): void;
  closeStdout(): void;
  setStderr(text: string): void;
  exit(code: number): void;
  killed: number | null;
}

function makeFakeProc(): FakeProcHandle {
  const handle: FakeProcHandle = {
    killed: null,
    proc: null as unknown as SpawnedProcess,
    pushStdout: () => {},
    closeStdout: () => {},
    setStderr: () => {},
    exit: () => {},
  };
  const encoder = new TextEncoder();
  let stdoutController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let stderrController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let exitResolver: ((code: number) => void) | null = null;
  const exited = new Promise<number>((resolve) => {
    exitResolver = resolve;
  });

  handle.proc = {
    stdout: new ReadableStream<Uint8Array>({
      start(c) {
        stdoutController = c;
      },
    }),
    stderr: new ReadableStream<Uint8Array>({
      start(c) {
        stderrController = c;
      },
    }),
    exited,
    kill: (signal?: number) => {
      handle.killed = signal ?? 15;
      exitResolver?.(143); // SIGTERM default exit code convention
    },
  };
  handle.pushStdout = (text) => stdoutController?.enqueue(encoder.encode(text));
  handle.closeStdout = () => {
    try {
      stdoutController?.close();
    } catch {
      /* already closed */
    }
  };
  handle.setStderr = (text) => stderrController?.enqueue(encoder.encode(text));
  handle.exit = (code) => {
    handle.closeStdout();
    exitResolver?.(code);
  };
  return handle;
}

function spawnFromProcs(procs: FakeProcHandle[], onSpawn?: () => void): SpawnFn {
  let index = 0;
  return () => {
    onSpawn?.();
    const proc = procs[index];
    index++;
    if (!proc) {
      const err = new Error("spawn ENOENT") as Error & { code?: string };
      err.code = "ENOENT";
      throw err;
    }
    return proc.proc;
  };
}

describe("JournalLogSource — entry mapping", () => {
  test("maps fixture lines: µs→ms timestamps, priorities, seq; skips malformed/empty", async () => {
    const proc = makeFakeProc();
    const timers = new FakeTimers();
    const src = new JournalLogSource({ spawnImpl: spawnFromProcs([proc]), timers });
    const entries: LogEntry[] = [];
    src.on("entry", (e) => entries.push(e));
    src.start();

    proc.pushStdout(fixtureLines);
    await flushMicrotasks();

    // 5 valid entries; malformed JSON, empty MESSAGE skipped → 6 dropped lines.
    expect(entries).toHaveLength(6);
    expect(entries[0]?.ts).toBe(1_757_339_221_000); // µs string → ms
    expect(entries[0]?.level).toBe("info");
    expect(entries[0]?.seq).toBe(1);
    expect(entries[3]?.level).toBe("err"); // PRIORITY 3
    expect(entries[2]?.level).toBe("warn"); // PRIORITY 4
    expect(entries[4]?.level).toBe("debug"); // PRIORITY 7
    expect(entries[5]?.message).toBe("after garbage");
    expect(entries[5]?.seq).toBe(6); // monotonic across skips
    // Only the raw-malformed line counts; the empty-MESSAGE line is valid JSON
    // (skipped by field mapping, not by the parser).
    expect(src.malformed).toBe(1);
    expect(src.status).toBe("live");

    src.stop();
  });

  test("emits starting → live status sequence", async () => {
    const proc = makeFakeProc();
    const src = new JournalLogSource({ spawnImpl: spawnFromProcs([proc]), timers: new FakeTimers() });
    const statuses: string[] = [];
    src.on("status", (s) => statuses.push(s.status));
    src.start();
    expect(statuses).toEqual(["starting", "live"]);
    src.stop();
  });
});

describe("JournalLogSource — exit classification", () => {
  test("exit code 1 with permission hint on stderr → unavailable (terminal)", async () => {
    const proc = makeFakeProc();
    const timers = new FakeTimers();
    const src = new JournalLogSource({ spawnImpl: spawnFromProcs([proc]), timers });
    const statuses: { status: string; detail?: string }[] = [];
    src.on("status", (s) => statuses.push(s));
    src.start();
    proc.setStderr("Hint: You are currently not seeing messages from other users and the system.");
    proc.exit(1);
    await flushMicrotasks();

    expect(src.status).toBe("unavailable");
    expect(src.statusDetail).toContain("permission denied");
    // No restart scheduled — permanent failure must not burn attempts.
    expect(timers.pendingCount).toBe(0);
    src.stop();
  });

  test("exit code 1 without hint → restarting, respawn after backoff", async () => {
    const first = makeFakeProc();
    const second = makeFakeProc();
    const timers = new FakeTimers();
    let spawns = 0;
    const src = new JournalLogSource({
      spawnImpl: spawnFromProcs([first, second], () => spawns++),
      timers,
    });
    src.start();
    expect(spawns).toBe(1);
    first.exit(1);
    await flushMicrotasks();
    expect(src.status).toBe("restarting");

    timers.advance(1200); // attempt 1 backoff ≈ 1000ms ±20%
    expect(spawns).toBe(2);
    expect(src.status).toBe("live");
    src.stop();
  });

  test("gives up after maxAttempts → unavailable with detail", async () => {
    const procs = Array.from({ length: config.journal.restart.maxAttempts }, () => makeFakeProc());
    const timers = new FakeTimers();
    const src = new JournalLogSource({ spawnImpl: spawnFromProcs(procs), timers });
    src.start();
    for (let i = 0; i < config.journal.restart.maxAttempts; i++) {
      procs[i]?.exit(1);
      await flushMicrotasks();
      timers.advance(config.journal.restart.maxMs + 1); // always past any backoff
    }
    expect(src.status).toBe("unavailable");
    expect(src.statusDetail).toContain("gave up after");
    src.stop();
  });

  test("spawn ENOENT → unavailable 'journalctl not found', no restart", async () => {
    const timers = new FakeTimers();
    const src = new JournalLogSource({
      spawnImpl: () => {
        const err = new Error("Failed to spawn") as Error & { code?: string };
        err.code = "ENOENT";
        throw err;
      },
      timers,
    });
    const statuses: { status: string; detail?: string }[] = [];
    src.on("status", (s) => statuses.push(s));
    src.start();
    expect(src.status).toBe("unavailable");
    expect(src.statusDetail).toBe("journalctl not found");
    expect(timers.pendingCount).toBe(0);
  });

  test("stop() SIGTERMs the live child and clears restart timers", async () => {
    const proc = makeFakeProc();
    const timers = new FakeTimers();
    const src = new JournalLogSource({ spawnImpl: spawnFromProcs([proc]), timers });
    src.start();
    src.stop(); // child still running → SIGTERM
    expect(proc.killed).toBe(15);
    // Exactly one timer remains: the SIGKILL escalation after killGraceMs.
    expect(timers.pendingCount).toBe(1);
    timers.advance(config.journal.killGraceMs + 1);
    expect(timers.pendingCount).toBe(0);
    // The resolved exit (from our own kill) scheduled no restart.
    await flushMicrotasks();
    expect(timers.pendingCount).toBe(0);
  });

  test("start() after stop() revives the source and ignores the stale child's exit", async () => {
    const first = makeFakeProc();
    const second = makeFakeProc();
    const timers = new FakeTimers();
    let spawns = 0;
    const src = new JournalLogSource({
      spawnImpl: spawnFromProcs([first, second], () => spawns++),
      timers,
    });

    src.start();
    expect(spawns).toBe(1);
    src.stop(); // SIGTERMs the first child; its exit resolution is still pending
    expect(first.killed).toBe(15);

    // Revive WITHOUT flushing microtasks first — the stale exit must land
    // after the fresh child is already registered.
    src.start();
    expect(spawns).toBe(2);
    expect(src.status).toBe("live");

    await flushMicrotasks(); // the first child's exit resolves NOW
    expect(src.status).toBe("live"); // not "restarting" — stale exit ignored
    // Only the old SIGKILL escalation timer remains; no restart was scheduled.
    expect(timers.pendingCount).toBe(1);

    // The revived source actually streams entries.
    const entries: LogEntry[] = [];
    src.on("entry", (e) => entries.push(e));
    second.pushStdout('{"MESSAGE":"revived","PRIORITY":6,"__REALTIME_TIMESTAMP":"1757339221000000"}\n');
    await flushMicrotasks();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.message).toBe("revived");

    src.stop();
    timers.advance(config.journal.killGraceMs + 1);
    await flushMicrotasks();
    expect(timers.pendingCount).toBe(0);
  });
});
