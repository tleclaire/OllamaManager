/**
 * GPU + process stats + benchmark results (§4.6).
 * Fixed-cap series everywhere — memory bounded by design, not by discipline.
 * Series RingBuffer instances are stable and mutated in place; each event
 * produces a NEW snapshot object so useSyncExternalStore re-renders, and the
 * component reads current series contents at render time.
 */
import { config } from "../config";
import { RingBuffer } from "../lib/ringbuffer";
import type { GpuMetricsPoller, GpuSample, GpuStatus } from "../services/gpu";
import type { ProcessStatsPoller, ProcSample, ProcStatus } from "../services/procstats";
import type { BenchResult } from "../lib/bench";
import { StoreBase } from "./base";

export type StatsState = {
  gpu: GpuSample | null;
  gpuStatus: GpuStatus;
  gpuDetail?: string;
  gpuSeries: RingBuffer<GpuSample>;
  proc: ProcSample | null;
  procStatus: ProcStatus;
  procDetail?: string;
  cpuSeries: RingBuffer<number>;
  benchmarks: BenchResult[]; // cap 50, newest first
};

export class StatsStore extends StoreBase<StatsState> {
  private readonly gpu: GpuMetricsPoller;
  private readonly proc: ProcessStatsPoller;
  private unsubs: (() => void)[] = [];
  private readonly benchmarksCap: number;

  constructor(deps: { gpu: GpuMetricsPoller; proc: ProcessStatsPoller; seriesCap?: number; benchmarksCap?: number }) {
    super({
      gpu: null,
      gpuStatus: "unavailable",
      gpuSeries: new RingBuffer<GpuSample>(deps.seriesCap ?? config.buffers.series),
      proc: null,
      procStatus: "idle",
      cpuSeries: new RingBuffer<number>(deps.seriesCap ?? config.buffers.series),
      benchmarks: [],
    });
    this.gpu = deps.gpu;
    this.proc = deps.proc;
    this.benchmarksCap = deps.benchmarksCap ?? config.buffers.benchmarks;
  }

  /** Subscribe to both pollers (called by runtime.start()). */
  start(): void {
    if (this.unsubs.length > 0) return;
    this.unsubs.push(
      this.gpu.on("sample", (sample) => {
        this.snapshot.gpuSeries.push(sample);
        this.update({ gpu: sample });
      }),
      this.gpu.on("status", (s) => {
        this.update({ gpuStatus: s.status, gpuDetail: s.detail });
      }),
      this.proc.on("sample", (sample) => {
        this.snapshot.cpuSeries.push(sample.cpuPct);
        this.update({ proc: sample });
      }),
      this.proc.on("status", (s) => {
        this.update({ procStatus: s.status, procDetail: s.detail });
      }),
    );
  }

  stop(): void {
    for (const off of this.unsubs) off();
    this.unsubs = [];
  }

  /** Add a benchmark result (newest first, bounded). */
  addBenchmark(result: BenchResult): void {
    const benchmarks = [result, ...this.snapshot.benchmarks].slice(0, this.benchmarksCap);
    this.update({ benchmarks });
  }
}
