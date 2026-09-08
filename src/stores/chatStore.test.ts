import { describe, expect, test } from "bun:test";
import { ChatStore } from "./chatStore";
import { StatsStore } from "./statsStore";
import { OllamaApiClient, type GenerateChunk, type GenerateFinalChunk } from "../services/ollamaApi";
import { GpuMetricsPoller } from "../services/gpu";
import { ProcessStatsPoller } from "../services/procstats";
import { FakeTimers } from "../test-support/fakeTimers";

/** Scriptable fake generate(): feeds chunks, resolves with a final chunk. */
function scriptableApi() {
  const api = new OllamaApiClient({ transport: { fetch: (() => undefined) as unknown as typeof fetch } });
  type GenerateFn = typeof api.generate;
  let behavior: ((opts: { onChunk: (c: GenerateChunk) => void }) => Promise<GenerateFinalChunk | null>) | null = null;
  const fake = Object.assign(Object.create(Object.getPrototypeOf(api)), api) as OllamaApiClient;
  fake.generate = ((model: string, prompt: string, opts: { onChunk: (c: GenerateChunk) => void }) => {
    return behavior ? behavior(opts) : Promise.resolve(null);
  }) as GenerateFn;
  return { api: fake, setBehavior: (b: NonNullable<typeof behavior>) => (behavior = b) };
}

function makeChat() {
  const timers = new FakeTimers();
  const gpu = new GpuMetricsPoller({ timers, intervalMs: 1e9 });
  const proc = new ProcessStatsPoller({ timers, intervalMs: 1e9 });
  const stats = new StatsStore({ gpu, proc });
  const { api, setBehavior } = scriptableApi();
  const chat = new ChatStore({ api, stats, timers, flushMs: 100 });
  chat.setModel("m1");
  return { chat, stats, timers, setBehavior };
}

describe("ChatStore — TTFT capture", () => {
  test("TTFT = wall clock from start to first NON-EMPTY chunk", async () => {
    const { chat, timers, setBehavior } = makeChat();
    setBehavior(async ({ onChunk }) => {
      // t=100: empty chunk (no TTFT yet); t=250: first token; t=400: more.
      timers.advance(100);
      onChunk({ model: "m1", response: "", done: false });
      timers.advance(150);
      onChunk({ model: "m1", response: "He", done: false });
      timers.advance(150);
      onChunk({ model: "m1", response: "llo", done: false });
      return { model: "m1", response: "", done: true, eval_count: 3, eval_duration: 100_000_000 };
    });

    const promise = chat.send("hi");
    await promise;
    const s = chat.getSnapshot();
    expect(s.streaming).toBe(false);
    expect(s.messages[0]?.role).toBe("user");
    expect(s.messages[0]?.content).toBe("hi");
    expect(s.messages[1]?.role).toBe("assistant");
    expect(s.messages[1]?.content).toBe("Hello");
    expect(s.messages[1]?.ttftMs).toBe(250); // 100 + 150
  });

  test("streaming text flushes into the snapshot (≤1 render per window)", async () => {
    const { chat, timers, setBehavior } = makeChat();
    const holder: { resolveStream?: () => void } = {};
    setBehavior(async ({ onChunk }) => {
      onChunk({ model: "m1", response: "abc", done: false });
      onChunk({ model: "m1", response: "def", done: false });
      return new Promise<GenerateFinalChunk>((resolve) => {
        holder.resolveStream = () => resolve({ model: "m1", response: "", done: true, eval_count: 6, eval_duration: 1e9 });
      });
    });

    let renders = 0;
    chat.subscribe(() => renders++);
    const promise = chat.send("hi");
    timers.advance(100); // flush #1 with "abcdef"
    const mid = chat.getSnapshot();
    expect(mid.current?.text).toBe("abcdef");
    expect(mid.current?.chars).toBe(6);
    expect(mid.streaming).toBe(true);

    holder.resolveStream?.();
    await promise;
    const done = chat.getSnapshot();
    expect(done.current).toBeNull();
    expect(done.messages.at(-1)?.content).toBe("abcdef");
    expect(renders).toBeGreaterThanOrEqual(2);
    expect(renders).toBeLessThanOrEqual(5); // start, flush, finalize — not per chunk
  });
});

