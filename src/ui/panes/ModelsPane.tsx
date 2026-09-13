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

interface ModelNodeLike {
  y: number;
  parent?: ModelNodeLikeOrRoot | null;
}
interface ModelNodeLikeOrRoot {
  y?: number;
  parent?: ModelNodeLikeOrRoot | null;
}
interface SelectInternals {
  setSelectedIndex(i: number): void;
  scrollOffset?: number;
  linesPerItem?: number;
}

export function ModelsPane({ models, ui, focused, width }: ModelsPaneProps) {
  const tags = useStore(models, (s) => s.tags);
  const running = useStore(models, (s) => s.running);
  const apiStatus = useStore(models, (s) => s.apiStatus);
  const lastError = useStore(models, (s) => s.lastError);
  const selectRef = useRef<{ setSelectedIndex(i: number): void } | null>(null);
  const internalsRef = useRef<SelectInternals | null>(null);
  const lastClick = useRef<{ ts: number; index: number } | null>(null);

  const runningNames = new Set(running.map((r) => r.name));

  const options = tags.map((m) => ({
    name: `${runningNames.has(m.name) ? "● " : "  "}${m.name}`,
    description: `${formatBytes(m.size)}  ${m.details.quantization_level}  ${m.details.parameter_size}`,
    value: m.name,
  }));

  const pickOption = (event: { y: number }) => {
    const node = internalsRef.current as unknown as (ModelNodeLike & SelectInternals) | null;
    if (!node) return null;
    let absY = node.y ?? 0;
    let cur = node.parent ?? null;
    while (cur) {
      absY += cur.y ?? 0;
      cur = cur.parent ?? null;
    }
    const linesPerItem = node.linesPerItem ?? 2;
    const scrollOffset = node.scrollOffset ?? 0;
    const localY = event.y - absY;
    if (localY < 0) return null;
    const index = scrollOffset + Math.floor(localY / linesPerItem);
    if (index < 0 || index >= options.length) return null;
    return options[index];
  };

  const onMouse = (event: { button: number; type: string; y: number }) => {
    if (event.type !== "down") return;
    if (event.button === 2) {
      const option = pickOption(event) ?? null;
      const name = option?.value ?? models.getSnapshot().selected;
      if (name) {
        ui.setTextCapture(false);
        ui.openActionMenu(name);
      }
      return;
    }
    if (event.button !== 0) return;
    ui.setFocusPane("models");
    const option = pickOption(event);
    if (!option?.value) return;
    const index = options.indexOf(option);
    selectRef.current?.setSelectedIndex(index);
    const now = Date.now();
    const previous = lastClick.current;
    lastClick.current = { ts: now, index };
    if (previous && now - previous.ts < 350 && previous.index === index) {
      lastClick.current = null;
      models.select(option.value);
      ui.openChat();
    }
  };

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
      onMouseDown={() => ui.setFocusPane("models")}
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
            selectRef.current =
              internalsRef.current =
              (r as unknown as SelectInternals) ?? null;
          }}
          focused={focused}
          options={options}
          onMouse={onMouse}
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
