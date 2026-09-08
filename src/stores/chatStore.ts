/**
 * Chat / benchmark session (§4.6).
 * TTFT = wall-clock from fetch start until the first chunk with a non-empty
 * response (ADR-9). Chunks append to the current assistant message through
 * the same 100 ms trailing-edge flush as logs (burst backpressure).
 * Every completed generation records a BenchResult and pushes it into the
 * stats store (cap 50).
 */
import { config } from "../config";
import { computeBenchStats, type BenchResult } from "../lib/bench";
import { type TimerDeps, realTimerDeps } from "../lib/timers";
import { OllamaApiClient } from "../services/ollamaApi";
import { StoreBase, TrailingEdgeFlush } from "./base";
import type { StatsStore } from "./statsStore";

export type ChatMessage = { role: "user" | "assistant"; content: string; ttftMs?: number };

export type ChatState = {
  model: string | null;
  prompt: string;
  streaming: boolean;
  aborted: boolean;
  /** Bounded transcript (cap 200). */
  messages: ChatMessage[];
  /** In-flight assistant message; text lands in the snapshot on each flush. */
  current: { text: string; ttftMs?: number; chars: number } | null;
  /** Message of the last failed generation (e.g. ApiError from a 404 or network drop). */
  error?: string;
  lastBench: BenchResult | null;
};

export class ChatStore extends StoreBase<ChatState> {
  private readonly api: OllamaApiClient;
  private readonly stats: StatsStore;
  private readonly timers: TimerDeps;
  private readonly flusher: TrailingEdgeFlush;
  private readonly messagesCap: number;
  private controller: AbortController | null = null;
  private pendingText = "";

  constructor(deps: {
    api: OllamaApiClient;
    stats: StatsStore;
    timers?: TimerDeps;
    flushMs?: number;
    messagesCap?: number;
  }) {
    super({
      model: null,
      prompt: "",
      streaming: false,
      aborted: false,
      messages: [],
      current: null,
      lastBench: null,
    });
    this.api = deps.api;
    this.stats = deps.stats;
    this.timers = deps.timers ?? realTimerDeps;
    this.flusher = new TrailingEdgeFlush(this.timers, deps.flushMs ?? config.flushMs, () => this.flushStreamingText());
    this.messagesCap = deps.messagesCap ?? config.buffers.chatMessages;
  }

  stop(): void {
    this.controller?.abort();
    this.controller = null;
    this.flusher.cancel();
  }

  setModel(model: string | null): void {
    this.update({ model });
  }

  setPrompt(prompt: string): void {
    this.update({ prompt });
  }

  /** Send a prompt to the selected model; streams the reply. */
  async send(prompt: string): Promise<void> {
    if (this.snapshot.streaming) return;
    const model = this.snapshot.model;
    if (!model || prompt.length === 0) return;

    const startedAt = this.timers.now();
    let firstTokenAt: number | null = null;
    this.pendingText = "";
    this.update({
      prompt: "",
      streaming: true,
      aborted: false,
      error: undefined,
      messages: this.pushMessage([...this.snapshot.messages], { role: "user", content: prompt }),
      current: { text: "", chars: 0 },
    });

    const controller = new AbortController();
    this.controller = controller;

    let final: Awaited<ReturnType<OllamaApiClient["generate"]>> = null;
    let error: string | undefined;
    try {
      final = await this.api.generate(model, prompt, {
        signal: controller.signal,
        onChunk: (chunk) => {
          if (!chunk.response) return;
          if (firstTokenAt === null) firstTokenAt = this.timers.now();
          this.pendingText += chunk.response;
          this.flusher.schedule();
        },
      });
    } catch (err) {
      // Stream failures resolve without throwing by API contract; a rejection
      // here is upstream garbage (ApiError 404 model-not-found, network drop,
      // …). Surface it on the state — swallowing it strands the user with an
      // empty assistant message and no diagnosis. ApiError is a plain object,
      // so extract .message defensively instead of relying on instanceof.
      const raw = (err as { message?: unknown } | null)?.message;
      error = typeof raw === "string" && raw.length > 0 ? raw : String(err);
    } finally {
      this.controller = null;
      const wasAborted = controller.signal.aborted;
      const ttftMs = firstTokenAt !== null ? firstTokenAt - startedAt : 0;
      this.update({
        streaming: false,
        aborted: wasAborted,
        error,
        messages: this.pushMessage([...this.snapshot.messages], {
          role: "assistant",
          content: this.pendingText,
          ...(ttftMs > 0 ? { ttftMs } : {}),
        }),
        current: null,
      });
      this.pendingText = "";
      this.flusher.cancel();

      if (final && !wasAborted) {
        const bench = computeBenchStats(model, final, ttftMs, startedAt, this.timers.now());
        this.update({ lastBench: bench });
        this.stats.addBenchmark(bench);
      }
    }
  }

  /** Abort the running stream — resolves, never throws (§4.2). */
  abort(): void {
    if (!this.controller) return;
    this.controller.abort();
  }

  /** Run the preset benchmark prompt (key `b`). */
  runBenchmark(): Promise<void> {
    return this.send(config.benchmarkPrompt);
  }

  /** Copy the in-flight text into the snapshot (≤ one flush per flushMs). */
  private flushStreamingText(): void {
    if (!this.snapshot.current) return;
    this.update({
      current: { text: this.pendingText, chars: this.pendingText.length },
    });
  }

  private pushMessage(messages: ChatMessage[], message: ChatMessage): ChatMessage[] {
    messages.push(message);
    return messages.length > this.messagesCap ? messages.slice(messages.length - this.messagesCap) : messages;
  }
}
