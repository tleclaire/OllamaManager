/**
 * Single source of truth for the keymap (§4.8): keymap table + human-readable
 * help lines rendered by the help overlay. One table prevents keybinding
 * drift between the global handler and the help text.
 */

export interface KeybindingRow {
  keys: string;
  description: string;
  scope: string;
}

export const GLOBAL_KEYS: KeybindingRow[] = [
  { keys: "1 / 2 / 3", description: "Focus Models / Stats / Logs pane", scope: "main" },
  { keys: "Tab / Shift+Tab", description: "Cycle pane focus", scope: "main" },
  { keys: "Enter", description: "Model details for selection", scope: "main, models focused" },
  { keys: "m", description: "Model actions (details/delete/copy/unload)", scope: "main, models focused" },
  { keys: "p", description: "Pull view (download a model)", scope: "main" },
  { keys: "c", description: "Chat / benchmark view", scope: "any" },
  { keys: "r", description: "Refresh models + running now", scope: "main" },
  { keys: "?", description: "Toggle this help overlay", scope: "any" },
  { keys: "q", description: "Quit", scope: "any" },
  { keys: "Ctrl+C", description: "Quit", scope: "any" },
  { keys: "Esc", description: "Back to main / dismiss overlay", scope: "non-main" },
];

export const PANE_KEYS: KeybindingRow[] = [
  { keys: "↑ / ↓ or j / k", description: "Move selection", scope: "Models" },
  { keys: "d", description: "Delete selected model (confirm)", scope: "Models" },
  { keys: "u", description: "Unload selected running model", scope: "Models" },
  { keys: "y", description: "Copy model (prompt for destination)", scope: "Models" },
  { keys: "↑ / ↓ PgUp / PgDn", description: "Scroll", scope: "Logs" },
  { keys: "g / End", description: "Jump to bottom (re-stick)", scope: "Logs" },
];

export const VIEW_KEYS: KeybindingRow[] = [
  { keys: "Enter", description: "Send prompt / start pull / refocus input", scope: "Chat / Pull" },
  { keys: "a", description: "Abort stream / pull", scope: "Chat / Pull (input not focused)" },
  { keys: "b", description: "Run preset benchmark prompt", scope: "Chat (input not focused)" },
  { keys: "Esc", description: "Blur input; press again to leave view", scope: "Chat / Pull / Details" },
];

/** All rows in help-overlay order. */
export function allKeybindingRows(): KeybindingRow[] {
  return [...GLOBAL_KEYS, ...PANE_KEYS, ...VIEW_KEYS];
}

/** One-line hint strip for the status bar. */
export const HINT_LINE =
  "[1-3] panes  Tab cycle  m actions  p pull  c chat  r refresh  ? help  q quit";
