# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local coding agent that has **no LLM API client**. Inference happens by driving a real
browser tab: the Node server sends a prompt over WebSocket to a Chrome extension, a content
script types it into gemini.google.com / chatgpt.com / claude.ai, scrapes the streamed reply,
and sends the text back. Every architectural oddity below follows from that.

npm workspaces: `server/` (brain + CLI UI), `extension/` (MV3 bridge), plus a standalone
`vscode-companion/` (not a workspace).

## Commands

```bash
npm install                       # installs both workspaces from the root
npm run start                     # server with workspace pinned to repo root (../)
npm run dev                       # same, with tsx --watch
cd server && npm start -- --workspace /path/to/project   # run against another project
npm link --workspace=server       # exposes the `gemini-agent` bin globally

npm run build --workspace=extension   # esbuild src/background/main.js -> service-worker.js
cd vscode-companion && vsce package --allow-missing-repository --skip-license
```

`extension/service-worker.js` is a **committed build artifact**. Editing anything under
`extension/src/background/` without re-running the build ships stale code — Chrome loads the
bundle, not the sources. `extension/content-scripts/*.js` are loaded directly and are not bundled.
Likewise `vscode-companion/*.vsix` is committed and must be repackaged after editing
`vscode-companion/extension.js`.

### Tests

```bash
npm test                                          # -> server: node --test "src/**/*.test.js"
node --test server/src/core/risk-classifier.test.js   # single file
```

**Never use `node --test src/`** — given a directory, Node 22 runs *every* `.js` file under it
as a test, including `main.js`, which starts the WebSocket server and hangs forever. The quoted
glob is what makes the script work under `sh` (which has no globstar and would otherwise silently
skip `src/core/risk-classifier.test.js`).

**Expected state: all tests pass.** They used to be 34/10/24 red: the tests described designs
the code had replaced — `plan-generator` writes one file per comment under `PR-<n>/` rather than
one `PR-<n>.md` per PR, and `comment-classifier` stopped categorising by keyword once the AI
took that over. Both test files were rewritten against the shipped behaviour, so a failure now is
a real regression.

There is no lint script; `.eslintrc.json` (eslint:recommended) and `.prettierrc`
(100 cols, single quotes, trailing commas) exist for editor integration.

## Layout

```
server/src/
├── index.js          # bin shim: re-spawns main.js under tsx (sources contain JSX)
├── main.js           # arg parsing, migration, component wiring, bootstrap
├── core/             # agent-loop, prompt-builder, diff-engine, risk-classifier,
│                     # task-manager, paths, migrate
├── bridge/           # websocket-server (the Chrome-extension transport)
├── context/          # RAG + token budget: workspace-indexer, ast-chunker,
│                     # code-minifier, token-counter, context-manager, memory-manager
├── github/           # PR agent: poller, comment-classifier, ci-log-parser, plan-generator
├── mcp/              # mcp-server.js + tools/
├── skills/  storage/  watcher/
└── ui/               # App.jsx (Ink/React), cli-ui.jsx
```

Modules are kebab-case; React components keep PascalCase (`ui/App.jsx`). Tests are colocated
as `*.test.js` beside their subject.

## Architecture

### Turn lifecycle

`main.js` wires everything and hands off to `ui/cli-ui.jsx` → `ui/App.jsx`.

1. `App.jsx` sends user input to `AgentLoop.handleUserMessage` (`core/agent-loop.js`).
2. `PromptBuilder.buildPrompt` (`core/prompt-builder.js`) assembles the prompt.
3. `AgentLoop._sendToGemini` pushes onto `extensionQueue` and calls `callbacks.injectPrompt`;
   `bridge/websocket-server.js` relays it to the extension. The queue is serialized by
   `isExtensionBusy` — one browser tab, one in-flight prompt.
4. The content script streams back `gemini_response_stream` (rendered live) then
   `gemini_response`, which resolves `AgentLoop.handleGeminiResponse`.
5. `_extractToolCalls` parses JSON tool calls out of the reply text (there is no structured
   tool-call API — this is text parsing, hence `_cleanJsonString`), then `_executeToolCalls`
   dispatches through `MCPServer.executeTool`.
6. Results are fed back via `buildToolResultPrompt` and the loop repeats.

### Prompt economics

`PromptBuilder` sends the **full system prompt + tool definitions only on turn 0 and every
Nth turn** (`resetPromptState` after `/compact` or `/clear`). This is not an optimization —
resending a large system prompt every turn trips Gemini's repetition/safety
filters and A/B-test modals. Prompt content is also tiered by `modelTier`
(`flash` / `flash-thinking` / `pro`) via `_getReasoningInstructions`.

### Tools

`mcp/mcp-server.js` holds a flat `TOOL_DEFINITIONS` array (name, description, parameters,
handler) with handlers in `mcp/tools/`. To add a tool: write the handler, add one entry to that
array — the schema is what `PromptBuilder` renders into the prompt, so the description *is* the
contract. `executeTool` retries transient OS errors (EBUSY/EACCES/EAGAIN/EMFILE/EPERM) with
backoff and rewrites `errno` codes into LLM-readable instructions.

