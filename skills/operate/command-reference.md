# dassi CLI Command Reference

The full surface of the `dassi` CLI as of the corresponding npm package version. Used by `dassi:operate` for intent → command mapping.

## Agent / orchestration commands

| Command | Required | Optional | Behavior |
|---|---|---|---|
| `dassi run "<prompt>"` | `--tab <id>` OR `--group <id>` OR `--group-title <name>` | `--timeout <ms>` (default 300000), `--session <name>` | Run AI agent. Returns `{ answer, toolCalls, durationMs }`. Group flags fan out sequentially. |
| `dassi list-tabs` | — | `--json` | List open tabs with `{tabId, title, url, active, windowId, groupId, groupTitle, groupColor}`. |
| `dassi list-groups` | — | `--json` | List tab groups across all windows with `{id, title, color, windowId, tabCount}`. |
| `dassi status` | — | — | Check extension install + sign-in. |
| `dassi bug-report` | — | `-o <file>` | Export debug logs JSON. |
| `dassi panel-screenshot` | `--tab <id>` | `-o`, `--width`, `--height` | Capture side panel UI. Single-target only — no `--group`. |
| `dassi raw '<json>'` | one JSON string | — | Send raw command envelope. Escape hatch. |

## Browser tool commands

Each accepts `--tab <id>` OR `--group <id>` OR `--group-title <name>`, except where noted as single-target.

| Command | Args | Notes |
|---|---|---|
| `navigate <url>` | url | Drive tab to URL. |
| `click <ref>` | ref | `<ref>` from `read-page` (e.g. `e3`). |
| `fill <ref> <text>` | ref, text | Instant set-value. |
| `type <ref> <text>` | ref, text | Real keyboard events. |
| `read-page` | — | Accessibility tree. `--filter interactive\|all`, `--depth <n>`. |
| `get-text` | — | Plain extracted text. |
| `screenshot` | — | Viewport PNG. `-o <file>` (auto-uniquified per tab in group fan-out). |
| `eval <code>` | code | Run JS. `--await` to await Promise. |
| `tabs` | — | **Single-target only** (`--tab` required). Lists tabs in same group. |
| `open [url]` | url? | **Single-target only** (`--tab` required). Opens new tab in current group. |
| `close` | — | Close tab. Fans out across a group = close all member tabs. |

## Global options

| Flag | Effect |
|---|---|
| `--session <name>` | Daemon session name (default `default`). Selects which per-session daemon process and Unix socket the CLI connects to. Each distinct `--session` value spawns its own daemon; only one can be running at a time because they all bind the same WebSocket port (see the "Multi-tab dispatch is sequential" note below). |
| `--json` | Raw JSON output (in group fan-out: single JSON array of `{tabId, response}` entries). |
| `--version`, `--help` | Self-explanatory. |

## Important behavioral notes

- **Multi-tab dispatch is sequential.** Daemons share a fixed WebSocket port, so parallel processes can't coexist. Use `--group <id>` (single CLI invocation, FIFO-queued) for group fan-out, or sequential `--tab` calls for ad-hoc selections. The skill layer is responsible for showing progress on long-running sequential dispatch.
- **`--group-title` errors strictly on ambiguity** (>1 group with the same title across windows). The skill layer catches this and re-pickers.
- **`tabs` and `open` reject group flags** because their underlying tools (`tabs_context`, `tabs_create`) are inherently single-target — fanning them out either repeats the same group snapshot or creates N duplicate tabs.
- **Integer flags use strict validation** (`/^-?\d+$/`). `--tab 7abc` errors instead of silently using `7`.
- **`--group-title ""` is rejected** to avoid silently matching untitled groups.
- **Screenshot/output paths in group fan-out** are auto-suffixed per tab (e.g. `shot.png` → `shot-tab42.png`) so each tab gets its own file.
