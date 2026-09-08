/**
 * Logs pane: scrollbox with sticky-bottom streaming (§4.8).
 * `stickyScroll` + `stickyStart="bottom"` is the documented streaming-log
 * pattern; App's global handler re-sticks via the forwarded ref on g/End.
 */
import { useStore } from "../../hooks/useStore";
import type { LogStore } from "../../stores/logStore";
import { config } from "../../config";
import { formatClock } from "../../lib/format";
import { paneBorder, theme } from "../theme";

interface LogsPaneProps {
  logs: LogStore;
  focused: boolean;
  flexGrow: number;
  /** Forwarded to App's global key handler for g/End re-stick. */
  scrollRef: { current: ScrollBoxRef | null };
}

type ScrollBoxRef = {
  scrollBy(delta: number | { x?: number; y?: number }): void;
  scrollTo(pos: number | { x?: number; y?: number }): void;
  stickyScroll: boolean;
} | null;

function levelStyle(level: string): { label: string; color: string } {
  switch (level) {
    case "err":
      return { label: "ERR", color: theme.err };
    case "warn":
      return { label: "WRN", color: theme.warn };
    case "debug":
      return { label: "DBG", color: theme.dim };
    default:
      return { label: "INF", color: theme.text };
  }
}

export function LogsPane({ logs, focused, flexGrow, scrollRef }: LogsPaneProps) {
  const entries = useStore(logs, (s) => s.entries);
  const journalStatus = useStore(logs, (s) => s.journalStatus);
  const journalDetail = useStore(logs, (s) => s.journalDetail);
  const dropped = useStore(logs, (s) => s.dropped);

  // Render tail only (§4.6): full buffer stays in the store for future use.
  const tail = entries.slice(-config.buffers.logRenderTail);

  return (
    <box
      title={` Logs (3) ${focused ? "▸" : ""} `}
      borderStyle="double"
      border
      {...paneBorder(focused)}
      style={{ flexGrow, flexDirection: "column" }}
    >
      {journalStatus === "unavailable" || journalStatus === "restarting" ? (
        <box style={{ paddingLeft: 1 }}>
          <text>
            <span fg={theme.err}>
              {journalStatus === "unavailable"
                ? `journal unavailable — ${journalDetail ?? "unknown reason"}`
                : `journal restarting — ${journalDetail ?? ""}`}
            </span>
            {dropped > 0 ? <span fg={theme.dim}>{`  (${dropped} dropped)`}</span> : null}
          </text>
        </box>
      ) : null}
      <scrollbox
        ref={(r) => {
          scrollRef.current = r as unknown as ScrollBoxRef;
        }}
        focused={focused}
        stickyScroll
        stickyStart="bottom"
        style={{ flexGrow: 1, rootOptions: { backgroundColor: theme.bg } }}
      >
        {tail.length === 0 ? (
          <text fg={theme.dim}>
            {journalStatus === "live" ? "waiting for journal entries…" : "log streaming inactive"}
          </text>
        ) : (
          tail.map((entry) => {
            const style = levelStyle(entry.level);
            return (
              <text key={`${entry.seq}`}>
                <span fg={theme.dim}>{`${formatClock(entry.ts)} `}</span>
                <span fg={style.color}>{`${style.label} `}</span>
                <span fg={theme.text}>{entry.message}</span>
              </text>
            );
          })
        )}
      </scrollbox>
    </box>
  );
}
