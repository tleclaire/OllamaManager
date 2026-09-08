import { describe, expect, test } from "bun:test";
import { StatsStore } from "./statsStore";
import { OllamaApiClient } from "../services/ollamaApi";
import { GpuMetricsPoller, type GpuSample } from "../services/gpu";
import { ProcessStatsPoller, type ProcSample } from "../services/procstats";
import { FakeTimers } from "../test-support/fakeTimers";
import { RingBuffer } from "../lib/ringbuffer";

describe("StatsStore — series + benchmarks", () => {
  function makeStats() {
    const timers = new FakeTimers();
    const gpu = new GpuMetricsPoller({ timers, intervalMs: 1e9 });
    const proc = new ProcessStatsPoller({ timers, intervalMs: 1e9 });
    const stats = new StatsStore({ gpu, proc });
    stats.start();
    return { gpu, proc, stats, timers };
  }

  test("gpu sample updates snapshot and ring series in place", () => {
    const { gpu, stats } = makeStats();
    const sample: GpuSample = { ts: 1, utilPct: 31, memUsedMb: 1148, memTotalMb: 12288, tempC: 53, fanPct: 40, powerW: 68 };
    const before = stats.getSnapshot();
    gpu.emit("sample", sample);
    const after = stats.getSnapshot();
    expect(after.gpu).toEqual(sample);
    expect(after.gpuSeries).toBe(before.gpuSeries); // same ring instance
    expect(after.gpuSeries.toArray()).toEqual([sample]); // …but contents updated
    expect(after).not.toBe(before); // new snapshot identity → re-render
  });

  test("proc sample pushes cpu% into the cpu series", () => {
    const { proc, stats } = makeStats();
    const sample: ProcSample = { ts: 1, pid: 73805, cpuPct: 45, rssBytes: 6e9, threads: 38 };
    proc.emit("sample", sample);
    expect(stats.getSnapshot().proc).toEqual(sample);
    expect(stats.getSnapshot().cpuSeries.toArray()).toEqual([45]);
  });

  test("benchmarks are newest-first and capped", () => {
    const { stats } = makeStats();
    for (let i = 0; i < 60; i++) {
      stats.addBenchmark({
        model: `m${i}`,
        ttftMs: i,
        totalMs: i * 10,
        evalCount: i,
        promptEvalCount: 1,
        tokPerSec: i,
        promptTokPerSec: 1,
      });
    }
    const benchmarks = stats.getSnapshot().benchmarks;
    expect(benchmarks).toHaveLength(50);
    expect(benchmarks[0]?.model).toBe("m59"); // newest first
    expect(benchmarks[49]?.model).toBe("m10");
  });

  test("status events update gpu/proc status", () => {
    const { gpu, proc, stats } = makeStats();
    gpu.emit("status", { status: "unavailable", detail: "nvidia-smi not installed" });
    proc.emit("status", { status: "idle" });
    expect(stats.getSnapshot().gpuStatus).toBe("unavailable");
    expect(stats.getSnapshot().gpuDetail).toBe("nvidia-smi not installed");
    expect(stats.getSnapshot().procStatus).toBe("idle");
  });

  test("series respect the injected cap", () => {
    const gpu = new GpuMetricsPoller({ timers: new FakeTimers(), intervalMs: 1e9 });
    const proc = new ProcessStatsPoller({ timers: new FakeTimers(), intervalMs: 1e9 });
    const stats = new StatsStore({ gpu, proc, seriesCap: 3 });
    stats.start();
    for (let i = 1; i <= 5; i++) {
      gpu.emit("sample", { ts: i, utilPct: i, memUsedMb: 1, memTotalMb: 2, tempC: 3, fanPct: null, powerW: null });
    }
    expect(stats.getSnapshot().gpuSeries.length).toBe(3);
    expect(stats.getSnapshot().gpuSeries.toArray().map((s) => s.utilPct)).toEqual([3, 4, 5]);
    expect(stats.getSnapshot().gpuSeries).toBeInstanceOf(RingBuffer);
  });
});
