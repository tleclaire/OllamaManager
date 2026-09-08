/**
 * Incremental NDJSON parser (ARCHITECTURE.md §4.1).
 *
 * Chunk boundaries from a ReadableStream do NOT align with newlines, so the
 * parser buffers text and splits on `\n`. Multi-byte UTF-8 characters can
 * split across chunks — callers must decode with `new TextDecoder()` in
 * streaming mode (`decode(value, { stream: true })`) BEFORE feeding text here,
 * and call `end()` on stream completion to flush the decoder's tail.
 *
 * Malformed lines are counted (see `stats()`) and skipped — never a crash on
 * upstream garbage (§11).
 */
export interface NdjsonStats {
  /** Successfully parsed and delivered lines. */
  lines: number;
  /** Lines that failed JSON.parse or were discarded (e.g. over the line cap). */
  malformed: number;
}

/** Hard cap for a single line — protects memory against pathological streams. */
const MAX_LINE_CHARS = 1_048_576;

export interface NdjsonParser<T> {
  /** Feed the next decoded text chunk. */
  feed(chunkText: string): void;
  /** Call on stream end (no trailing newline case). */
  end(): void;
  stats(): NdjsonStats;
}

export function createNdjsonParser<T>(onLine: (obj: T) => void): NdjsonParser<T> {
  let buffer = "";
  let lines = 0;
  let malformed = 0;

  const deliver = (raw: string): void => {
    // Trim \r (CRLF streams) and whitespace; skip empty lines.
    const line = raw.trim();
    if (line.length === 0) return;
    try {
      const obj = JSON.parse(line) as T;
      lines++;
      onLine(obj);
    } catch {
      malformed++;
    }
  };

  return {
    feed(chunkText: string): void {
      buffer += chunkText;
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        deliver(line);
      }
      // A single line that never terminates would grow the buffer unboundedly.
      if (buffer.length > MAX_LINE_CHARS) {
        malformed++;
        buffer = "";
      }
    },
    end(): void {
      if (buffer.length > 0) {
        const tail = buffer;
        buffer = "";
        deliver(tail);
      }
    },
    stats: () => ({ lines, malformed }),
  };
}
