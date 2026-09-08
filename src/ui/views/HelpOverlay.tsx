/**
 * Help overlay: renders the keymap table from keybindings.ts (single source
 * of truth — the help text can never drift from the handler, §4.8).
 */
import { allKeybindingRows } from "../keybindings";
import { theme } from "../theme";

export function HelpOverlay() {
  const rows = allKeybindingRows();
  return (
    <box
      title=" Keybindings "
      borderStyle="double"
      border
      borderColor={theme.borderFocused}
      titleColor={theme.borderFocused}
      style={{
        position: "absolute",
        left: 4,
        top: 1,
        right: 4,
        bottom: 2,
        flexDirection: "column",
        padding: 1,
        backgroundColor: theme.bg,
      }}
    >
      {rows.map((row) => (
        <text key={`${row.scope}:${row.keys}`}>
          <span fg={theme.accent}>{row.keys.padEnd(22, " ")}</span>
          <span fg={theme.text}>{row.description.padEnd(42, " ")}</span>
          <span fg={theme.dim}>{row.scope}</span>
        </text>
      ))}
      <text fg={theme.dim}>Esc or ? closes</text>
    </box>
  );
}