### Approval path

Writes never go straight to disk. `edit_file` / `create_file` produce a `DiffEngine`
(`core/diff-engine.js`) diff with per-hunk accept/reject, backups, atomic writes, and `undo()`.
Commands pass through `core/risk-classifier.js`, which decides whether `App.jsx` must prompt;
persistent allow/block rules live in `commandRules`  (`/allowlist`).

### Subagents

`AgentLoop.topology` is `single` | `duo` | `swarm`. `ask_reviewer` / `ask_reasoner` /
`ask_researcher` / `ask_subagent` run **in parallel** (see the `isParallel` list in
`_executeToolCalls`), each routed by `modelConfig[role]` to a *different browser tab*.
`_runSubAgentSession` gives subagents a restricted tool set.

### Context engine

`context/` — `workspace-indexer` (structural map via `madge` + acorn), `ast-chunker` (acorn),
`code-minifier`, `token-counter`, `context-manager`, `memory-manager`.
`watcher/file-watcher.js` (chokidar) invalidates context on external edits. `semantic_search`
is backed by a local TF-IDF index.

### GitHub agent

`github/` polls PRs (`github-poller`), classifies comments (`comment-classifier`), parses CI
logs (`ci-log-parser`), and writes plans via `plan-generator`.

## State and config

**All workspace state lives under `.agent/`. Never hardcode that path — import
`server/src/core/paths.js`,** which is the single source of truth and the reason the layout
can't drift again.

| Path | Contents |
| --- | --- |
| `<ws>/.agent/config.json` | topology, `modelConfig`, `commandRules`, `agentName`, GitHub token |
| `<ws>/.agent/artifacts/` | `task.md`, `plan.md`, `walkthrough.md` — written for the user to read |
| `<ws>/.agent/state/` | `editor.json` (VS Code companion), `github.json`, `plan-approval.json` |
| `<ws>/.agent/github-pr-plans/` | GitHub PR agent output |
| `<ws>/.agent/backups/`, `context/`, `logs/`, `tmp/`, `rules.md`, `mistakes.md` | see `paths.js` |
| `<ws>/.agent/sessions/history.jsonl` | conversation history, local copy |
| `~/.agent/workspaces/<name>-<hash>/history.jsonl` | the durable copy of the same history |

**Session history is written to both copies on every turn** (`storage/session-store.js`). The
workspace copy sits next to the code; the home copy survives a clean checkout or a wiped
`.agent/`. On startup the two are reconciled — more turns wins, the other is rebuilt from it.

`GEMINI_AGENT_HOME` (or `AGENT_HOME`) overrides the home dir, which is `~/.agent`. It is
deliberately **not** `~/.gemini`: that belongs to Google's Gemini CLI and Antigravity, which
really do keep data there.

`core/migrate.js` folds the pre-`.agent` layout (`.gemini/`, `.gemini-agent/`, `~/.gemini-agent/`,
`.agent-github-plans/`, root `setAgentName.json` / `agent.log`) into `.agent/` on startup. It
runs only when `.agent/` is absent, moves rather than copies, and is a no-op on the second run.

`vscode-companion/extension.js` duplicates the `.agent` constant — it cannot import from
`server/`. Changing `AGENT_DIR` in `paths.js` means changing it there too, then repackaging
the `.vsix`.

## Product decisions

Standing constraints on this project (previously kept in LEARNINGS.md). These are choices,
not limitations to route around:

- **Gemini Web only, for now** — other bridges exist (`chatgpt-bridge.js`, `claude-bridge.js`)
  and work for subagents, but Gemini is the primary target.
- **Purely local** — no hosted backend, no telemetry, no API keys. Inference happens in the
  user's own browser session, which is the whole point of the extension bridge.
- **Two front-ends** — the terminal CLI and the Chrome side panel are both supported surfaces.
- **One answer per turn** — never emit drafts or A/B alternatives for the user to pick between.

## Gotchas

- **`server/src/index.js` is the bin and does nothing but re-spawn `main.js` under `tsx`** —
  the sources contain JSX, so plain `node src/main.js` fails.
- `App.jsx` is ~1900 lines and performance-sensitive: it avoids re-rendering during streaming
  to prevent terminal tearing, and uses raw ANSI (`\x1b[1m`) in places because
  `marked-terminal` mangles inline markdown inside list items. Splitting it is a real project —
  the two most recent UI commits were both scroll-glitch fixes.
- Running the CLI without a TTY fails with Ink's "Raw mode is not supported". That is the
  harness, not a bug — use `script -q /dev/null <cmd>` to test under a pty.
- Content-script DOM selectors break when the chat sites change; `extractLatestResponse` must
  wait for a *new* block before scraping. Gemini's editor only ingests text via a synthetic
  `ClipboardEvent('paste')` — setting `innerHTML` breaks it (`LEARNINGS.md`).
- `AGENT.md` at the repo root is *workspace* context read by `prompt-builder.js`, not
  instructions for you. It belongs to whatever project the agent is pointed at.
- The agent defaults to `--workspace ../`, so running it here makes it operate on its own repo.
  That is why this repo kept accumulating agent state.
