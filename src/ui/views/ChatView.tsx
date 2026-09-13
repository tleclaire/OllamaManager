/**
 * Chat / benchmark pane (§4.8): right-hand column next to the main panes so
 * Stats/Logs keep streaming while chatting. Transcript scrollbox, prompt
 * input, streaming indicator, TTFT/tok-s of the last run, benchmark trigger.
 */
import { useEffect, useRef, useState } from "react";
import { useStore } from "../../hooks/useStore";
import type { ChatStore } from "../../stores/chatStore";
import type { ModelsStore } from "../../stores/modelsStore";
import type { UiStore } from "../../stores/uiStore";
import { formatDurationMs } from "../../lib/format";
import { theme } from "../theme";

interface ChatViewProps {
  chat: ChatStore;
  models: ModelsStore;
  ui: UiStore;
}

function KnightRider({ width = 15, delayMs = 80 }: { width?: number; delayMs?: number }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => (n + 1) % (2 * (width - 2))), delayMs);
    return () => clearInterval(timer);
  }, [width, delayMs]);
  const period = 2 * (width - 2);
  let pos = tick % period;
  if (pos > width - 2) pos = period - pos;
  return (
    <text>
      <span fg={theme.dim}>{`${"·".repeat(pos)}`}</span>
      <span fg={theme.warn}>{`▌▌`}</span>
      <span fg={theme.dim}>{`${"·".repeat(width - pos - 2)}`}</span>
    </text>
  );
}

export function ChatView({ chat, models, ui }: ChatViewProps) {
  const messages = useStore(chat, (s) => s.messages);
  const current = useStore(chat, (s) => s.current);
  const streaming = useStore(chat, (s) => s.streaming);
  const error = useStore(chat, (s) => s.error);
  const lastBench = useStore(chat, (s) => s.lastBench);
  const chatModel = useStore(chat, (s) => s.model);
  const selectedModel = useStore(models, (s) => s.selected);
  const inputFocused = useStore(ui, (s) => s.textCapture);
  const inputRef = useRef<{ value: string; focus(): void; blur(): void } | null>(null);

  useEffect(() => {
    if (inputFocused) inputRef.current?.focus();
    else inputRef.current?.blur();
  }, [inputFocused]);

  // The chat target live-follows the models list: the marked entry (or, on a
  // fresh boot before any onChange, the first entry) is what sends will use.
  useEffect(() => {
    const marked = selectedModel ?? models.getSnapshot().tags[0]?.name ?? null;
    chat.setModel(marked);
  }, [selectedModel, chat, models]);

  const effectiveModel = chatModel ?? selectedModel;

  return (
    <box
      title={` Chat (c) ${inputFocused ? "▸ " : ""}${effectiveModel ? `· ${effectiveModel}` : "· no model selected"} `}
      borderStyle="double"
      border
      borderColor={inputFocused ? theme.borderFocused : theme.border}
      titleColor={inputFocused ? theme.borderFocused : theme.border}
      onMouseDown={() => ui.setTextCapture(true)}
      style={{ width: "34%", flexShrink: 0, flexDirection: "column", padding: 1, gap: 1 }}
    >
      <scrollbox
        focused={!inputFocused}
        stickyScroll
        stickyStart="bottom"
        onMouseDown={(e: { stopPropagation(): void }) => {
          e.stopPropagation();
          ui.setTextCapture(false);
        }}
        style={{ flexGrow: 1, flexBasis: 0 }}
      >
        {messages.length === 0 && !current ? (
          <text fg={theme.dim}>
            Type a prompt and press Enter. Press Esc to blur the input, then `a` aborts, `b` runs the preset benchmark.
          </text>
        ) : null}
        {messages.map((m, i) => (
          <text key={`${i}`}>
            <span fg={m.role === "user" ? theme.accent : theme.ok}>{m.role === "user" ? "you › " : "ollama › "}</span>
            <span fg={theme.text}>{m.content}</span>
          </text>
        ))}
        {current ? (
          <text>
            <span fg={theme.ok}>ollama › </span>
            <span fg={theme.text}>{current.text}</span>
            <span fg={theme.dim}>{streaming ? " ▌" : ""}</span>
          </text>
        ) : null}
        {error ? (
          <text>
            <span fg={theme.err}>{`error › ${error}`}</span>
          </text>
        ) : null}
      </scrollbox>

      <text fg={theme.dim}>
        {lastBench
          ? `last bench: ${lastBench.model}  TTFT ${formatDurationMs(lastBench.ttftMs)}  ${
              lastBench.tokPerSec !== null ? lastBench.tokPerSec.toFixed(1) : "—"
            } tok/s  (${lastBench.evalCount ?? "?"} eval tokens)`
          : "no benchmark yet — b runs the preset prompt"}
        {streaming ? "  · streaming…" : ""}
      </text>

      <text>
        <span fg={theme.accent}>{`chat`}</span>
        <span fg={theme.dim}>{` · `}</span>
        <span fg={theme.text}>{effectiveModel ?? "no model selected"}</span>
        <span fg={theme.dim}>{` ·  OllamaManager`}</span>
      </text>

      <box style={{ flexDirection: "row" }}>
        <text fg={inputFocused ? theme.accent : theme.dim}>{`▌`}</text>
        <input
          ref={(r) => {
            inputRef.current = (r as unknown as { value: string; focus(): void; blur(): void }) ?? null;
          }}
          focused={inputFocused}
          placeholder={effectiveModel ? "prompt…" : "select a model in the Models pane first (c opens chat)"}
          onInput={() => ui.setTextCapture(true)}
          onSubmit={(value) => {
            const prompt = typeof value === "string" ? value : "";
            if (prompt.length === 0) return;
            if (effectiveModel) chat.setModel(effectiveModel);
            void chat.send(prompt);
            // Keep focus for the next prompt; clear the field (OpenTUI does
            // not clear on submit). send() no-ops while streaming.
            if (inputRef.current) inputRef.current.value = "";
          }}
          style={{ flexGrow: 1, flexBasis: 0 }}
        />
      </box>

      <box style={{ flexDirection: "row" }}>
        {streaming ? (
          <KnightRider />
        ) : (
          <text fg={theme.dim}>{`ready`}</text>
        )}
        <box style={{ flexGrow: 1, flexBasis: 0 }} />
        <text fg={theme.dim}>{`esc blur · a abort`}</text>
      </box>
    </box>
  );
}
