import { describe, expect, test } from "bun:test";
import {
  formatBytes,
  formatClock,
  formatDurationNs,
  formatExpiry,
  formatTokensPerSec,
  formatUptime,
  padCell,
  padStartCell,
  sparkline,
} from "./format";

describe("formatBytes", () => {
  test("formats gigabyte-scale model sizes", () => {
    expect(formatBytes(6.6 * 1024 ** 3)).toBe("6.6 GB");
    expect(formatBytes(9 * 1024 ** 3)).toBe("9.0 GB");
  });
  test("formats megabyte and byte ranges", () => {
    expect(formatBytes(512 * 1024 ** 2)).toBe("512 MB");
    expect(formatBytes(1234)).toBe("1234 B");
  });
  test("degrades gracefully on non-finite/negative input", () => {
    expect(formatBytes(Number.NaN)).toBe("—");
    expect(formatBytes(-5)).toBe("—");
  });
});

describe("formatDurationNs", () => {
  test("renders sub-second as ms", () => {
    expect(formatDurationNs(212_000_000)).toBe("212ms");
  });
  test("renders seconds with decimals", () => {
    expect(formatDurationNs(1_234_000_000)).toBe("1.23s");
  });
  test("rejects invalid input", () => {
    expect(formatDurationNs(Number.NaN)).toBe("—");
  });
});

describe("formatTokensPerSec", () => {
  test("426 tokens in 10s → 42.6 tok/s", () => {
    expect(formatTokensPerSec(426, 10_000_000_000)).toBe("42.6 tok/s");
  });
  test("zero duration → placeholder", () => {
    expect(formatTokensPerSec(10, 0)).toBe("—");
  });
});

describe("formatUptime", () => {
  test("seconds, minutes, hours, days", () => {
    expect(formatUptime(59_000)).toBe("59s");
    expect(formatUptime(272_000)).toBe("4m32s");
    expect(formatUptime(2 * 3600_000 + 3 * 60_000)).toBe("2h03m");
    expect(formatUptime(3 * 86_400_000 + 4 * 3600_000)).toBe("3d04h");
  });
});

describe("formatExpiry", () => {
  test("counts down and clamps at zero", () => {
    const iso = new Date(100_000).toISOString();
    expect(formatExpiry(iso, 70_000)).toBe("30s");
    expect(formatExpiry(iso, 200_000)).toBe("0s");
    expect(formatExpiry("not-a-date", 0)).toBe("—");
  });
});

describe("formatClock", () => {
  test("renders HH:MM:SS", () => {
    const d = new Date(2026, 8, 8, 15, 47, 1);
    expect(formatClock(d.getTime())).toBe("15:47:01");
  });
  test("invalid timestamp → placeholder", () => {
    expect(formatClock(Number.NaN)).toBe("--:--:--");
  });
});

describe("cells", () => {
  test("padCell left-aligns, padStartCell right-aligns", () => {
    expect(padCell("ab", 5)).toBe("ab   ");
    expect(padStartCell("ab", 5)).toBe("   ab");
    expect(padCell("abcdef", 3)).toBe("abcdef");
  });
});

describe("sparkline", () => {
  test("scales to the max value", () => {
    expect(sparkline([0, 1])).toBe("▁█");
  });
  test("flat series renders at max height (max-relative scaling)", () => {
    expect(sparkline([3, 3, 3])).toBe("███");
  });
  test("empty input → empty string; non-finite treated as 0", () => {
    expect(sparkline([])).toBe("");
    expect(sparkline([Number.NaN, 1])).toBe("▁█");
  });
});