describe("ChatStore — benchmark integration", () => {
  test("completed send pushes BenchResult into statsStore", async () => {
    const { chat, stats, setBehavior } = makeChat();
    setBehavior(async ({ onChunk }) => {
      onChunk({ model: "m1", response: "x", done: false });
      return {
        model: "m1",
        response: "",
        done: true,
        eval_count: 426,
        eval_duration: 10_000_000_000,
        prompt_eval_count: 20,
        prompt_eval_duration: 500_000_000,
      };
    });
    await chat.send("bench me");
    const bench = chat.getSnapshot().lastBench;
    expect(bench).not.toBeNull();
    expect(bench?.tokPerSec).toBeCloseTo(42.6, 5);
    expect(bench?.model).toBe("m1");
    const stored = stats.getSnapshot().benchmarks;
    expect(stored).toHaveLength(1);
    expect(stored[0]?.ttftMs).toBe(bench?.ttftMs);
  });

  test("aborted stream records aborted=true and pushes NO benchmark", async () => {
    const timers = new FakeTimers();
    const gpu = new GpuMetricsPoller({ timers, intervalMs: 1e9 });
    const proc = new ProcessStatsPoller({ timers, intervalMs: 1e9 });
    const statsStore = new StatsStore({ gpu, proc });
    const chatStore = new ChatStore({
      api: {
        generate: (_model: string, _prompt: string, opts: { onChunk: (c: GenerateChunk) => void; signal?: AbortSignal }) =>
          new Promise<GenerateFinalChunk | null>((resolve) => {
            opts.onChunk({ model: "m1", response: "partial", done: false });
            opts.signal?.addEventListener("abort", () => resolve(null));
          }),
      } as unknown as OllamaApiClient,
      stats: statsStore,
      timers,
      flushMs: 100,
    });
    chatStore.setModel("m1");
    const promise = chatStore.send("hi");
    chatStore.abort();
    await promise;
    const s = chatStore.getSnapshot();
    expect(s.aborted).toBe(true);
    expect(s.streaming).toBe(false);
    expect(s.messages.at(-1)?.content).toBe("partial");
    expect(s.lastBench).toBeNull();
    expect(statsStore.getSnapshot().benchmarks).toHaveLength(0);
  });

  test("rejected generate surfaces the error and still finalizes the exchange", async () => {
    const { chat, setBehavior } = makeChat();
    // ApiError is a plain object (not an Error subclass) — reject with that
    // exact shape to pin the defensive message extraction.
    setBehavior(() => Promise.reject({ kind: "status", status: 404, message: "model 'm1' not found" }));

    await chat.send("hi");
    const failed = chat.getSnapshot();
    expect(failed.error).toBe("model 'm1' not found");
    expect(failed.streaming).toBe(false); // not stuck in "streaming"
    expect(failed.current).toBeNull();
    expect(failed.messages.at(-1)?.role).toBe("assistant"); // exchange finalized
    expect(failed.lastBench).toBeNull(); // failed run records no benchmark

    // A subsequent successful send clears the stale error.
    setBehavior(async ({ onChunk }) => {
      onChunk({ model: "m1", response: "ok", done: false });
      return null;
    });
    await chat.send("again");
    const recovered = chat.getSnapshot();
    expect(recovered.error).toBeUndefined();
    expect(recovered.messages.at(-1)?.content).toBe("ok");
  });

  test("runBenchmark sends the configured preset prompt", async () => {
    const { chat, setBehavior } = makeChat();
    const prompts: string[] = [];
    setBehavior(async () => {
      prompts.push("captured");
      return null;
    });
    const origSend = chat.send.bind(chat);
    chat.send = (prompt: string) => {
      prompts.push(prompt);
      return origSend(prompt);
    };
    await chat.runBenchmark();
    expect(prompts[0]).toBe((await import("../config")).config.benchmarkPrompt);
  });

  test("send is a no-op while streaming or without a model", async () => {
    const { chat } = makeChat();
    chat.setModel(null);
    await chat.send("hi");
    expect(chat.getSnapshot().messages).toHaveLength(0);
  });

  test("messages are capped at 200", async () => {
    const timers = new FakeTimers();
    const gpu = new GpuMetricsPoller({ timers, intervalMs: 1e9 });
    const proc = new ProcessStatsPoller({ timers, intervalMs: 1e9 });
    const statsStore = new StatsStore({ gpu, proc });
    const chatStore = new ChatStore({
      api: {
        generate: () => Promise.resolve(null),
      } as unknown as OllamaApiClient,
      stats: statsStore,
      timers,
    });
    chatStore.setModel("m");
    for (let i = 0; i < 150; i++) {
      await chatStore.send(`msg ${i}`);
    }
    const messages = chatStore.getSnapshot().messages;
    expect(messages.length).toBeLessThanOrEqual(200);
    // Last two messages: user "msg 149" + its empty assistant reply.
    expect(messages.at(-1)?.content).toBe("");
    expect(messages.at(-2)?.content).toBe("msg 149");
  });
});
