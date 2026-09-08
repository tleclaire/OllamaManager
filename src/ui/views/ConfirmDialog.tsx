/**
 * Overlay dialogs: destructive-action confirmation (§4.8), the copy-model
 * destination prompt, and the `m` model-actions menu. Grouped in one file to
 * keep the view tree flat; each is a separate exported component.
 */
import { useEffect, useRef } from "react";
import { useStore } from "../../hooks/useStore";
import type { UiStore } from "../../stores/uiStore";
import { theme } from "../theme";

interface DialogProps {
  ui: UiStore;
}

export function ConfirmDialog({ ui }: DialogProps) {
  const confirm = useStore(ui, (s) => s.confirm);
  if (!confirm) return null;
  return (
    <box
      title={` ${confirm.title} `}
      borderStyle="double"
      border
      borderColor={theme.err}
      titleColor={theme.err}
      style={{
        position: "absolute",
        left: 8,
        right: 8,
        top: 6,
        height: 7,
        flexDirection: "column",
        padding: 1,
        backgroundColor: theme.bg,
      }}
    >
      <text fg={theme.text}>{confirm.message}</text>
      <text>
        <span fg={theme.ok}>{`y / Enter = ${confirm.confirmLabel}`}</span>
        <span fg={theme.dim}>   n / Esc = cancel</span>
      </text>
    </box>
  );
}

export function InputPromptDialog({ ui }: DialogProps) {
  const prompt = useStore(ui, (s) => s.inputPrompt);
  const inputFocused = useStore(ui, (s) => s.textCapture);
  const inputRef = useRef<{ focus(): void; blur(): void } | null>(null);
  const isOpen = prompt !== null;

  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus();
      ui.setTextCapture(true);
    }
    return () => {
      if (isOpen) ui.setTextCapture(false);
    };
    // Re-run only when the dialog opens/closes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  if (!prompt) return null;
  return (
    <box
      title={` ${prompt.title} `}
      borderStyle="double"
      border
      borderColor={theme.borderFocused}
      titleColor={theme.borderFocused}
      style={{
        position: "absolute",
        left: 8,
        right: 8,
        top: 8,
        height: 5,
        flexDirection: "column",
        padding: 1,
        backgroundColor: theme.bg,
      }}
    >
      <box style={{ flexDirection: "row", gap: 1 }}>
        <text fg={theme.dim}>name:</text>
        <input
          ref={(r) => {
            inputRef.current = (r as unknown as { focus(): void; blur(): void }) ?? null;
          }}
          focused={inputFocused}
          placeholder={prompt.placeholder}
          onSubmit={(value) => {
            const name = (typeof value === "string" ? value : "").trim();
            ui.dismissInputPrompt();
            if (name.length > 0) prompt.onSubmit(name);
            else prompt.onCancel?.();
          }}
          style={{ flexGrow: 1, flexBasis: 0 }}
        />
      </box>
      <text fg={theme.dim}>Enter confirm · Esc cancel</text>
    </box>
  );
}

export function ActionMenuDialog({ ui }: DialogProps) {
  const model = useStore(ui, (s) => s.actionMenu);
  if (!model) return null;
  const options = [
    { name: "details", description: "Show modelfile / parameters / capabilities", value: "details" },
    { name: "delete", description: "Delete this model from disk (asks twice)", value: "delete" },
    { name: "copy", description: "Copy to a new name (asks for destination)", value: "copy" },
    { name: "unload", description: "Unload from memory (keep_alive=0)", value: "unload" },
  ];
  return (
    <box
      title={` Actions: ${model} `}
      borderStyle="double"
      border
      borderColor={theme.borderFocused}
      titleColor={theme.borderFocused}
      style={{
        position: "absolute",
        left: 20,
        right: 20,
        top: 6,
        height: 9,
        flexDirection: "column",
        padding: 1,
        backgroundColor: theme.bg,
      }}
    >
      <select
        focused
        options={options}
        onSelect={(_index, option) => {
          const action = option?.value as string | undefined;
          ui.closeActionMenu();
          if (action) openAction(ui, model, action);
        }}
        onChange={() => {
          /* selection highlight only */
        }}
        style={{ flexGrow: 1, flexBasis: 0 }}
      />
      <text fg={theme.dim}>Esc closes</text>
    </box>
  );
}

function openAction(ui: UiStore, model: string, action: string): void {
  switch (action) {
    case "details":
      ui.openDetails(model);
      break;
    case "copy":
      ui.requestInputPrompt({
        title: " Copy model ",
        placeholder: "destination name, e.g. qwen3.5:9b-backup",
        onSubmit: (destination) => {
          ui.requestConfirm({
            title: " Copy model ",
            message: `Copy "${model}" to "${destination}"? An existing destination is overwritten.`,
            confirmLabel: "copy",
            action: { kind: "copyModel", source: model, destination },
          });
        },
      });
      break;
    case "delete":
      ui.requestConfirm({
        title: " Delete model ",
        message: `Delete "${model}" from disk? This cannot be undone.`,
        confirmLabel: "delete",
        action: { kind: "deleteModel", model },
      });
      break;
    case "unload":
      ui.requestConfirm({
        title: " Unload model ",
        message: `Unload "${model}" from memory now?`,
        confirmLabel: "unload",
        action: { kind: "unloadModel", model },
      });
      break;
    default:
      break;
  }
}
