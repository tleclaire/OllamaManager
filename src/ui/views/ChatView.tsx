/**
 * Chat / benchmark pane (§4.8): right-hand column next to the main panes so
 * Stats/Logs keep streaming while chatting. Transcript scrollbox, prompt
 * input, streaming indicator, TTFT/tok-s of the last run, benchmark trigger.
 */
import { useEffect, useRef } from "react";
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

export function ChatView({ chat, models, ui }: ChatViewProps) {
  const messages = useStore(chat, (s) => s.messages);
  const current = useStore(chat, (s) => s.current);
  const streaming = useStore(chat, (s) => s.streaming);
  const error = useStore(chat, (s) => s.error);
  const lastBench = useStore(chat, (s) => s.lastBench);
  const chatModel = useStore(chat, (s) => s.model);
  const selectedModel = useStore(models, (s) => s.selected);
  const inputFocused = useStore(ui, (s) => s.textCapture);
  const inputRef = useRef<{ focus(): void; blur(): void } | null>(null);

  useEffect(() => {
    if (inputFocused) inputRef.current?.focus();
    else inputRef.current?.blur();
  }, [inputFocused]);

  const effectiveModel = chatModel ?? selectedModel;

  return (
    <box
      title={` Chat (c) ${inputFocused ? "▸ " : ""}${effectiveModel ? `· ${effectiveModel}` : "· no model selected"} `}
      borderStyle="double"
      border
      borderColor={inputFocused ? theme.borderFocused : theme.border}
      titleColor={inputFocused ? theme.borderFocused : theme.border}
      style={{ width: "34%", flexShrink: 0, flexDirection: "column", padding: 1, gap: 1 }}
    >
      <scrollbox focused={!inputFocused} stickyScroll stickyStart="bottom" style={{ flexGrow: 1, flexBasis: 0 }}>
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

      <box style={{ flexDirection: "row", gap: 1 }}>
        <text fg={theme.dim}>{inputFocused ? "›" : "› (Enter to focus)"}</text>
        <input
          ref={(r) => {
            inputRef.current = (r as unknown as { focus(): void; blur(): void }) ?? null;
          }}
          focused={inputFocused}
          placeholder={effectiveModel ? "prompt…" : "select a model in the Models pane first (c opens chat)"}
          onInput={() => ui.setTextCapture(true)}
          onSubmit={(value) => {
            const prompt = typeof value === "string" ? value : "";
            if (prompt.length === 0) return;
            if (effectiveModel) chat.setModel(effectiveModel);
            void chat.send(prompt);
            ui.setTextCapture(false);
            inputRef.current?.blur();
          }}
          style={{ flexGrow: 1, flexBasis: 0 }}
        />
      </box>
    </box>
  );
}
