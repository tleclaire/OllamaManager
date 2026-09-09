/**
 * Stats pane: GPU/CPU/RAM readouts, sparklines, running models with expiry
 * countdown, last benchmark line (§4.8).
 */
import { useStore } from "../../hooks/useStore";
import type { StatsStore } from "../../stores/statsStore";
import type { ModelsStore } from "../../stores/modelsStore";
import { config } from "../../config";
import { formatBytes, formatDurationMs, formatExpiry, sparkline } from "../../lib/format";
import { paneBorder, theme } from "../theme";

interface StatsPaneProps {
  stats: StatsStore;
  models: ModelsStore;
  focused: boolean;
  flexGrow: number;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <text>
      <span fg={theme.dim}>{`${label.padEnd(9, " ")} `}</span>
      {children}
    </text>
  );
}

export function StatsPane({ stats, models, focused, flexGrow }: StatsPaneProps) {
  const gpu = useStore(stats, (s) => s.gpu);
  const gpuStatus = useStore(stats, (s) => s.gpuStatus);
  const gpuDetail = useStore(stats, (s) => s.gpuDetail);
  const gpuSeries = useStore(stats, (s) => s.gpuSeries);
  const proc = useStore(stats, (s) => s.proc);
  const procStatus = useStore(stats, (s) => s.procStatus);
  const procDetail = useStore(stats, (s) => s.procDetail);
  const cpuSeries = useStore(stats, (s) => s.cpuSeries);
  const benchmarks = useStore(stats, (s) => s.benchmarks);
  const running = useStore(models, (s) => s.running);
  const now = Date.now();

  const gpuUtilSpark = sparkline(gpuSeries.sliceLast(config.buffers.sparklinePoints).map((s) => s.utilPct));
  const cpuSpark = sparkline(cpuSeries.sliceLast(config.buffers.sparklinePoints));
  const lastBench = benchmarks[0];
  const lastTokPerSecFor = (model: string) => benchmarks.find((b) => b.model === model)?.tokPerSec ?? null;

  return (
    <box
      title={` Stats (2) ${focused ? "▸" : ""} `}
      borderStyle="double"
      border
      {...paneBorder(focused)}
      style={{ flexGrow, flexBasis: 0, flexDirection: "column", paddingLeft: 1, paddingRight: 1 }}
    >
      <Row label="GPU">
        {gpu && gpuStatus === "ok" ? (
          <span fg={theme.text}>
            {`util ${gpu.utilPct}%  VRAM ${formatBytes(gpu.memUsedMb * 1024 ** 2)}/${formatBytes(
              gpu.memTotalMb * 1024 ** 2,
            )}  temp ${gpu.tempC}°C${gpu.fanPct !== null ? `  fan ${gpu.fanPct}%` : ""}${
              gpu.powerW !== null ? `  ${gpu.powerW}W` : ""
            }`}
          </span>
        ) : (
          <span fg={theme.dim}>
            {gpuStatus === "unavailable" ? "nvidia-smi not available" : `gpu ${gpuStatus}${gpuDetail ? ` — ${gpuDetail}` : ""}`}
          </span>
        )}
      </Row>
      <Row label="">
        <span fg={theme.accent}>{gpuUtilSpark}</span>
      </Row>
      <Row label="ollama">
        {procStatus === "running" && proc ? (
          <span fg={theme.text}>
            {`(pid ${proc.pid})  CPU ${proc.cpuPct.toFixed(0)}%  RSS ${formatBytes(proc.rssBytes)}  threads ${proc.threads}`}
          </span>
        ) : procStatus === "idle" ? (
          <span fg={theme.warn}>idle — ollama not running</span>
        ) : (
          <span fg={theme.err}>{`proc ${procStatus}${procDetail ? ` — ${procDetail}` : ""}`}</span>
        )}
      </Row>
      <Row label="">
        <span fg={theme.accent}>{cpuSpark}</span>
      </Row>
      <Row label="Running">
        {running.length === 0 ? (
          <span fg={theme.dim}>none loaded</span>
        ) : (
          <span fg={theme.text}>
             {running
               .slice(0, 2)
               .map((r) => {
                 const tokPerSec = lastTokPerSecFor(r.name);
                 return `${r.name}  VRAM ${formatBytes(r.size_vram)}  ${
                   tokPerSec !== null ? tokPerSec.toFixed(1) : "—"
                 } tok/s  expires ${formatExpiry(r.expires_at, now)}`;
               })
               .join("  ·  ")}
          </span>
        )}
      </Row>
      <Row label="Bench">
        {lastBench ? (
          <span fg={theme.text}>
            {`${lastBench.model}  TTFT ${formatDurationMs(lastBench.ttftMs)}  ${
              lastBench.tokPerSec !== null ? lastBench.tokPerSec.toFixed(1) : "—"
            } tok/s`}
          </span>
        ) : (
          <span fg={theme.dim}>press c → b to benchmark the chat model</span>
        )}
      </Row>
    </box>
  );
}
