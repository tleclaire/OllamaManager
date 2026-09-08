import { beforeAll, describe, expect, test } from "bun:test";
import {
  ProcessStatsPoller,
  parseStatCpuTicks,
  parseStatThreads,
  parseStatusRss,
  parseStatusThreads,
} from "./procstats";
import { FakeTimers } from "../test-support/fakeTimers";
import { type ExecFn, type ReadTextFileFn } from "./types";

const FIXTURES = new URL("./__fixtures__/", import.meta.url).pathname;
let statFixture: string;
let statusFixture: string;

beforeAll(async () => {
  [statFixture, statusFixture] = await Promise.all([
    Bun.file(`${FIXTURES}proc-stat.txt`).text(),
    Bun.file(`${FIXTURES}proc-status.txt`).text(),
  ]);
});

describe("/proc parsers", () => {
  test("parseStatCpuTicks: utime+stime from fixture (500+100=600)", () => {
    expect(parseStatCpuTicks(statFixture)).toBe(600);
  });

  test("parseStatThreads: field 20 from fixture (38)", () => {
    expect(parseStatThreads(statFixture)).toBe(38);
  });

  test("parseStatCpuTicks handles comm containing spaces and parens", () => {
    // comm "((m)o l l a m a )" — lastIndexOf(")") protects the split.
    // After comm: state=R, then fields 4..20 = 0..16 → utime(14)=10, stime(15)=11, threads(20)=16.
    const weird = "1 ((m)o l l a m a )) R 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 0 0 0";
    expect(parseStatCpuTicks(weird)).toBe(21);
    expect(parseStatThreads(weird)).toBe(16);
  });

  test("parseStatusRss: VmRSS kB → bytes", () => {
    expect(parseStatusRss(statusFixture)).toBe(6_390_312 * 1024);
  });

  test("parseStatusThreads: 38", () => {
    expect(parseStatusThreads(statusFixture)).toBe(38);
  });

  test("missing fields → null", () => {
    expect(parseStatCpuTicks("garbage")).toBeNull();
    expect(parseStatusRss("Name: x\n")).toBeNull();
    expect(parseStatusThreads("Name: x\n")).toBeNull();
  });
});

/** pgrep fake that can be reprogrammed between ticks. */
function fakePgrep(results: (string | null)[]): { exec: ExecFn; calls: () => number } {
  let i = 0;
  const exec: ExecFn = async () => {
    const result = results[Math.min(i, results.length - 1)] ?? null;
    i++;
    return { exitCode: result === null ? 1 : 0, stdout: result ?? "" };
  };
  return { exec, calls: () => i };
}

/** Let pending microtasks (async tick chains) run to completion. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
    await new Promise<void>((r) => setImmediate(r));
  }
}

describe("ProcessStatsPoller", () => {
  test("first tick warming (cpu 0), second tick computes Δ-CPU%", async () => {
    const { exec } = fakePgrep(["73805"]);
    const timers = new FakeTimers();
    let utime = 500;
    const readTextFile: ReadTextFileFn = async (path) => {
      if (path.endsWith("/stat")) {
        // Build stat content with the CURRENT utime so we control the delta.
        return statFixture.replace(/ S /, " S ").replace(/0 500 100 0/, `0 ${utime} 100 0`);
      }
      return statusFixture;
    };
    const poller = new ProcessStatsPoller({ execPgrepImpl: exec, readTextFileImpl: readTextFile, intervalMs: 2000, timers });

    const samples: { cpuPct: number; rss: number; threads: number }[] = [];
    poller.on("sample", (s) => samples.push({ cpuPct: s.cpuPct, rss: s.rssBytes, threads: s.threads }));
    poller.start();
    await flushMicrotasks();
    expect(samples).toHaveLength(1);
    expect(samples[0]?.cpuPct).toBe(0);
    expect(samples[0]?.threads).toBe(38);
    expect(samples[0]?.rss).toBe(6_390_312 * 1024);
    expect(poller.status).toBe("running");
    expect(poller.statusDetail).toContain("warming");

    // Advance 2s of wall clock; utime grows by 200 ticks → 200/(2s×100) = 100% CPU.
    utime = 700;
    timers.advance(2000);
    await flushMicrotasks();
    expect(samples).toHaveLength(2);
    expect(samples[1]?.cpuPct).toBeCloseTo(100, 5);
    expect(poller.statusDetail).toBeUndefined();
    poller.stop();
  });

  test("pid vanishes → idle with zero-sample (charts decay)", async () => {
    const { exec } = fakePgrep(["73805", null]);
    const timers = new FakeTimers();
    const readTextFile: ReadTextFileFn = async () => statusFixture;
    const poller = new ProcessStatsPoller({
      execPgrepImpl: exec,
      readTextFileImpl: async (p) => (p.endsWith("/stat") ? statFixture : statusFixture),
      intervalMs: 2000,
      timers,
    });
    const statuses: string[] = [];
    poller.on("status", (s) => statuses.push(s.status));
    const samples: number[] = [];
    poller.on("sample", (s) => samples.push(s.pid));

    poller.start();
    await flushMicrotasks();
    expect(poller.status).toBe("running");
    timers.advance(2000);
    await flushMicrotasks();
    expect(poller.status).toBe("idle");
    expect(samples).toEqual([73805, 0]);
    // Re-pgrep next tick — pgrep was called once per tick.
    timers.advance(2000);
    await flushMicrotasks();
    expect(poller.status).toBe("idle");
  });

  test("unreadable /proc → error status, keeps polling", async () => {
    const { exec } = fakePgrep(["73805"]);
    const timers = new FakeTimers();
    const readTextFile: ReadTextFileFn = async () => {
      const err = new Error("EACCES: permission denied") as Error & { code?: string };
      err.code = "EACCES";
      throw err;
    };
    const poller = new ProcessStatsPoller({ execPgrepImpl: exec, readTextFileImpl: readTextFile, intervalMs: 100, timers });
    poller.start();
    await flushMicrotasks();
    expect(poller.status).toBe("error");
    expect(poller.statusDetail).toContain("unreadable");
    timers.advance(200);
    await flushMicrotasks();
    expect(poller.status).toBe("error");
    poller.stop();
  });

  test("pgrep empty on first tick → idle (normal state, not error)", async () => {
    const { exec } = fakePgrep([null]);
    const poller = new ProcessStatsPoller({
      execPgrepImpl: exec,
      readTextFileImpl: async () => "",
      intervalMs: 1000,
      timers: new FakeTimers(),
    });
    poller.start();
    await flushMicrotasks();
    expect(poller.status).toBe("idle");
    expect(poller.latest()?.pid).toBe(0);
    poller.stop();
  });
});
