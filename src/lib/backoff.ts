/**
 * Exponential backoff with jitter (ARCHITECTURE.md §4.1).
 * Base 1s, ×2 per attempt, cap 30s, ±20% jitter — thundering-herd-free
 * restarts for journalctl after crashes (ADR-5).
 */
export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  /** Injectable for deterministic tests; defaults to Math.random(). */
  random?: () => number;
}

const DEFAULT_BASE_MS = 1000;
const DEFAULT_MAX_MS = 30_000;
const JITTER = 0.2;

/**
 * @param attempt 1-based attempt number (1 → base, 2 → 2×base, ...)
 * @returns delay in ms within [value × (1 - JITTER), value × (1 + JITTER)]
 */
export function backoffDelay(attempt: number, opts?: BackoffOptions): number {
  const baseMs = opts?.baseMs ?? DEFAULT_BASE_MS;
  const maxMs = opts?.maxMs ?? DEFAULT_MAX_MS;
  const random = opts?.random ?? Math.random;

  const safeAttempt = Math.max(1, Math.floor(attempt));
  const raw = Math.min(baseMs * 2 ** (safeAttempt - 1), maxMs);
  const jitterFactor = 1 + JITTER * (2 * random() - 1);
  return Math.max(0, Math.round(raw * jitterFactor));
}
