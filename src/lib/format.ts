/**
 * Pure display formatters (ARCHITECTURE.md §4.1).
 * All display math lives here so UI components stay dumb and the math is tested.
 */

/** 1024-based sizes labeled with decimal units (matches Ollama's own UI convention). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const gib = bytes / 1024 ** 3;
  if (gib >= 1) return `${gib.toFixed(1)} GB`;
  const mib = bytes / 1024 ** 2;
  if (mib >= 1) return `${mib.toFixed(0)} MB`;
  return `${Math.round(bytes)} B`;
}

/** Nanosecond duration → "212ms" / "1.20s". */
export function formatDurationNs(ns: number): string {
  if (!Number.isFinite(ns) || ns < 0) return "—";
  const ms = ns / 1e6;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/** Millisecond duration → "212ms" / "1.20s". */
export function formatDurationMs(ms: number): string {
  return formatDurationNs(ms * 1e6);
}

/** tok/s from token count and nanosecond duration → "42.6 tok/s". */
export function formatTokensPerSec(count: number, durationNs: number): string {
  if (!Number.isFinite(count) || !Number.isFinite(durationNs) || durationNs <= 0) return "—";
  const tps = count / (durationNs / 1e9);
  if (!Number.isFinite(tps) || tps < 0) return "—";
  return `${tps.toFixed(1)} tok/s`;
}

/** Millisecond uptime → "4m32s" / "2h03m" / "3d04h". */
export function formatUptime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86_400);
  const hours = Math.floor((totalSec % 86_400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (days > 0) return `${days}d${String(hours).padStart(2, "0")}h`;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

/** Milliseconds remaining until an ISO timestamp ("4m32s"), clamped at 0. */
export function formatExpiry(isoTimestamp: string, nowMs: number): string {
  const t = Date.parse(isoTimestamp);
  if (Number.isNaN(t)) return "—";
  return formatUptime(Math.max(0, t - nowMs));
}

/** Wall-clock time of a unix-ms timestamp as HH:MM:SS (log line prefix). */
export function formatClock(tsMs: number): string {
  const d = new Date(tsMs);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Fixed-width left-aligned cell. */
export function padCell(value: string, width: number): string {
  if (value.length >= width) return value;
  return value + " ".repeat(width - value.length);
}

/** Fixed-width right-aligned cell. */
export function padStartCell(value: string, width: number): string {
  if (value.length >= width) return value;
  return " ".repeat(width - value.length) + value;
}

const SPARK_CHARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

/**
 * Unicode sparkline from a numeric series (0 renders as ▁, max renders as █).
 * Non-finite values are treated as 0. Empty input → empty string.
 */
export function sparkline(values: readonly number[]): string {
  if (values.length === 0) return "";
  const finite = values.map((v) => (Number.isFinite(v) ? Math.max(0, v) : 0));
  const max = Math.max(...finite);
  if (max <= 0) return SPARK_CHARS[0].repeat(finite.length);
  return finite
    .map((v) => {
      const idx = Math.min(SPARK_CHARS.length - 1, Math.floor((v / max) * SPARK_CHARS.length));
      return SPARK_CHARS[idx];
    })
    .join("");
}
