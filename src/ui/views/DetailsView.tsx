/**
 * Model details view: capabilities, parameters, template, modelfile in a
 * scrollbox (§4.8). Read-only; Esc returns to main.
 */
import { useStore } from "../../hooks/useStore";
import type { ModelsStore } from "../../stores/modelsStore";
import type { UiStore } from "../../stores/uiStore";
import type { ModelDetails } from "../../services/ollamaApi";
import { theme } from "../theme";

interface DetailsViewProps {
  models: ModelsStore;
  ui: UiStore;
}

function Section({ title, body }: { title: string; body: string }) {
  if (!body || body.length === 0) return null;
  return (
    <box style={{ flexDirection: "column" }}>
      <text>
        <span fg={theme.borderFocused}>{`── ${title} `}</span>
      </text>
      <text>{body}</text>
    </box>
  );
}

export function DetailsView({ models, ui }: DetailsViewProps) {
  const detailsModel = useStore(ui, (s) => s.detailsModel);
  const detailsLoading = useStore(models, (s) => s.detailsLoading);
  const detailsError = useStore(models, (s) => s.lastError);
  // Only show details that belong to the model this view was opened for.
  const shown = useStore(models, (s) => (s.detailsModel !== null && s.detailsModel === detailsModel ? s.details : undefined));

  const heading = detailsModel ?? "model";
  const capabilities = shown?.capabilities?.join(", ") ?? "";

  return (
    <box
      title={` Details: ${heading} `}
      borderStyle="double"
      border
      borderColor={theme.borderFocused}
      titleColor={theme.borderFocused}
      style={{ flexGrow: 1, flexDirection: "column", padding: 1 }}
    >
      {detailsLoading ? (
        <text fg={theme.dim}>loading details…</text>
      ) : !shown ? (
        <box style={{ flexDirection: "column", gap: 1 }}>
          <text fg={theme.err}>{detailsError ?? "no details loaded"}</text>
        </box>
      ) : (
        <scrollbox focused style={{ flexGrow: 1 }}>
          <Section title="overview" body={familyLine(shown)} />
          {capabilities ? <Section title="capabilities" body={capabilities} /> : null}
          <Section title="parameters" body={shown.parameters} />
          <Section title="template" body={shown.template} />
          <Section title="modelfile" body={shown.modelfile} />
          {shown.license ? <Section title="license" body={shown.license} /> : null}
        </scrollbox>
      )}
      <text fg={theme.dim}>Esc back · PgUp/PgDn or ↑/↓ scroll</text>
    </box>
  );
}

function familyLine(details: ModelDetails): string {
  const d = details.details;
  return `family ${d.family}  params ${d.parameter_size}  quant ${d.quantization_level}${
    d.families?.length ? `  families ${d.families.join(",")}` : ""
  }`;
}
