# AGENT.md — Agent CLI

A local coding agent with **no LLM API client**. Inference happens by driving a
real browser tab: the Node server sends a prompt over WebSocket to a Chrome
extension, a content script types it into gemini.google.com, scrapes the
streamed reply, and sends the text back. Most of what looks odd here follows
from that one constraint — including `core/agent-loop.js` parsing tool calls out
of *reply text*, because there is no structured tool-call API to use.

npm workspaces: `server/` (agent loop + terminal UI), `extension/` (MV3 bridge),
plus a standalone `vscode-companion/`.

## Before you touch anything

- **`extension/service-worker.js` is a committed build artifact.** Editing
  `extension/src/background/` without running
  `npm run build --workspace=extension` ships stale code — Chrome loads the
  bundle, not the sources. `extension/content-scripts/*.js` are loaded directly
  and are *not* bundled.
- **Never commit or push to `main`.** Work lands on a branch and merges by PR.
- **All workspace state lives under `.agent/`.** Never hardcode that path —
  import `server/src/core/paths.js`, which is the single source of truth.
- `server/src/index.js` is the bin and only re-spawns `main.js` under `tsx`; the
  sources contain JSX, so plain `node src/main.js` fails.

## Commands

```bash
npm install                          # both workspaces, from the root
npm run start                        # server, workspace pinned to ../
npm test                             # server (node --test) + extension
node --test server/test/core/paths.test.js        # one file
npm run build --workspace=extension  # rebuild the service worker
```

Tests live in `server/test/`, mirroring `server/src/` directory for directory —
`src/core/paths.js` is tested by `test/core/paths.test.js`. **Expected state:
everything passes**, so a failure is a real regression. No lint script;
`.eslintrc.json` and `.prettierrc` (100 cols, single quotes) are for editors.

## Layout

```
server/src/
├── main.js           # arg parsing, wiring, bootstrap
├── core/             # agent-loop, prompt-builder, diff-engine, risk-classifier,
│                     #   paths, migrate, workspaces, slash-commands, effort
├── bridge/           # the Chrome-extension transport
├── context/          # token budget: minifier, counter, context, memory
├── github/           # PR agent: poller, classifier, ci-log-parser, plan-generator
├── mcp/              # mcp-server.js + tools/
└── ui/               # the terminal front-end (App.jsx, hooks/, components/)
```

Modules are kebab-case; React components keep PascalCase. To add a tool: write
the handler in `mcp/tools/`, add one entry to `TOOL_DEFINITIONS` in
`mcp/mcp-server.js` — that schema is what gets rendered into the prompt, so
**the description is the contract**.

## Things that are the way they are on purpose

- **Writes never go straight to disk.** `edit_file` / `create_file` produce a
  `DiffEngine` diff with per-hunk accept/reject, backups and `undo()`. Commands
  pass through `core/risk-classifier.js`, which classifies *every* segment of a
  shell line, not just the first word.
- **The live frame must never outgrow the viewport** (`server/src/ui/`). When
  Ink's dynamic output is taller than the terminal it clears the screen and
  repaints on *every* render, deleting the user's scrollback and selection
  several times a second. Settled turns go to `<Static>`; only the in-flight
  turn is live; every live row is bounded. An unbounded row in the live region
  brings the whole thing back.
- **No mouse tracking, ever.** A terminal that is tracking suppresses native
  scroll and drag-select. Anything that would be clickable is a keybinding.
- **One answer per turn** — never drafts or A/B alternatives to choose between.

`CLAUDE.md` carries the reasoning behind each of these — read it when you need
to know *why*, not just *what*.
