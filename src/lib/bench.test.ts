import { describe, expect, test } from "bun:test";
import { computeBenchStats } from "./bench";

const NOW = 1_000_000;

describe("computeBenchStats", () => {
  test("computes tok/s from eval_count / eval_duration (nanoseconds)", () => {
    const r = computeBenchStats(
      "qwen3.5:9b",
      { eval_count: 426, eval_duration: 10_000_000_000, prompt_eval_count: 20, prompt_eval_duration: 500_000_000 },
      212,
      NOW - 5000,
      NOW,
    );
    expect(r.tokPerSec).toBeCloseTo(42.6, 5);
    expect(r.promptTokPerSec).toBeCloseTo(40, 5);
    expect(r.evalCount).toBe(426);
    expect(r.promptEvalCount).toBe(20);
    expect(r.ttftMs).toBe(212);
    expect(r.totalMs).toBe(5000);
  });

  test("returns null rates when stats are missing", () => {
    const r = computeBenchStats("m", {}, 100, NOW - 10, NOW);
    expect(r.tokPerSec).toBeNull();
    expect(r.promptTokPerSec).toBeNull();
    expect(r.evalCount).toBeNull();
  });

  test("returns null rates for zero/negative durations", () => {
    const r = computeBenchStats("m", { eval_count: 10, eval_duration: 0 }, 0, NOW, NOW);
    expect(r.tokPerSec).toBeNull();
  });

  test("handles null final chunk (aborted stream)", () => {
    const r = computeBenchStats("m", null, 250, NOW - 1000, NOW);
    expect(r.tokPerSec).toBeNull();
    expect(r.evalCount).toBeNull();
    expect(r.ttftMs).toBe(250);
    expect(r.totalMs).toBe(1000);
  });

  test("clamps negative ttft to 0", () => {
    const r = computeBenchStats("m", {}, -5, NOW - 1, NOW);
    expect(r.ttftMs).toBe(0);
  });

  test("high-precision nanosecond math does not lose fractional tok/s", () => {
    // 1 token in 23ms → 43.478... tok/s
    const r = computeBenchStats("m", { eval_count: 1, eval_duration: 23_000_000 }, 0, 0, 0);
    expect(r.tokPerSec).not.toBeNull();
    expect(r.tokPerSec as number).toBeCloseTo(43.478, 2);
  });
});
