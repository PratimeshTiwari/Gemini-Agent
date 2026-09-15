# Agent CLI Companion

A small VS Code extension that lets the CLI agent see what you are looking at, and lets
you review its plans where you review everything else.

It is **not** a chat panel. The agent lives in your terminal; this is the half of the
conversation your editor already knows about.

## What it does

| | |
| --- | --- |
| **Add to Agent Chat** | Send the selection to the agent's prompt as `@file.js:12-30`. `cmd+alt+l`, the editor context menu, the editor title bar, or the line-number gutter. |
| **Editor state** | The active file and cursor position, so `get_editor_state` can answer "what am I looking at?". |
| **Diagnostics** | The Problems panel, so `get_diagnostics` can check whether an edit compiled. |
| **Plan review** | Comment on a plan section by section and approve, request changes, or reject — the shape of a PR review, on `implementation_plan.md`. |
| **Terminal failures** | Failed commands from terminals **you point at** are offered to the agent's prompt. |

## How it talks to the CLI

Through files under `<workspace>/.agent/state/`, never a socket:

```
editor.json         active file and cursor
diagnostics.json    the Problems panel, debounced 1.5s
chat-queue.jsonl    "Add to Agent Chat" selections, drained by the CLI
terminal.jsonl      failed commands from watched terminals
plan-review.json    comments accumulated while reviewing
plan-approval.json  the submitted verdict
```

Files rather than a socket is what lets the extension queue work **before the CLI is
even running** — a selection you send at 9am is waiting for you when you start the agent
at 11. It also means there is nothing to reconnect and nothing to leak.

The debounce on diagnostics is not politeness: `onDidChangeDiagnostics` fires continuously
while a project indexes, and writing on every event makes the file unreadable.

## Installing

Extensions panel (`Cmd+Shift+X`) → `...` → **Install from VSIX...** → pick the `.vsix` in
this folder. Requires VS Code **1.93.0** or newer, for the terminal shell-integration API.

## Building

```bash
cd vscode-companion
npx vsce package --allow-missing-repository --skip-license
```

The `.vsix` is **committed**, so a change to `extension.js` that is not repackaged ships
nothing. Only the newest build is tracked — git keeps the rest, and two VSIXs side by side
is how someone installs the wrong one.

`extension.js` duplicates the `.agent` directory name because it cannot import from
`server/`. Changing `AGENT_DIR` in `server/src/core/paths.js` means changing it here too.

## Version history

### 1.5.0 — 2026-09-16
**Terminal forwarding became opt-in, per terminal.** Right-click a terminal →
*Agent CLI: Watch This Terminal for Failures*.

*Why:* it forwarded **every** non-zero exit from **every** terminal. Reported from use —
three markers piled into one prompt, one of them a typo the owner had made in their own
shell and already fixed. A failure you already know about, from a command you ran
deliberately, is noise you delete by hand before the prompt is usable. "Offered, not acted
on" was always the design; this is the same idea one level up.

A first failure in an unwatched terminal offers to watch it — **once** per session, with a
button. A feature nobody can find is the same as one that is off; a prompt on every
failure is the nagging that forwarding-everything already was.

### 1.4.0 — 2026-09-11
**Terminal shell integration.** Failed commands — and only their tail — are forwarded to
the CLI, where they wait behind `ctrl+f` rather than typing themselves into your prompt.

Engine moved `^1.80.0` → `^1.93.0`, which is where
`onDidStartTerminalShellExecution` lands.

*Why only failures, and only the tail:* a passing `npm test` is not news, and a full build
log is tens of thousands of characters that would be typed into a browser chat tab
verbatim.

### 1.3.1 — 2026-09-10
**Fix:** the plan-review code lenses did not appear, and a stale review could be answered
after the plan had moved on.

### 1.3.0 — 2026-09-10
**More ways into Add to Agent Chat** — the editor title bar and the line-number gutter,
alongside the context menu and `cmd+alt+l`. One feature, four doors, because the one you
remember is the one you use.

### 1.2.0 — 2026-09-10
The big one. **Diagnostics**, **Add to Agent Chat**, and **PR-style plan review** —
comment on sections, then accept / request changes / reject.

### 1.1.0 — 2026-09-05
State moved under `.agent/`, with the rest of the project. Renamed
`gemini-agent-companion` → `agent-cli-companion` → `cli-agent-companion` as the CLI itself
was renamed away from being Gemini-specific.

### 1.0.0 — 2026-08-23
Active file and cursor position, written to a JSON file on a 500 ms debounce. That was the
whole extension.
