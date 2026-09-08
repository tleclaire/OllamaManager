/**
 * Color constants only (§8). Tokyo-Night-inspired, 256-color-safe hex values.
 * Status → color mapping lives here too so all panes stay consistent.
 */
export const theme = {
  bg: "#1a1b26",
  border: "#3b4261",
  borderFocused: "#e0af68",
  text: "#c0caf5",
  dim: "#565f89",
  accent: "#7aa2f7",
  ok: "#9ece6a",
  warn: "#e0af68",
  err: "#f7768e",
  selection: "#33467c",
} as const;

export function statusColor(status: string): string {
  switch (status) {
    case "ok":
    case "live":
    case "running":
      return theme.ok;
    case "checking":
    case "starting":
    case "restarting":
    case "idle":
      return theme.warn;
    case "down":
    case "unavailable":
    case "error":
      return theme.err;
    default:
      return theme.dim;
  }
}

/** Focused vs unfocused border/title colors for panes. */
export function paneBorder(focused: boolean): { borderColor: string; titleColor: string } {
  return {
    borderColor: focused ? theme.borderFocused : theme.border,
    titleColor: focused ? theme.borderFocused : theme.dim,
  };
}
