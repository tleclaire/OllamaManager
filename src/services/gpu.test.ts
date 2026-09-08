import { beforeAll, describe, expect, test } from "bun:test";
import { GpuMetricsPoller, parseGpuCsv } from "./gpu";
import { FakeTimers } from "../test-support/fakeTimers";
import { type SpawnFn, type SpawnedProcess } from "./types";

const FIXTURES = new URL("./__fixtures__/", import.meta.url).pathname;
let fixtureCsv: string;

beforeAll(async () => {
  fixtureCsv = await Bun.file(`${FIXTURES}gpu-csv.txt`).text();
});

describe("parseGpuCsv", () => {
  test("parses the verified live row shape", () => {
    const s = parseGpuCsv("31, 1148, 12288, 53, 40, 68.12\n", 1000);
    expect(s).toEqual({
      ts: 1000,
      utilPct: 31,
      memUsedMb: 1148,
      memTotalMb: 12288,
      tempC: 53,
      fanPct: 40,
      powerW: 68.12,
    });
  });

  test("empty and N/A fields become null for nullable metrics", () => {
    const s = parseGpuCsv("0, 500, 12288, 45, N/A, \n", 1);
    expect(s?.fanPct).toBeNull();
    expect(s?.powerW).toBeNull();
    expect(s?.utilPct).toBe(0);
  });

  test("missing required field → null sample", () => {
    expect(parseGpuCsv("31, 1148, N/A, 53, 40, 68", 1)).toBeNull();
    expect(parseGpuCsv("", 1)).toBeNull();
    expect(parseGpuCsv("garbage only one cell", 1)).toBeNull();
  });
});

/** Fake spawn serving CSV output on stdout. */
function fakeGpuSpawn(output: string, exitCode = 0, throwCode?: string): { spawn: SpawnFn; spawnCount: () => number } {
  let count = 0;
  const spawn: SpawnFn = () => {
    count++;
    if (throwCode) {
      const err = new Error(`spawn failed ${throwCode}`) as Error & { code?: string };
      err.code = throwCode;
      throw err;
    }
    const encoder = new TextEncoder();
    return {
      stdout: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(encoder.encode(output));
          c.close();
        },
      }),
      stderr: new ReadableStream<Uint8Array>({ start() {} }),
      exited: Promise.resolve(exitCode),
      kill: () => {},
    } satisfies SpawnedProcess;
  };
  return { spawn, spawnCount: () => count };
}

/** Let pending microtasks (async tick chains) run to completion. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
    await new Promise<void>((r) => setImmediate(r));
  }
}

describe("GpuMetricsPoller", () => {
  test("first tick immediate, then interval; emits ok samples", async () => {
    const { spawn } = fakeGpuSpawn(fixtureCsv);
    const timers = new FakeTimers();
    const poller = new GpuMetricsPoller({ spawnImpl: spawn, intervalMs: 2000, timers });
    const samples: number[] = [];
    poller.on("sample", (s) => samples.push(s.utilPct));
    poller.start();
    await flushMicrotasks();
    expect(samples).toEqual([31]);
    expect(poller.latest()?.memUsedMb).toBe(1148);
    expect(poller.status).toBe("ok");

    timers.advance(2000);
    await flushMicrotasks();
    expect(samples).toEqual([31, 31]);
    poller.stop();
    // Stopped: no more ticks.
    timers.advance(4000);
    await flushMicrotasks();
    expect(samples).toEqual([31, 31]);
  });

  test("ENOENT → unavailable permanently, timer keeps running but skips spawn", async () => {
    const { spawn, spawnCount } = fakeGpuSpawn("", 0, "ENOENT");
    const timers = new FakeTimers();
    const poller = new GpuMetricsPoller({ spawnImpl: spawn, intervalMs: 100, timers });
    poller.start();
    await flushMicrotasks();
    expect(poller.status).toBe("unavailable");
    expect(poller.statusDetail).toBe("nvidia-smi not installed");
    const afterFirst = spawnCount();
    timers.advance(500);
    await flushMicrotasks();
    expect(spawnCount()).toBe(afterFirst); // skipped, not retried
    expect(poller.status).toBe("unavailable");
  });

  test("nonzero exit → error status, next tick retries", async () => {
    const { spawn } = fakeGpuSpawn(fixtureCsv, 1);
    const timers = new FakeTimers();
    const poller = new GpuMetricsPoller({ spawnImpl: spawn, intervalMs: 100, timers });
    poller.start();
    await flushMicrotasks();
    expect(poller.status).toBe("error");
    poller.stop();

    const recover = fakeGpuSpawn(fixtureCsv, 0);
    const poller2 = new GpuMetricsPoller({ spawnImpl: recover.spawn, intervalMs: 100, timers });
    poller2.start();
    await flushMicrotasks();
    expect(poller2.status).toBe("ok");
    poller2.stop();
  });

  test("unparseable output → error with detail", async () => {
    const { spawn } = fakeGpuSpawn("total garbage\n", 0);
    const poller = new GpuMetricsPoller({ spawnImpl: spawn, intervalMs: 1000, timers: new FakeTimers() });
    poller.start();
    await flushMicrotasks();
    expect(poller.status).toBe("error");
    expect(poller.statusDetail).toContain("unparseable");
  });
});
