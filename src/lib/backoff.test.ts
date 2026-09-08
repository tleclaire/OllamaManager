import { describe, expect, test } from "bun:test";
import { backoffDelay } from "./backoff";

describe("backoffDelay", () => {
  test("doubles per attempt: 1s, 2s, 4s, 8s, 16s, 30s cap", () => {
    const noJitter = { random: () => 0.5 }; // jitter factor exactly 1
    expect(backoffDelay(1, noJitter)).toBe(1000);
    expect(backoffDelay(2, noJitter)).toBe(2000);
    expect(backoffDelay(3, noJitter)).toBe(4000);
    expect(backoffDelay(4, noJitter)).toBe(8000);
    expect(backoffDelay(5, noJitter)).toBe(16_000);
    expect(backoffDelay(6, noJitter)).toBe(30_000);
    expect(backoffDelay(7, noJitter)).toBe(30_000);
    expect(backoffDelay(100, noJitter)).toBe(30_000);
  });

  test("stays within ±20% jitter bounds", () => {
    for (let attempt = 1; attempt <= 8; attempt++) {
      const base = Math.min(1000 * 2 ** (attempt - 1), 30_000);
      const lo = base * 0.8;
      const hi = base * 1.2;
      for (let i = 0; i < 50; i++) {
        const d = backoffDelay(attempt);
        expect(d).toBeGreaterThanOrEqual(Math.round(lo) - 1);
        expect(d).toBeLessThanOrEqual(Math.round(hi) + 1);
      }
    }
  });

  test("honors injected random exactly at the bounds", () => {
    expect(backoffDelay(1, { random: () => 0 })).toBe(800); // 1000 * 0.8
    expect(backoffDelay(1, { random: () => 1 })).toBe(1200); // 1000 * 1.2
  });

  test("supports custom base and max", () => {
    const opts = { baseMs: 200, maxMs: 1000, random: () => 0.5 };
    expect(backoffDelay(1, opts)).toBe(200);
    expect(backoffDelay(2, opts)).toBe(400);
    expect(backoffDelay(10, opts)).toBe(1000);
  });

  test("treats non-positive attempt as attempt 1", () => {
    expect(backoffDelay(0, { random: () => 0.5 })).toBe(1000);
    expect(backoffDelay(-5, { random: () => 0.5 })).toBe(1000);
  });
});
