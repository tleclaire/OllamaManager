/**
 * Models pane: select list + running indicator + inline banners (§4.8).
 * The <select> handles ↑/↓/j/k/Enter natively when focused; onChange syncs
 * the selection into the store.
 */
import { useEffect, useRef } from "react";
import { useStore } from "../../hooks/useStore";
import type { ModelsStore } from "../../stores/modelsStore";
import type { UiStore } from "../../stores/uiStore";
import { formatBytes } from "../../lib/format";
import { paneBorder, theme } from "../theme";

interface ModelsPaneProps {
  models: ModelsStore;
  ui: UiStore;
  focused: boolean;
  /** e.g. "38%" — typed to match OpenTUI's dimension literal. */
  width: `${number}%`;
}

export function ModelsPane({ models, ui, focused, width }: ModelsPaneProps) {
  const tags = useStore(models, (s) => s.tags);
  const running = useStore(models, (s) => s.running);
  const apiStatus = useStore(models, (s) => s.apiStatus);
  const lastError = useStore(models, (s) => s.lastError);
  const selectRef = useRef<{ setSelectedIndex(i: number): void } | null>(null);

  const runningNames = new Set(running.map((r) => r.name));

  const options = tags.map((m) => ({
    name: `${runningNames.has(m.name) ? "● " : "  "}${m.name}`,
    description: `${formatBytes(m.size)}  ${m.details.quantization_level}  ${m.details.parameter_size}`,
    value: m.name,
  }));

  // Keep the select's highlight on the store-selected model when the list
  // refreshes (inventory can change underneath us).
  const selected = useStore(models, (s) => s.selected);
  useEffect(() => {
    if (!selected) return;
    const idx = options.findIndex((o) => o.value === selected);
    if (idx >= 0) selectRef.current?.setSelectedIndex(idx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.length, selected]);

  return (
    <box
      title={` Models (1) ${focused ? "▸" : ""} `}
      borderStyle="double"
      border
      {...paneBorder(focused)}
      style={{ width, flexDirection: "column", paddingLeft: 0, paddingRight: 0 }}
    >
      {apiStatus === "down" ? (
        <box style={{ flexDirection: "column", paddingLeft: 1, paddingRight: 1 }}>
          <text>
            <span fg={theme.err}>api down — showing last known list</span>
          </text>
          {lastError ? (
            <text>
              <span fg={theme.dim}>{lastError.slice(0, 60)}</span>
            </text>
          ) : null}
        </box>
      ) : null}
      {options.length === 0 && apiStatus !== "down" ? (
        <text fg={theme.dim}>{apiStatus === "checking" ? "loading models…" : "no models found"}</text>
      ) : (
        <select
          ref={(r) => {
            selectRef.current = (r as unknown as { setSelectedIndex(i: number): void }) ?? null;
          }}
          focused={focused}
          options={options}
          onSelect={(_index, option) => {
            // Enter on a highlighted entry: make it the chat target and open
            // the chat pane (details stay reachable via the m actions menu).
            const name = (option?.value as string | undefined) ?? option?.name;
            if (name) {
              models.select(name);
              ui.openChat();
            }
          }}
          onChange={(_index, option) => {
            const name = (option?.value as string | undefined) ?? option?.name;
            if (name) models.select(name);
          }}
          style={{ flexGrow: 1, flexBasis: 0 }}
        />
      )}
    </box>
  );
}
