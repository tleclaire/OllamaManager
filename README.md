# OllamaManager

OllamaManager is a keyboard-driven terminal UI (TUI) for monitoring and managing a local Ollama instance. One screen combines three persistent panes — Models, Stats, and Logs — with a chat pane to their right and toggle views for model details and pulling models. It talks to the Ollama HTTP API on `127.0.0.1:11434`, streams the `ollama` systemd unit's journal, and reads GPU and process metrics beyond what the Ollama API exposes.

## Features

- Model management: list installed models, inspect details (parameters, template, modelfile, capabilities), delete, copy, and unload running models
- Model pull with live progress bars and instant abort
- Realtime log streaming from the `ollama` systemd unit (`journalctl -u ollama -f -o json`)
- Realtime stats: tokens/s and time-to-first-token from the Ollama API, GPU utilization/memory/temperature via `nvidia-smi`, CPU/RAM of the server process via `/proc/<pid>`
- Chat pane to the right of the main panes (Stats and Logs keep streaming while you chat), with streaming output and a one-key preset benchmark run that records TTFT and tok/s
- Running-model overview (`GET /api/ps`) with 5 s polling
- Help overlay (`?`) generated from the same keymap table the app uses — no drift between help and behavior
- Graceful degradation: every external integration (API, journal, GPU, process stats) is optional or self-healing, and its status is always visible in the UI

## Requirements

- Linux (uses `journalctl`, `/proc`, and `nvidia-smi`)
- [Bun](https://bun.sh) >= 1.4
- A running Ollama system service with its API on `http://127.0.0.1:11434` (localhost-only by design; no auth involved)
- Your user in the `adm` group, so `journalctl -u ollama` works without root (optional — without it, the Logs pane shows a banner and the rest of the app works)
- `nvidia-smi` on `PATH` for GPU stats (optional — without it, the GPU section shows "not available"; CPU/RAM stats are unaffected)
- Readable `/proc/<pid>` for the `ollama` server process (optional — without it, process stats show n/a)

## Installation

```bash
git clone <your-fork-url> OllamaManager
cd OllamaManager
bun install
```

If Bun is not installed yet:

```bash
curl -fsSL https://bun.sh/install | bash
```

## Usage

Start the TUI:

```bash
bun run src/index.tsx
```

Or with file watching during development:

```bash
bun run dev
```

Press `?` inside the app for the built-in help overlay.

### Keybindings

Global:

| Key | Action | Scope |
| --- | --- | --- |
| `1` / `2` / `3` | Focus Models / Stats / Logs pane | main |
| `Tab` / `Shift+Tab` | Cycle pane focus | main |
| `Enter` | Model details for selection | main, models focused |
| `m` | Model actions (details/delete/copy/unload) | main, models focused |
| `p` | Pull view (download a model) | main |
| `c` | Toggle chat pane (right column) | main |
| `r` | Refresh models + running now | main |
| `?` | Toggle help overlay | any |
| `q` | Quit | any |
| `Ctrl+C` | Quit | any |
| `Esc` | Back to main / dismiss overlay | non-main |

Pane-local:

| Key | Action | Pane |
| --- | --- | --- |
| `↑` / `↓` or `j` / `k` | Move selection | Models |
| `d` | Delete selected model (confirm) | Models |
| `u` | Unload selected running model | Models |
| `y` | Copy model (prompt for destination) | Models |
| `↑` / `↓` `PgUp` / `PgDn` | Scroll | Logs |
| `g` / `End` | Jump to bottom (re-stick) | Logs |

View-local:

| Key | Action | View |
| --- | --- | --- |
| `Enter` | Send prompt / start pull / refocus input | Chat / Pull |
| `a` | Abort stream / pull | Chat / Pull (input not focused) |
| `b` | Run preset benchmark prompt | Chat (input not focused) |
| `Esc` | Blur input; again closes chat pane / leaves view | Chat / Pull / Details |

### Behavior notes

- Poll cadences: GPU and process stats every 2 s, model list (`/api/tags`) and running models (`/api/ps`) every 5 s.
- The layout targets a terminal of roughly 120x40 characters; smaller terminals will truncate panes.
- Finished pulls stay visible for 30 s, then are pruned from the pull view.

## Troubleshooting

- **Logs pane says "permission denied"** — `journalctl -u ollama` needs `adm` group membership. Run `sudo usermod -aG adm $USER`, then log out and back in (group changes need a new session).
- **StatusBar shows the API as down / connection refused** — the Ollama service is not running or not listening on `127.0.0.1:11434`. Check with `systemctl status ollama` and start it with `sudo systemctl start ollama`. The TUI keeps polling and recovers automatically once the API is back.
- **No GPU stats** — `nvidia-smi` is missing or not on `PATH`. Verify it works standalone (`nvidia-smi` in a shell). Without it the GPU section shows "not available"; everything else keeps working.
- **Blank or broken layout** — the terminal is too small. Resize to at least ~120 columns by ~40 rows.
- **Pull or chat stream won't stop** — abort (`a`) only works while the text input is not focused. Press `Esc` first to blur the input, then `a`.
- **Something fails inside the TUI** — OllamaManager does not write its own log file. Errors surface as in-app banners (Logs pane for journal issues, StatusBar status dots for the API, inline messages on pull rows). If the app itself crashes, the error is printed to the terminal on exit.

## Architecture

OllamaManager is a Bun + TypeScript application built on `@opentui/react` (React 19 for the terminal). It follows a strict layered design: pure utilities in `src/lib/`, all external I/O in `src/services/` (Ollama HTTP client, journalctl child process, GPU and process-stats pollers), application state in `src/stores/`, and a thin React UI in `src/ui/`. A composition root (`src/runtime.ts`) instantiates services and stores and injects dependencies; the dependency rule is `ui → stores ← services`, with unidirectional state flow. Memory is bounded everywhere via ring buffers and capped metric series, and every external integration degrades gracefully with visible status.

Full design documentation, including component details and decision records: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Development

```bash
bun test              # run the test suite
bun run typecheck     # TypeScript check (tsc --noEmit)
bun run dev           # start the TUI with file watching
```

## License

TBD
