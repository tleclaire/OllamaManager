/**
 * App shell (§4.8): view switch (main | chat | details | pull), the SINGLE
 * global useKeyboard handler, focus-pane routing, runtime lifecycle, and
 * overlays (help, confirm, input prompt, action menu).
 *
 * Key-routing contract (verified against @opentui/core 0.5.11 source):
 * InternalKeyHandler delivers keypress to GLOBAL listeners first; a global
 * handler's preventDefault() stops focused-renderable handling. Therefore:
 *  - keys the app handles  → preventDefault() (no double-handling by select/input)
 *  - keys meant for typing → no preventDefault() → focused input receives them
 *  - uiStore.textCapture   → everything except Esc is forwarded to the input
 */
import { useEffect, useRef } from "react";
import { useKeyboard, useRenderer } from "@opentui/react";
import { useStore } from "../hooks/useStore";
import type { Runtime } from "../runtime";
import { theme } from "./theme";
import { StatusBar } from "./StatusBar";
import { ModelsPane } from "./panes/ModelsPane";
import { StatsPane } from "./panes/StatsPane";
import { LogsPane } from "./panes/LogsPane";
import { PullView } from "./views/PullView";
import { DetailsView } from "./views/DetailsView";
import { ChatView } from "./views/ChatView";
import { HelpOverlay } from "./views/HelpOverlay";
import { ActionMenuDialog, ConfirmDialog, InputPromptDialog } from "./views/ConfirmDialog";

