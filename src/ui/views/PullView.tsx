/**
 * Pull view: model-name input, live per-pull progress bars, abort (§4.8).
 * Input focus is driven by uiStore so the global Escape flow can blur it.
 */
import { useEffect, useRef } from "react";
import { useStore } from "../../hooks/useStore";
import type { PullStore } from "../../stores/pullStore";
import type { UiStore } from "../../stores/uiStore";
import { formatBytes } from "../../lib/format";
import { theme } from "../theme";

interface PullViewProps {
  pull: PullStore;
  ui: UiStore;
}

function ProgressBar({ pct, done }: { pct: number; done?: string }) {
  const width = 30;
  const filled = Math.round((pct / 100) * width);
  const bar = `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
  const color = done === "failed" ? theme.err : done === "aborted" ? theme.warn : theme.ok;
  return (
    <text>
      <span fg={color}>{bar}</span>
      <span fg={theme.text}>{` ${String(pct).padStart(3, " ")}%`}</span>
    </text>
  );
}

export function PullView({ pull, ui }: PullViewProps) {
  const pulls = useStore(pull, (s) => s.pulls);
  const inputFocused = useStore(ui, (s) => s.textCapture);
  const inputRef = useRef<{ value: string; focus(): void; blur(): void; clear?(): boolean } | null>(null);

  // Auto-focus the input on mount; reflect uiStore-driven blur.
  useEffect(() => {
    if (inputFocused) inputRef.current?.focus();
    else inputRef.current?.blur();
  }, [inputFocused]);

  const entries = Object.values(pulls).sort((a, b) => b.startedAt - a.startedAt);

  return (
    <box title=" Pull a model " borderStyle="double" border borderColor={theme.borderFocused} titleColor={theme.borderFocused} style={{ flexGrow: 1, flexDirection: "column", padding: 1, gap: 1 }}>
      <box style={{ flexDirection: "row", gap: 1 }}>
        <text fg={theme.dim}>model:</text>
        <input
          ref={(r) => {
            inputRef.current = (r as unknown as { value: string; focus(): void; blur(): void }) ?? null;
          }}
          focused={inputFocused}
          placeholder="e.g. qwen2.5:0.5b  (Enter starts)"
          onSubmit={(value) => {
            const name = (typeof value === "string" ? value : "").trim();
            if (name.length > 0) {
              pull.start(name);
              ui.setTextCapture(false);
              inputRef.current?.blur();
            }
          }}
          onInput={() => ui.setTextCapture(true)}
          style={{ flexGrow: 1, flexBasis: 0 }}
        />
      </box>
      <text fg={theme.dim}>
        Enter start · Esc blur input · Esc again leaves · a aborts (when input not focused)
      </text>
      <box style={{ flexDirection: "column", flexGrow: 1, flexBasis: 0 }}>
        {entries.length === 0 ? (
          <text fg={theme.dim}>no pulls yet — type a model name and press Enter</text>
        ) : (
          entries.map((entry) => (
            <box key={entry.model} style={{ flexDirection: "column" }}>
              <text>
                <span fg={entry.done === "failed" ? theme.err : theme.text}>{entry.model}</span>
                <span fg={theme.dim}>
                  {entry.done
                    ? `  ${entry.done}${entry.error ? `: ${entry.error}` : ""}`
                    : `  ${entry.progress.status ?? ""}`}
                </span>
                {typeof entry.progress.total === "number" && typeof entry.progress.completed === "number" ? (
                  <span fg={theme.dim}>
                    {`  ${formatBytes(entry.progress.completed)} / ${formatBytes(entry.progress.total)}`}
                  </span>
                ) : null}
              </text>
              <ProgressBar pct={entry.pct} done={entry.done} />
            </box>
          ))
        )}
      </box>
    </box>
  );
}
