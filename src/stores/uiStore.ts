/**
 * UI-layer state: view switch, pane focus, text-capture routing flag,
 * plus the small dialog descriptors rendered as overlays (§4.8).
 * Pure state — no external I/O — so the global key handler can route safely.
 */
import { StoreBase } from "./base";

export type ViewName = "main" | "details" | "pull";
export type FocusPane = "models" | "stats" | "logs";

export type ConfirmAction =
  | { kind: "deleteModel"; model: string }
  | { kind: "copyModel"; source: string; destination: string }
  | { kind: "unloadModel"; model: string };

export type ConfirmRequest = {
  title: string;
  message: string;
  confirmLabel: string;
  action: ConfirmAction;
};

export type InputPromptRequest = {
  title: string;
  placeholder: string;
  onSubmit: (value: string) => void;
  onCancel?: () => void;
};

export type UiState = {
  view: ViewName;
  /** Chat lives as a pane right of the main panes (open while view === "main"). */
  chatOpen: boolean;
  focusPane: FocusPane;
  /** True while an <input> owns the keyboard — global hotkeys suppressed. */
  textCapture: boolean;
  helpOpen: boolean;
  detailsModel: string | null;
  confirm: ConfirmRequest | null;
  inputPrompt: InputPromptRequest | null;
  /** Model shown in the `m` actions menu (null = closed). */
  actionMenu: string | null;
};

const PANE_ORDER: FocusPane[] = ["models", "stats", "logs"];

const INITIAL_STATE: UiState = {
  view: "main",
  chatOpen: false,
  focusPane: "models",
  textCapture: false,
  helpOpen: false,
  detailsModel: null,
  confirm: null,
  inputPrompt: null,
  actionMenu: null,
};

export class UiStore extends StoreBase<UiState> {
  constructor() {
    super(INITIAL_STATE);
  }

  setView(view: ViewName): void {
    this.update({ view, textCapture: false });
  }

  openDetails(model: string): void {
    this.update({ view: "details", detailsModel: model, textCapture: false });
  }

  openChat(): void {
    this.update({ view: "main", chatOpen: true, textCapture: true });
  }

  closeChat(): void {
    this.update({ chatOpen: false, textCapture: false });
  }

  openPull(): void {
    this.update({ view: "pull", textCapture: false });
  }

  backToMain(): void {
    this.update({ view: "main", textCapture: false });
  }

  setFocusPane(pane: FocusPane): void {
    this.update({ focusPane: pane });
  }

  /** Cycle pane focus; shift reverses (Tab / Shift+Tab). */
  cyclePaneFocus(backward = false): void {
    const current = PANE_ORDER.indexOf(this.snapshot.focusPane);
    const next = (current + (backward ? PANE_ORDER.length - 1 : 1)) % PANE_ORDER.length;
    this.update({ focusPane: PANE_ORDER[next] as FocusPane });
  }

  setTextCapture(capture: boolean): void {
    if (this.snapshot.textCapture !== capture) this.update({ textCapture: capture });
  }

  toggleHelp(): void {
    this.update({ helpOpen: !this.snapshot.helpOpen });
  }

  setHelpOpen(open: boolean): void {
    this.update({ helpOpen: open });
  }

  requestConfirm(request: ConfirmRequest): void {
    this.update({ confirm: request });
  }

  dismissConfirm(): void {
    this.update({ confirm: null });
  }

  requestInputPrompt(request: InputPromptRequest): void {
    this.update({ inputPrompt: request });
  }

  dismissInputPrompt(): void {
    this.update({ inputPrompt: null });
  }

  openActionMenu(model: string): void {
    this.update({ actionMenu: model });
  }

  closeActionMenu(): void {
    this.update({ actionMenu: null });
  }
}