export function App({ runtime }: { runtime: Runtime }) {
  const { stores } = runtime;
  const { ui, models, logs, stats, pull, chat } = stores;

  const view = useStore(ui, (s) => s.view);
  const focusPane = useStore(ui, (s) => s.focusPane);
  const helpOpen = useStore(ui, (s) => s.helpOpen);
  const confirmOpen = useStore(ui, (s) => s.confirm !== null);
  const inputPromptOpen = useStore(ui, (s) => s.inputPrompt !== null);
  const actionMenuOpen = useStore(ui, (s) => s.actionMenu !== null);

  const renderer = useRenderer();
  const logsScrollRef = useRef<{
    scrollBy(d: number | { y?: number }): void;
    scrollTo(pos: number | { y?: number }): void;
    stickyScroll: boolean;
  } | null>(null);

  // Runtime lifecycle: boot services/stores once; teardown on unmount (§4.7).
  useEffect(() => {
    runtime.start();
    return () => runtime.stop();
  }, [runtime]);

  useKeyboard((key) => {
    const state = ui.getSnapshot();

    // 1. Confirm dialog owns the keyboard entirely.
    if (state.confirm) {
      key.preventDefault();
      const action = state.confirm.action;
      if (key.name === "y" || key.name === "return") {
        ui.dismissConfirm();
        runConfirmAction(models, action);
      } else if (key.name === "n" || key.name === "escape" || key.name === "q") {
        ui.dismissConfirm();
      }
      return;
    }

    // 2. Input prompt (copy destination): typing flows to the input; Esc cancels.
    if (state.inputPrompt) {
      if (key.name === "escape") {
        key.preventDefault();
        const request = state.inputPrompt;
        ui.dismissInputPrompt();
        request.onCancel?.();
      }
      return;
    }

    // 3. Action menu: select handles arrows/Enter natively; Esc closes.
    if (state.actionMenu) {
      if (key.name === "escape") {
        key.preventDefault();
        ui.closeActionMenu();
      }
      return;
    }

    // 4. Help overlay: any-view toggle.
    if (state.helpOpen) {
      key.preventDefault();
      if (key.name === "escape" || key.name === "?") ui.setHelpOpen(false);
      return;
    }

    // 5. Text capture (chat/pull input focused): global hotkeys suppressed;
    //    Escape blurs the input first, a second Escape leaves the view (§5).
    if (state.textCapture) {
      if (key.name === "escape") {
        key.preventDefault();
        ui.setTextCapture(false);
      }
      return;
    }

    // 6. Global keys (main + view-local, input not focused).
    switch (key.name) {
      case "q":
        key.preventDefault();
        renderer.destroy(); // clean quit (§4.8)
        return;
      case "?":
        key.preventDefault();
        ui.setHelpOpen(true);
        return;
      case "escape":
        if (state.view !== "main") {
          key.preventDefault();
          ui.backToMain();
        }
        return;
      case "c":
        key.preventDefault();
        if (state.view === "chat") ui.backToMain();
        else {
          chat.setModel(models.getSnapshot().selected);
          ui.openChat();
        }
        return;
      case "r":
        key.preventDefault();
        void models.refreshTags();
        void models.refreshRunning();
        return;
      case "a":
        if (state.view === "chat") {
          key.preventDefault();
          chat.abort();
        } else if (state.view === "pull") {
          key.preventDefault();
          abortNewestPull(pull);
        }
        return;
      case "b":
        if (state.view === "chat") {
          key.preventDefault();
          chat.setModel(models.getSnapshot().selected);
          void chat.runBenchmark();
        }
        return;
      case "return":
        // Refocus the input in chat/pull when it was blurred.
        if ((state.view === "chat" || state.view === "pull") && !state.textCapture) {
          key.preventDefault();
          ui.setTextCapture(true);
        }
        return;
      case "p":
        if (state.view === "main") {
          key.preventDefault();
          ui.openPull();
        }
        return;
      case "tab":
        if (state.view === "main") {
          key.preventDefault();
          ui.cyclePaneFocus(key.shift);
        }
        return;
      default:
        break;
    }

    // Pane-local keys + number focus (main view only).
    if (state.view === "main") {
      if (key.name === "1") {
        ui.setFocusPane("models");
        return;
      }
      if (key.name === "2") {
        ui.setFocusPane("stats");
        return;
      }
      if (key.name === "3") {
        ui.setFocusPane("logs");
        return;
      }

      const modelsFocused = state.focusPane === "models";
      const logsFocused = state.focusPane === "logs";
      const selected = models.getSnapshot().selected;

      if (logsFocused && (key.name === "g" || key.name === "end")) {
        key.preventDefault();
        logsScrollRef.current?.scrollBy(Number.MAX_SAFE_INTEGER);
        if (logsScrollRef.current) logsScrollRef.current.stickyScroll = true;
        return;
      }

      if (modelsFocused && selected) {
        switch (key.name) {
          case "d":
            key.preventDefault();
            ui.requestConfirm({
              title: " Delete model ",
              message: `Delete "${selected}" from disk? This cannot be undone.`,
              confirmLabel: "delete",
              action: { kind: "deleteModel", model: selected },
            });
            return;
          case "y":
            key.preventDefault();
            ui.requestInputPrompt({
              title: " Copy model ",
              placeholder: "destination name, e.g. qwen3.5:9b-backup",
              onSubmit: (destination) => {
                ui.requestConfirm({
                  title: " Copy model ",
                  message: `Copy "${selected}" to "${destination}"? An existing destination is overwritten.`,
                  confirmLabel: "copy",
                  action: { kind: "copyModel", source: selected, destination },
                });
              },
            });
            return;
          case "u":
            key.preventDefault();
            ui.requestConfirm({
              title: " Unload model ",
              message: `Unload "${selected}" from memory now?`,
              confirmLabel: "unload",
              action: { kind: "unloadModel", model: selected },
            });
            return;
          case "m":
            key.preventDefault();
            ui.openActionMenu(selected);
            return;
          case "return":
            key.preventDefault();
            ui.openDetails(selected);
            return;
          default:
            break;
        }
      }
    }
  });

  const mainFocused = (pane: "models" | "stats" | "logs") => view === "main" && focusPane === pane;

  return (
    <box style={{ flexGrow: 1, flexBasis: 0, flexDirection: "column", backgroundColor: theme.bg }}>
      {view === "main" ? (
        // flexBasis: 0 on every flexGrow child is MANDATORY with Yoga: with the
        // default flexBasis "auto", a scrollbox's huge intrinsic content height
        // drives flex-shrink and collapses sibling panes to a single row.
        <box style={{ flexDirection: "column", flexGrow: 1, flexBasis: 0 }}>
          <box style={{ flexDirection: "row", flexGrow: 1, flexBasis: 0 }}>
            <ModelsPane models={models} ui={ui} focused={mainFocused("models")} width="38%" />
            <StatsPane stats={stats} models={models} focused={mainFocused("stats")} flexGrow={1} />
          </box>
          <LogsPane logs={logs} focused={mainFocused("logs")} flexGrow={1} scrollRef={logsScrollRef} />
        </box>
      ) : null}

      {view === "pull" ? <PullView pull={pull} ui={ui} /> : null}
      {view === "details" ? <DetailsView models={models} ui={ui} /> : null}
      {view === "chat" ? <ChatView chat={chat} models={models} ui={ui} /> : null}

      <StatusBar models={models} logs={logs} stats={stats} />

      {helpOpen ? <HelpOverlay /> : null}
      {confirmOpen ? <ConfirmDialog ui={ui} /> : null}
      {inputPromptOpen ? <InputPromptDialog ui={ui} /> : null}
      {actionMenuOpen ? <ActionMenuDialog ui={ui} /> : null}
    </box>
  );
}

/** Map a confirmed action descriptor to store commands (App is the router). */
function runConfirmAction(
  models: Runtime["stores"]["models"],
  action:
    | { kind: "deleteModel"; model: string }
    | { kind: "copyModel"; source: string; destination: string }
    | { kind: "unloadModel"; model: string },
): void {
  switch (action.kind) {
    case "deleteModel":
      void models.remove(action.model);
      break;
    case "copyModel":
      void models.copy(action.source, action.destination);
      break;
    case "unloadModel":
      void models.unload(action.model);
      break;
    default: {
      const exhaustive: never = action;
      void exhaustive;
    }
  }
}

/** Abort the most recently started pull (the natural target of key `a`). */
function abortNewestPull(pull: Runtime["stores"]["pull"]): void {
  const pulls = Object.values(pull.getSnapshot().pulls)
    .filter((p) => !p.done)
    .sort((a, b) => b.startedAt - a.startedAt);
  const newest = pulls[0];
  if (newest) pull.abort(newest.model);
}
