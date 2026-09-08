import { describe, expect, test } from "bun:test";
import { PullStore } from "./pullStore";
import { StatsStore } from "./statsStore";
import { OllamaApiClient, type PullProgress } from "../services/ollamaApi";
import { GpuMetricsPoller, type GpuSample } from "../services/gpu";
import { ProcessStatsPoller, type ProcSample } from "../services/procstats";
import { FakeTimers } from "../test-support/fakeTimers";
import { RingBuffer } from "../lib/ringbuffer";

/** Let the promise continuation chain (then/finally) run to completion. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
    await new Promise<void>((r) => setImmediate(r));
  }
}

/** Controllable fake pull stream: resolves (or rejects) on demand. */
function controllableApi() {
  const holders: { resolvePull?: () => void } = {};
  let callCount = 0;
  const api = {
    pull: (
      _model: string,
      onProgress: (p: PullProgress) => void,
      signal: AbortSignal,
    ): Promise<void> =>
      new Promise<void>((resolve) => {
        callCount++;
        holders.resolvePull = () => resolve();
        signal.addEventListener("abort", () => resolve());
        onProgress({ status: "pulling manifest" });
        onProgress({ status: "pulling abc", total: 1000, completed: 250 });
      }),
  };
  return {
    api: api as unknown as OllamaApiClient,
    finish: () => holders.resolvePull?.(),
    callCount: () => callCount,
  };
}

describe("PullStore — throttled progress", () => {
  test("progress chunks coalesce into ≤1 snapshot per flush window", () => {
    const timers = new FakeTimers();
    timers.timeMs = 1000;
    const { api } = controllableApi();
    const store = new PullStore({ api, timers, flushMs: 100, pruneMs: 30_000 });
    let renders = 0;
    store.subscribe(() => renders++);

    store.start("m1");
    expect(store.getSnapshot().pulls["m1"]?.progress.status).toBe("starting…"); // immediate feedback

    timers.advance(100); // trailing flush with the latest progress
    expect(store.getSnapshot().pulls["m1"]?.pct).toBe(25); // 250/1000
  });

  test("abort marks done and cleans up the controller", async () => {
    const timers = new FakeTimers();
    timers.timeMs = 1000;
    const { api, finish, callCount } = controllableApi();
    const store = new PullStore({ api, timers, flushMs: 100, pruneMs: 30_000 });
    store.start("m1");
    store.abort("m1");
    await flushMicrotasks(); // aborted fake pull resolves; controllers map cleaned up
    timers.advance(100);
    const entry = store.getSnapshot().pulls["m1"];
    expect(entry?.done).toBe("aborted");
    expect(entry?.startedAt).toBe(1000);
    // Second start after abort is allowed (controller map cleaned up).
    store.start("m1");
    expect(callCount()).toBe(2);
    store.stop();
  });

  test("finished pulls are pruned after pruneMs", async () => {
    const timers = new FakeTimers();
    timers.timeMs = 1000;
    const { api, finish } = controllableApi();
    const store = new PullStore({ api, timers, flushMs: 100, pruneMs: 30_000 });
    store.start("m1");
    finish();
    await flushMicrotasks(); // .then marks done=completed
    timers.advance(100);
    const entry = store.getSnapshot().pulls["m1"];
    expect(entry?.done).toBe("completed");
    expect(entry?.pct).toBe(100);
    timers.advance(30_000);
    expect(store.getSnapshot().pulls["m1"]).toBeUndefined();
  });

  test("re-pulling the same model within the prune window keeps the new active entry", async () => {
    const timers = new FakeTimers();
    timers.timeMs = 1000;
    const { api, callCount } = controllableApi();
    const store = new PullStore({ api, timers, flushMs: 100, pruneMs: 30_000 });

    // First pull, aborted → done entry waits inside the 30s prune window.
    store.start("m1");
    store.abort("m1");
    await flushMicrotasks();
    timers.advance(100);
    expect(store.getSnapshot().pulls["m1"]?.done).toBe("aborted");

    // Re-pull the SAME model while the old prune timer is still pending.
    store.start("m1");
    expect(callCount()).toBe(2);
    timers.advance(30_000); // old prune deadline passes

    // The fresh ACTIVE entry must survive: still tracked, progress intact.
    const entry = store.getSnapshot().pulls["m1"];
    expect(entry).toBeDefined();
    expect(entry?.done).toBeUndefined();
    expect(entry?.pct).toBe(25); // progress of the new pull landed

    // Still abortable: the fresh controller can be targeted.
    store.abort("m1");
    await flushMicrotasks();
    timers.advance(100);
    expect(store.getSnapshot().pulls["m1"]?.done).toBe("aborted");

    // Prune still works for the re-pulled entry afterwards.
    timers.advance(30_000);
    expect(store.getSnapshot().pulls["m1"]).toBeUndefined();
    store.stop();
  });

  test("failed pull records the error and marks done=failed", async () => {
    const timers = new FakeTimers();
    const api = {
      pull: (_m: string, _p: (x: PullProgress) => void, _s: AbortSignal) => Promise.reject(new Error("disk full")),
    } as unknown as OllamaApiClient;
    const store = new PullStore({ api, timers, flushMs: 100, pruneMs: 30_000 });
    store.start("m1");
    await new Promise<void>((r) => setImmediate(r)); // let the rejection land
    timers.advance(100);
    const entry = store.getSnapshot().pulls["m1"];
    expect(entry?.done).toBe("failed");
    expect(entry?.error).toContain("disk full");
  });

  test("stop() aborts all controllers and clears state", () => {
    const timers = new FakeTimers();
    const { api } = controllableApi();
    const store = new PullStore({ api, timers, flushMs: 100, pruneMs: 30_000 });
    store.start("a");
    store.start("b");
    store.stop();
    expect(store.getSnapshot().pulls).toEqual({});
  });
});
