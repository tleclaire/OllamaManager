/**
 * Typed Ollama REST client (ARCHITECTURE.md §4.2).
 * Framework-agnostic; the fetch transport is constructor-injectable for tests.
 *
 * Contract:
 * - Non-streaming calls use a 5s timeout (config.apiTimeoutMs).
 * - Streaming calls propagate the caller's AbortSignal; abort RESOLVES (never
 *   throws unhandled) — pull/chat abort is a first-class path, not an error path.
 * - All errors normalize to ApiError; raw fetch exceptions never escape.
 * - No retry logic here — retries are the pollers'/stores' job.
 */
import { config } from "../config";
import { createNdjsonParser } from "../lib/ndjson";

export type ApiErrorKind = "network" | "status" | "parse";
export type ApiError = { kind: ApiErrorKind; status?: number; message: string };

export type OllamaModel = {
  name: string;
  model: string;
  size: number;
  digest: string;
  modified_at: string;
  details: {
    family: string;
    families: string[] | null;
    parameter_size: string;
    quantization_level: string;
  };
};

export type RunningModel = {
  name: string;
  model: string;
  size: number;
  size_vram: number;
  expires_at: string;
};

export type ModelDetails = {
  license?: string;
  modelfile: string;
  parameters: string;
  template: string;
  details: OllamaModel["details"];
  capabilities?: string[];
};

export type PullProgress = { status: string; digest?: string; total?: number; completed?: number };

export type GenerateChunk = { model: string; response: string; done: boolean };
export type GenerateFinalChunk = GenerateChunk & {
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
};

export interface OllamaTransport {
  fetch: typeof fetch;
}

export class OllamaApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(deps?: { baseUrl?: string; transport?: OllamaTransport }) {
    this.baseUrl = (deps?.baseUrl ?? config.baseUrl).replace(/\/$/, "");
    this.fetchImpl = deps?.transport?.fetch ?? fetch;
  }

  // ---- JSON endpoints -------------------------------------------------------

  async listModels(): Promise<OllamaModel[]> {
    const body = await this.requestJson<{ models: OllamaModel[] }>("/api/tags");
    return Array.isArray(body.models) ? body.models : [];
  }

  async listRunning(): Promise<RunningModel[]> {
    const body = await this.requestJson<{ models: RunningModel[] }>("/api/ps");
    return Array.isArray(body.models) ? body.models : [];
  }

  async showModel(name: string): Promise<ModelDetails> {
    return this.requestJson<ModelDetails>("/api/show", { model: name });
  }

  async deleteModel(name: string): Promise<void> {
    await this.requestJson<unknown>("/api/delete", { model: name });
  }

  async copyModel(source: string, destination: string): Promise<void> {
    await this.requestJson<unknown>("/api/copy", { source, destination });
  }

  /** Unload a model: generate with an empty prompt and keep_alive 0 (§4.2). */
  async unload(model: string): Promise<void> {
    await this.requestJson<unknown>("/api/generate", {
      model,
      prompt: "",
      keep_alive: 0,
      stream: false,
    });
  }

  // ---- NDJSON streams -------------------------------------------------------

  /**
   * Stream a pull; onProgress fires per NDJSON progress chunk.
   * Resolves silently when `signal` aborts (the reader loop unwinds).
   */
  async pull(
    model: string,
    onProgress: (p: PullProgress) => void,
    signal: AbortSignal,
  ): Promise<void> {
    await this.streamNdjson<PullProgress>(
      "/api/pull",
      { model, stream: true },
      signal,
      (chunk) => {
        if (chunk && typeof chunk === "object") onProgress(chunk);
      },
    );
  }

  /**
   * Stream a generation. onChunk fires for every chunk (including the final
   * one). Resolves with the final chunk (done=true, eval stats), or null when
   * aborted before completion.
   */
  async generate(
    model: string,
    prompt: string,
    opts: {
      keepAlive?: number | string;
      signal?: AbortSignal;
      onChunk: (c: GenerateChunk) => void;
    },
  ): Promise<GenerateFinalChunk | null> {
    let final: GenerateFinalChunk | null = null;
    await this.streamNdjson<GenerateChunk>(
      "/api/generate",
      { model, prompt, stream: true, ...(opts.keepAlive !== undefined ? { keep_alive: opts.keepAlive } : {}) },
      opts.signal,
      (chunk) => {
        if (!chunk || typeof chunk !== "object") return;
        opts.onChunk(chunk);
        if (chunk.done) final = chunk as GenerateFinalChunk;
      },
    );
    return final;
  }

  // ---- internals -------------------------------------------------------------

  private async requestJson<T>(path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(config.apiTimeoutMs),
      });
    } catch (err) {
      throw this.normalizeNetworkError(err, `${path} request`);
    }
    if (!res.ok) {
      const text = await safeText(res);
      throw this.statusError(res.status, `${path} responded ${res.status}${text ? `: ${truncate(text)}` : ""}`);
    }
    try {
      return (await res.json()) as T;
    } catch {
      throw this.parseError(`${path} returned invalid JSON`);
    }
  }

  private async streamNdjson<T>(
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
    onLine: (obj: T) => void,
  ): Promise<void> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      // Caller abort during connect → silent unwind; anything else is an error.
      if (signal?.aborted) return;
      throw this.normalizeNetworkError(err, `${path} request`);
    }
    if (!res.ok) {
      const text = await safeText(res);
      throw this.statusError(res.status, `${path} responded ${res.status}${text ? `: ${truncate(text)}` : ""}`);
    }
    if (!res.body) {
      throw this.parseError(`${path} returned no response body`);
    }

    const decoder = new TextDecoder();
    const parser = createNdjsonParser<T>(onLine);
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        // Streaming decode: multi-byte UTF-8 chars can split across chunks.
        parser.feed(decoder.decode(value, { stream: true }));
      }
      parser.feed(decoder.decode());
      parser.end();
    } catch (err) {
      // Abort mid-stream → resolve silently (first-class abort path, §4.2).
      if (signal?.aborted) return;
      if (isAbortError(err)) return;
      throw this.parseError(`${path} stream failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private normalizeNetworkError(err: unknown, what: string): ApiError {
    if (isAbortError(err)) {
      // Our own 5s timeout aborts the request (no caller signal involved).
      return { kind: "network", message: `${what} timed out after ${config.apiTimeoutMs}ms` };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "network", message: `${what} failed: ${message}` };
  }

  private statusError(status: number, message: string): ApiError {
    return { kind: "status", status, message };
  }

  private parseError(message: string): ApiError {
    return { kind: "parse", message };
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function truncate(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
