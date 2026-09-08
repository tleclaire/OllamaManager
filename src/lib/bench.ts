/**
 * Benchmark math, isolated from any React/service code (ARCHITECTURE.md §4.1).
 *
 * Data source: the FINAL chunk of a POST /api/generate NDJSON stream carries
 * eval_count / eval_duration (nanoseconds) and prompt_eval_* fields. TTFT is
 * wall-clock from fetch start to the first chunk with a non-empty response —
 * captured by the caller; this module only does the math (ADR-9).
 */

/** Structural subset of Ollama's final generate chunk (keeps lib independent of services). */
export interface BenchFinalChunk {
  eval_count?: number;
  eval_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
}

export interface BenchResult {
  model: string;
  /** Wall-clock ms until the first non-empty response token. */
  ttftMs: number;
  /** Wall-clock ms for the whole request. */
  totalMs: number;
  evalCount: number | null;
  promptEvalCount: number | null;
  /** eval_count / (eval_duration / 1e9). */
  tokPerSec: number | null;
  /** prompt_eval_count / (prompt_eval_duration / 1e9). */
  promptTokPerSec: number | null;
}

function rate(count: number | undefined, durationNs: number | undefined): number | null {
  if (
    typeof count !== "number" ||
    typeof durationNs !== "number" ||
    !Number.isFinite(count) ||
    !Number.isFinite(durationNs) ||
    count <= 0 ||
    durationNs <= 0
  ) {
    return null;
  }
  const tps = count / (durationNs / 1e9);
  return Number.isFinite(tps) && tps > 0 ? tps : null;
}

/**
 * @param model     model name (recorded in the result)
 * @param final     final /api/generate chunk (may be null when aborted)
 * @param ttftMs    wall-clock TTFT captured by the caller (0 when no token arrived)
 * @param startedAt Date.now() at fetch start
 * @param nowMs     injectable clock for tests; defaults to Date.now()
 */
export function computeBenchStats(
  model: string,
  final: BenchFinalChunk | null,
  ttftMs: number,
  startedAt: number,
  nowMs: number = Date.now(),
): BenchResult {
  const safeTtft = Number.isFinite(ttftMs) && ttftMs > 0 ? ttftMs : 0;
  return {
    model,
    ttftMs: safeTtft,
    totalMs: Math.max(0, nowMs - startedAt),
    evalCount: typeof final?.eval_count === "number" ? final.eval_count : null,
    promptEvalCount: typeof final?.prompt_eval_count === "number" ? final.prompt_eval_count : null,
    tokPerSec: rate(final?.eval_count, final?.eval_duration),
    promptTokPerSec: rate(final?.prompt_eval_count, final?.prompt_eval_duration),
  };
}
