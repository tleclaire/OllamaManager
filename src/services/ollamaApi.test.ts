import { beforeAll, describe, expect, test } from "bun:test";
import { OllamaApiClient, type ApiError } from "./ollamaApi";

const FIXTURES = new URL("./__fixtures__/", import.meta.url).pathname;
let tagsJson: string;
let psJson: string;
let pullNdjson: string;
let generateNdjson: string;

beforeAll(async () => {
  [tagsJson, psJson, pullNdjson, generateNdjson] = await Promise.all([
    Bun.file(`${FIXTURES}tags.json`).text(),
    Bun.file(`${FIXTURES}ps.json`).text(),
    Bun.file(`${FIXTURES}pull-stream.ndjson`).text(),
    Bun.file(`${FIXTURES}generate-stream.ndjson`).text(),
  ]);
});

/** Fake fetch serving a JSON body. Captures the request for assertions. */
function fetchJson(body: string, status = 200) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(body, { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { impl, calls };
}

/** Fake fetch serving NDJSON text through a real ReadableStream (chunked). */
function fetchNdjson(text: string, opts?: { status?: number; chunkSize?: number }) {
  const encoder = new TextEncoder();
  const calls: { url: string; init?: RequestInit }[] = [];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const size = opts?.chunkSize ?? 8;
      for (let i = 0; i < text.length; i += size) {
        controller.enqueue(encoder.encode(text.slice(i, i + size)));
      }
      controller.close();
    },
  });
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(body, { status: opts?.status ?? 200 });
  }) as typeof fetch;
  return { impl, calls };
}

/** Fake fetch whose stream errors with an AbortError once the signal fires. */
function fetchAbortingNdjson(text: string) {
  const encoder = new TextEncoder();
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const signal = (init?.signal ?? null) as AbortSignal | null;
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
        c.enqueue(encoder.encode(text.slice(0, 20)));
        signal?.addEventListener("abort", () => {
          try {
            controller.error(new DOMException("The operation was aborted.", "AbortError"));
          } catch {
            /* already closed */
          }
        });
      },
    });
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  return { impl };
}

function errorOf(promise: Promise<unknown>): Promise<ApiError> {
  return promise.then(
    () => {
      throw new Error("expected promise to reject");
    },
    (err) => err as ApiError,
  );
}

describe("OllamaApiClient — JSON endpoints", () => {
  test("listModels parses /api/tags", async () => {
    const { impl, calls } = fetchJson(tagsJson);
    const api = new OllamaApiClient({ transport: { fetch: impl } });
    const models = await api.listModels();
    expect(models).toHaveLength(2);
    expect(models[0]?.name).toBe("qwen3.5:9b");
    expect(models[0]?.details.quantization_level).toBe("Q4_K_M");
    expect(calls[0]?.url).toBe("http://127.0.0.1:11434/api/tags");
  });

  test("listRunning parses /api/ps", async () => {
    const { impl } = fetchJson(psJson);
    const api = new OllamaApiClient({ transport: { fetch: impl } });
    const running = await api.listRunning();
    expect(running).toHaveLength(1);
    expect(running[0]?.size_vram).toBe(9_600_000_000);
  });

  test("showModel POSTs {model} as JSON", async () => {
    const { impl, calls } = fetchJson(JSON.stringify({ modelfile: "# test", parameters: "", template: "", details: {} }));
    const api = new OllamaApiClient({ transport: { fetch: impl } });
    const details = await api.showModel("qwen3.5:9b");
    expect(details.modelfile).toBe("# test");
    const init = calls[0]?.init;
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ model: "qwen3.5:9b" });
  });

  test("deleteModel and copyModel POST the documented bodies", async () => {
    const { impl, calls } = fetchJson("{}");
    const api = new OllamaApiClient({ transport: { fetch: impl } });
    await api.deleteModel("m1");
    await api.copyModel("src", "dst");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ model: "m1" });
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ source: "src", destination: "dst" });
  });

  test("unload posts empty prompt with keep_alive 0", async () => {
    const { impl, calls } = fetchJson("{}");
    const api = new OllamaApiClient({ transport: { fetch: impl } });
    await api.unload("qwen3.5:9b");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      model: "qwen3.5:9b",
      prompt: "",
      keep_alive: 0,
      stream: false,
    });
  });
});

