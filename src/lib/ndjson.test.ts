import { describe, expect, test } from "bun:test";
import { createNdjsonParser } from "./ndjson";

describe("createNdjsonParser", () => {
  test("delivers complete lines from a single chunk", () => {
    const got: unknown[] = [];
    const p = createNdjsonParser((o) => got.push(o));
    p.feed('{"a":1}\n{"a":2}\n');
    p.end();
    expect(got).toEqual([{ a: 1 }, { a: 2 }]);
    expect(p.stats()).toEqual({ lines: 2, malformed: 0 });
  });

  test("handles chunk boundaries mid-line", () => {
    const got: unknown[] = [];
    const p = createNdjsonParser((o) => got.push(o));
    p.feed('{"na');
    p.feed('me":"qwen');
    p.feed('3"}\n{"x":');
    p.feed("true}\n");
    p.end();
    expect(got).toEqual([{ name: "qwen3" }, { x: true }]);
  });

  test("flushes a final line without trailing newline via end()", () => {
    const got: unknown[] = [];
    const p = createNdjsonParser((o) => got.push(o));
    p.feed('{"a":1}\n{"a":2}');
    p.end();
    expect(got).toEqual([{ a: 1 }, { a: 2 }]);
    expect(p.stats().lines).toBe(2);
  });

  test("counts and skips malformed lines without crashing", () => {
    const got: unknown[] = [];
    const p = createNdjsonParser((o) => got.push(o));
    p.feed('{"ok":1}\nNOT JSON AT ALL\n{"ok":2}\n\x1b[31mgarbage\x1b[0m\n');
    p.end();
    expect(got).toEqual([{ ok: 1 }, { ok: 2 }]);
    expect(p.stats()).toEqual({ lines: 2, malformed: 2 });
  });

  test("skips empty lines and handles CRLF", () => {
    const got: unknown[] = [];
    const p = createNdjsonParser((o) => got.push(o));
    p.feed('{"a":1}\r\n\r\n{"b":2}\r\n\n');
    p.end();
    expect(got).toEqual([{ a: 1 }, { b: 2 }]);
    expect(p.stats().malformed).toBe(0);
  });

  test("handles multi-byte UTF-8 split across already-decoded chunks", () => {
    const got: { msg: string }[] = [];
    const p = createNdjsonParser<{ msg: string }>((o) => got.push(o));
    // "läuft" encoded as JSON contains non-ASCII once raw; use escaped form in JSON itself
    const line1 = JSON.stringify({ msg: "Modell läuft" });
    p.feed(line1.slice(0, 12) + "\n");
    p.feed(line1.slice(12) + "\n");
    p.end();
    // Each half alone is invalid JSON → 2 malformed lines, nothing delivered.
    expect(p.stats()).toEqual({ lines: 0, malformed: 2 });
    expect(got).toEqual([]);
  });

  test("TextDecoder streaming mode reassembles split multi-byte chars", () => {
    const got: { msg: string }[] = [];
    const p = createNdjsonParser<{ msg: string }>((o) => got.push(o));
    const decoder = new TextDecoder();
    const payload = new TextEncoder().encode(JSON.stringify({ msg: "Modell läuft" }) + "\n");
    // Split inside the multi-byte "ä" (2 bytes) — byte index 24 lands mid-char.
    const splitAt = payload.findIndex((b) => b > 0x7f) + 1;
    p.feed(decoder.decode(payload.slice(0, splitAt), { stream: true }));
    p.feed(decoder.decode(payload.slice(splitAt), { stream: true }));
    p.feed(decoder.decode());
    p.end();
    expect(got).toEqual([{ msg: "Modell läuft" }]);
    expect(p.stats().malformed).toBe(0);
  });

  test("discards a pathological never-terminated line instead of growing unboundedly", () => {
    const got: unknown[] = [];
    const p = createNdjsonParser((o) => got.push(o));
    p.feed("x".repeat(1_048_577)); // > MAX_LINE_CHARS without newline
    p.feed('{"ok":1}\n');
    p.end();
    expect(got).toEqual([{ ok: 1 }]);
    expect(p.stats().malformed).toBe(1);
  });
});
