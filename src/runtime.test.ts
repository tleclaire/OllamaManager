/**
 * Headless wiring check for the composition root (§16 Phase-2 acceptance):
 * constructs the full runtime with injected fakes and runs one poll tick —
 * no network, no child processes, no TTY required.
 */
import { describe, expect, test } from "bun:test";
import { createRuntime } from "./runtime";
import { FakeTimers } from "./test-support/fakeTimers";
import { defaultSpawn, type SpawnFn, type SpawnedProcess } from "./services/types";

const emptyStream = (): ReadableStream<Uint8Array> => new ReadableStream<Uint8Array>({ start(c) { c.close(); } });

/** Fake spawn returning immediately-empty streams (journal/gpu/proc all inert). */
const inertSpawn: SpawnFn = (argv) => {
  if (argv[0] === "pgrep" || argv[0] === "nvidia-smi" || argv[0] === "journalctl") {
    const proc: SpawnedProcess = {
      stdout: emptyStream(),
      stderr: emptyStream(),
      exited: Promise.resolve(argv[0] === "pgrep" ? 1 : 0),
      kill: () => {},
    };
    return proc;
  }
  return defaultSpawn(argv); // unexpected binary → fail loudly
};

function fakeFetchWithTags(): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        models: [
          {
            name: "qwen3.5:9b",
            model: "qwen3.5:9b",
            size: 7_085_693_796,
            digest: "d".repeat(64),
            modified_at: "2026-09-06T21:30:00Z",
            details: { family: "qwen3", families: ["qwen3"], parameter_size: "9.2B", quantization_level: "Q4_K_M" },
          },
        ],
      }),
      { status: 200 },
    )) as unknown as typeof fetch;
}

describe("createRuntime — headless wiring", () => {
  test("one poll tick moves tags through api → store → snapshot", async () => {
    const timers = new FakeTimers();
    const runtime = createRuntime({
      spawnImpl: inertSpawn,
      timers,
      transport: { fetch: fakeFetchWithTags() },
    });
    const { stores } = runtime;
    expect(stores.models.getSnapshot().apiStatus).toBe("checking");

    runtime.start();
    // start() triggers an immediate refreshTags/refreshRunning (async).
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));

    const models = stores.models.getSnapshot();
    expect(models.apiStatus).toBe("ok");
    expect(models.tags[0]?.name).toBe("qwen3.5:9b");

    // Advance one full poll cycle without errors thrown.
    timers.advance(5000);
    await new Promise<void>((r) => setImmediate(r));

    // Clean teardown: no timers left behind.
    runtime.stop();
    expect(timers.pendingCount).toBe(0);
  });

  test("stop() is idempotent and guards double-start", () => {
    const timers = new FakeTimers();
    const runtime = createRuntime({ spawnImpl: inertSpawn, timers, transport: { fetch: fakeFetchWithTags() } });
    runtime.start();
    runtime.start(); // no double timers
    runtime.stop();
    runtime.stop(); // no throw
    // The only pending timer is journalctl's SIGKILL grace (2s) — run it out.
    timers.advance(2001);
    expect(timers.pendingCount).toBe(0);
  });
});