describe("OllamaApiClient — error normalization", () => {
  test("network failure → kind network", async () => {
    const impl = (async () => {
      throw new TypeError("connection refused");
    }) as unknown as typeof fetch;
    const api = new OllamaApiClient({ transport: { fetch: impl } });
    const err = await errorOf(api.listModels());
    expect(err.kind).toBe("network");
    expect(err.message).toContain("connection refused");
  });

  test("HTTP 500 → kind status with status code", async () => {
    const { impl } = fetchJson("server exploded", 500);
    const api = new OllamaApiClient({ transport: { fetch: impl } });
    const err = await errorOf(api.listModels());
    expect(err.kind).toBe("status");
    expect(err.status).toBe(500);
    expect(err.message).toContain("server exploded");
  });

  test("invalid JSON → kind parse", async () => {
    const { impl } = fetchJson("{not json");
    const api = new OllamaApiClient({ transport: { fetch: impl } });
    const err = await errorOf(api.listModels());
    expect(err.kind).toBe("parse");
  });

  test("custom baseUrl is respected", async () => {
    const { impl, calls } = fetchJson('{"models":[]}');
    const api = new OllamaApiClient({ baseUrl: "http://localhost:9999/", transport: { fetch: impl } });
    await api.listModels();
    expect(calls[0]?.url).toBe("http://localhost:9999/api/tags");
  });
});

describe("OllamaApiClient — pull stream", () => {
  test("delivers progress chunks despite chunk-boundary splits", async () => {
    const { impl } = fetchNdjson(pullNdjson, { chunkSize: 11 });
    const api = new OllamaApiClient({ transport: { fetch: impl } });
    const seen: string[] = [];
    await api.pull("qwen2.5:0.5b", (p) => seen.push(p.status), new AbortController().signal);
    expect(seen).toEqual(["pulling manifest", "pulling a8b0c5d6599769f0", "pulling a8b0c5d6599769f0", "success"]);
  });

  test("resolves silently when aborted before completion", async () => {
    const controller = new AbortController();
    const { impl } = fetchAbortingNdjson(pullNdjson);
    const api = new OllamaApiClient({ transport: { fetch: impl } });
    const seen: string[] = [];
    const promise = api.pull("m", (p) => seen.push(p.status), controller.signal);
    controller.abort();
    await expect(promise).resolves.toBeUndefined();
    expect(seen.length).toBeLessThan(4);
  });

  test("HTTP error mid-pull normalizes to status error", async () => {
    const { impl } = fetchNdjson(pullNdjson, { status: 404 });
    const api = new OllamaApiClient({ transport: { fetch: impl } });
    const err = await errorOf(api.pull("missing", () => {}, new AbortController().signal));
    expect(err.kind).toBe("status");
    expect(err.status).toBe(404);
  });
});

describe("OllamaApiClient — generate stream", () => {
  test("onChunk fires per chunk; resolves with the final chunk stats", async () => {
    const { impl } = fetchNdjson(generateNdjson, { chunkSize: 7 });
    const api = new OllamaApiClient({ transport: { fetch: impl } });
    const chunks: string[] = [];
    const final = await api.generate("qwen2.5:0.5b", "hi", {
      onChunk: (c) => chunks.push(c.response),
    });
    expect(chunks).toEqual(["Hel", "lo ", "world"]);
    expect(final).not.toBeNull();
    expect(final?.done).toBe(true);
    expect(final?.eval_count).toBe(3);
    expect(final?.eval_duration).toBe(60_000_000);
    expect(final?.prompt_eval_count).toBe(12);
  });

  test("keepAlive is forwarded when provided", async () => {
    const { impl, calls } = fetchNdjson(generateNdjson);
    const api = new OllamaApiClient({ transport: { fetch: impl } });
    await api.generate("m", "p", { keepAlive: 0, onChunk: () => {} });
    expect(JSON.parse(String(calls[0]?.init?.body)).keep_alive).toBe(0);
  });

  test("abort mid-stream resolves with null (never throws)", async () => {
    const controller = new AbortController();
    const { impl } = fetchAbortingNdjson(generateNdjson);
    const api = new OllamaApiClient({ transport: { fetch: impl } });
    const promise = api.generate("m", "p", { signal: controller.signal, onChunk: () => {} });
    controller.abort();
    await expect(promise).resolves.toBeNull();
  });
});
