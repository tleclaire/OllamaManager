/**
 * One status line: API / journal / GPU / proc status dots + hint text (§4.8).
 */
import { useStore } from "../hooks/useStore";
import type { LogStore } from "../stores/logStore";
import type { ModelsStore } from "../stores/modelsStore";
import type { StatsStore } from "../stores/statsStore";
import { HINT_LINE } from "./keybindings";
import { statusColor, theme } from "./theme";

interface StatusBarProps {
  models: ModelsStore;
  logs: LogStore;
  stats: StatsStore;
}

function Dot({ label, status, detail }: { label: string; status: string; detail?: string }) {
  const color = statusColor(status);
  return (
    <text>
      <span fg={theme.dim}>{`${label} `}</span>
      <span fg={color}>●</span>
      <span fg={color}>{` ${status}`}</span>
      {detail ? <span fg={theme.dim}>{` (${detail})`}</span> : null}
    </text>
  );
}

export function StatusBar({ models, logs, stats }: StatusBarProps) {
  const apiStatus = useStore(models, (s) => s.apiStatus);
  const journalStatus = useStore(logs, (s) => s.journalStatus);
  const gpuStatus = useStore(stats, (s) => s.gpuStatus);
  const procStatus = useStore(stats, (s) => s.procStatus);
  const gpuDetail = useStore(stats, (s) => s.gpuDetail);

  return (
    <box style={{ flexDirection: "row", height: 1, paddingLeft: 1, paddingRight: 1, gap: 2, backgroundColor: theme.bg }}>
      <Dot label="api" status={apiStatus} />
      <Dot label="journal" status={journalStatus} />
      <Dot label="gpu" status={gpuStatus} />
      <Dot label="proc" status={procStatus} />
      <box style={{ flexGrow: 1 }} />
      <text fg={theme.dim}>{HINT_LINE}</text>
    </box>
  );
}
