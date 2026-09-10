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
npm link --workspace=server       # exposes the `agent` (and `agent-cli`) bin globally

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
│                     # task-manager, paths, migrate, workspaces
├── bridge/           # websocket-server (the Chrome-extension transport)
├── context/          # RAG + token budget: workspace-indexer, code-minifier,
│                     # token-counter, context-manager, memory-manager
├── github/           # PR agent: poller, comment-classifier, ci-log-parser, plan-generator
├── mcp/              # mcp-server.js + tools/
├── storage/  watcher/
└── ui/               # the terminal front-end
    ├── cli-ui.jsx    # render(): stdin shim, hotkey routing, trailing-Enter split
    ├── App.jsx       # state, effects, layout — everything else is a module
    ├── hotkeys.js    # ctrl+ chords, pulled off stdin before Ink sees them
    ├── enter-splitter.js  # peels a trailing \r off a chunk so Enter is a keypress
    ├── paste.js      # collapses a big paste to a marker; expands it on submit
    ├── format.js  constants.js  transcript.js     # pure, tested
    ├── hooks/        # use-key-bindings, use-hotkeys, use-github-tab,
    │                 #   use-github-keys, use-slash-commands, use-agent-callbacks
    └── components/   # Banner, TranscriptTurn, GithubTab, Menus, InputBar,
                      #   AgentTerminal, QuestionPrompt
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

The **tool anchor** (`_buildToolAnchor`) is the exception that rides on *every* turn: tool
names only, 56 tokens against 1,575 for the definitions. The model does not gradually forget
its tools, it forgets them completely — mid-session it answers "I cannot execute local
commands or access your local file system" with total confidence and the turn is lost. Three
detectors in `core/drift-detector.js` back that up, each with a different response:
`looksLikeMultipleDrafts` → bring the refresh forward; `looksLikeCapabilityDenial` → resend the
full definitions and retry the turn once; `looksLikeProviderError` → Gemini's own error rather
than an answer, so re-ask (this one used to be written to disk as a PR plan). All three match
prose and will always trail the model's phrasing, which is why the anchor exists: prevention
first, detection as the backstop.

### Tools

`mcp/mcp-server.js` holds a flat `TOOL_DEFINITIONS` array (name, description, parameters,
handler) with handlers in `mcp/tools/`. To add a tool: write the handler, add one entry to that
array — the schema is what `PromptBuilder` renders into the prompt, so the description *is* the
contract. `executeTool` retries transient OS errors (EBUSY/EACCES/EAGAIN/EMFILE/EPERM) with
backoff and rewrites `errno` codes into LLM-readable instructions.

### Workspace

`core/workspaces.js` owns path handling for the workspace: `resolveWorkspaceInput` (`~`
expansion, relative paths, quotes), `validateWorkspace` (exists / is a directory / readable) and
`listWorkspaceCandidates` for the `/set-workspace` picker. `AgentLoop.setWorkspace` is the one
place that rewires the collaborators that hold a copy of the path — `/workspace` and
`/agent-dir` each used to carry their own list and had already drifted. SessionStore is
deliberately *not* rebound: doing so would write the current conversation into another
project's history.

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

`context/` — `workspace-indexer` (structural map via `madge`), `code-minifier`,
`token-counter`, `context-manager`, `memory-manager`. `CodeMinifier.minifyJson` is on the hot
path: `PromptBuilder.buildToolResultBatch` embeds every tool result in the next prompt, and
serialising them compact rather than pretty-printed is ~40% fewer characters there.

There is no `ast-chunker` and no `skills/` registry any more. Both were written, never wired to
anything, and removed on 2026-09-10: the chunker resolved 24% of this repo's top-level symbols
(it walked only `ast.body`, so every class method and every `export const foo = () => {}` missed,
and plain acorn cannot parse the `.jsx` files at all), and `SkillRegistry` was a second, parallel
way to declare a tool that competed with `mcp/mcp-server.js`'s `TOOL_DEFINITIONS` — which is the
one described above and the one that actually runs. A per-symbol read tool is still a real gap;
it wants `acorn-walk` plus `acorn-jsx`, not that file.
`watcher/file-watcher.js` (chokidar) invalidates context on external edits. `semantic_search`
is backed by a local TF-IDF index.

### GitHub agent

`github/` polls PRs (`github-poller`), classifies comments (`comment-classifier`), parses CI
logs (`ci-log-parser`), and writes plans via `plan-generator`.

## State and config

**All workspace state lives under `.agent/`. Never hardcode that path — import
`server/src/core/paths.js`,** which is the single source of truth and the reason the layout
can't drift again.

### Where `.agent/` actually is

`workspace` used to mean two things: where state lives, and what the agent works on. In a
monorepo those come apart, so `paths.resolveState(workspace)` walks *up* looking for an
existing `.agent/`, the way git finds `.git`. The first hit is the **root**; the path from it
down to the workspace is the **scope**.

```
/base-repo/.agent/             root — shared by every repo
├── rules.md  skills/  mistakes.md  config.json     inherited
├── repo-1/   artifacts/ state/ sessions/ logs/     this repo only
│             rules.md (appended)  config.json (overrides)
└── repo-2/ …
/base-repo/repo-1/             the code, with no .agent of its own
```

Nothing found — the ordinary single-repo case — and the root is `<workspace>/.agent` with an
empty scope, byte-identical to the old behaviour. Opening `/base-repo` and opening
`/base-repo/repo-1` land on the same state, because both walks end at the same root;
`workspaceSlug` is keyed on the resolved state dir for exactly that reason, so siblings don't
collide on one history file.

Scope is **explicit, never inferred from which files the agent touches**: `--scope repo-1`,
`/scope`, shown in the status bar. Tools stay rooted at the workspace so cross-repo work is
still possible — only state, sessions and config are scoped.

**The landmine:** `homeDir()` is `~/.agent`. A naive upward walk from any project under `$HOME`
finds it and would adopt the global home as a project root, pooling every project's state and
leaking every project's rules into everyone else's prompt. `resolveState` excludes it and stops
walking at `$HOME`; `paths.test.js` covers it.

| Path | Contents |
| --- | --- |
| `<ws>/.agent/config.json` | topology, `modelConfig`, `commandRules`, `agentName`, GitHub token |
| `<ws>/.agent/artifacts/` | `task.md`, `plan.md`, `walkthrough.md` — written for the user to read |
| `<ws>/.agent/state/` | `editor.json` (VS Code companion), `github.json`, `plan-approval.json` |
| `<ws>/.agent/github-pr-plans/` | GitHub PR agent output |
| `<ws>/.agent/logs/errors.jsonl` | structured failure log — one JSON object per line |
| `<ws>/.agent/backups/`, `context/`, `logs/`, `tmp/`, `rules.md`, `mistakes.md` | see `paths.js` |
| `<ws>/.agent/sessions/history.jsonl` | conversation history, local copy |
| `~/.agent/workspaces/<name>-<hash>/history.jsonl` | the durable copy of the same history |

**Session history is written to both copies on every turn** (`storage/session-store.js`). The
workspace copy sits next to the code; the home copy survives a clean checkout or a wiped
`.agent/`. On startup the two are reconciled — more turns wins, the other is rebuilt from it.

`AGENT_CLI_HOME` overrides the home dir, which is `~/.agent`. The pre-rename `GEMINI_AGENT_HOME`
and the older `AGENT_HOME` are still read, because dropping them would silently repoint an
existing install rather than fail. It is
deliberately **not** `~/.gemini`: that belongs to Google's Gemini CLI and Antigravity, which
really do keep data there.

`core/migrate.js` folds the pre-`.agent` layout (`.gemini/`, `.gemini-agent/`, `~/.gemini-agent/`,
`.agent-github-plans/`, root `setAgentName.json` / `agent.log`) into `.agent/` on startup. It
runs only when `.agent/` is absent, moves rather than copies, and is a no-op on the second run.

`vscode-companion/extension.js` duplicates the `.agent` constant — it cannot import from
`server/`. Changing `AGENT_DIR` in `paths.js` means changing it there too, then repackaging
the `.vsix`.

The companion and the CLI talk only through files under `<ws>/.agent/state/`, never a socket:
`editor.json` (active file and cursor), `diagnostics.json` (the Problems panel, debounced 1.5s
because `onDidChangeDiagnostics` fires continuously while a project indexes),
`chat-queue.jsonl` (append-only; "Add to Agent Chat" selections, drained by `ui/chat-queue.js`),
`plan-review.json` (comments accumulated while reviewing) and `plan-approval.json` (the
submitted verdict: `accept` | `changes_requested` | `reject`). Files rather than a socket is
what lets the extension queue work before the CLI is even running.

### Failure logging

`core/error-log.js` writes every failure to `<ws>/.agent/logs/errors.jsonl`, tagged with the
flow it came from (`bridge`, `extension`, `agent`, `tool`, `github`, `task`, `diff`, `context`,
`ui`). `/logs` reads it back grouped by flow; `/logs <flow>` drills in.

It exists because failures here are spread across processes that cannot see each other — a
content script in a Chrome tab, the bridge, the loop, the tools, the poller — and the symptom
surfaces far from the cause. The console was the only sink, and console output inside an Ink
app is destroyed by the next repaint.

Two properties are load-bearing. It **never throws** (every caller is already on a failure
path). And it **collapses repeats**: identical failures inside a 60s window are counted rather
than written, because a poller failing every tick used to bury everything else. The tally is
written as its own record marked `tally: true` when the window closes or the process exits —
so a storm of 500 shows as 500, not 1, and the tally line is never miscounted as another
occurrence.

## Branching and PRs

**Never commit or push to `main` directly. Work lands on a branch and merges through a PR.**

The branches in this repo are deliberate: they are the history. `beta-v1` … `beta-v10`,
`fix/bridge-lock-and-cli`, `v1-stable` are kept on purpose, not left behind. Do not delete
them, and do not squash their history away.

- Branch from `main`, name it for the work (`fix/…`, `feat/…`, or the next `beta-vN`).
- Open a PR into `main`. That is the only way work reaches `main`.
- A force-push to `main` is not a merge and is not covered by this: it is a repair, it needs
  the owner to ask for it explicitly, and it breaks every open PR targeting `main` plus every
  existing clone.

A conflict on a PR that *should* be a clean descendant almost always means the two sides no
longer share history — check `git rev-list --left-right --count main...<branch>` locally
before believing GitHub. If local says `0 <n>` and GitHub says conflicts, the remote branches
have diverged (a rewrite that was pushed to one side and not the other), and the fix is to
make both sides share the same base, not to resolve 120 files by hand.

## Product decisions

Standing constraints on this project (previously kept in LEARNINGS.md). These are choices,
not limitations to route around:

- **Gemini Web only, for now** — other bridges exist (`chatgpt-bridge.js`, `claude-bridge.js`)
  and work for subagents, but Gemini is the primary target.
- **Purely local** — no hosted backend, no telemetry, no API keys. Inference happens in the
  user's own browser session, which is the whole point of the extension bridge.
- **Two front-ends** — the terminal CLI and the Chrome side panel are both supported surfaces.
- **One answer per turn** — never emit drafts or A/B alternatives for the user to pick between.

## Direction

Agreed 2026-09-10, not yet built. Recorded so the reasoning is not re-derived.

**The problem being solved:** seven mechanisms exist for "tell the model about this project"
(`AGENT.md`, `.agent/rules.md`, scoped `rules.md`, `skills/`, `memory.json`, `mistakes.md`,
`contextFolders`) with six different discovery rules between them. The count of *rules* is the
mess, not the count of files.

**The target:** two axes, one mechanism each.

| axis | question | mechanism |
| --- | --- | --- |
| scope | who does this apply to? | **where the file is** — walk up from the code, nearest wins |
| cost | always in context, or on request? | **which file** — `AGENT.md` vs `.agent/skills/` |

Repo-specific knowledge is *not* a skill. A skill's contract is "read me when my description
matches"; repo conventions match *always* when you are in that repo, and encoding "always" as
"when relevant" hands the model a judgement it will sometimes get wrong — after it has already
edited something. The test: *should the agent know this before its first action in this repo?*
Yes → `AGENT.md`. Fine to discover later → skill.

Memory is **scoped and never walked** (`.agent/<scope>/memory.md`), kept separate from
`AGENT.md` so that file can always be trusted to say what the human wrote. Promoting a learned
fact to a standing instruction is a manual edit, deliberately.

| Phase | Change | Removes |
| --- | --- | --- |
| 0 | `codeDir`; `AGENT.md` and skills read from the code location, not the workspace; watcher scoped | — (bug fixes) |
| 1 | Delete `semantic_search` + `workspace-indexer` + `workspace-summarizer` + dead `ContextManager` code | ~290 lines, `madge`, the startup index build |
| 2 | One instruction surface: `AGENT.md`, walked | `rules.md`, `mistakesPath`, `/init-skills`, `contextFolders`, `/context` |
| 3 | Memory as `.agent/<scope>/memory.md`, index-only in the prompt | the write-only trap |
| 4 | One model picker, five valid states, `/reasoning` → `/effort` | `reasoningEffort`, `_effortToTier` |
| 5 | Keep `--scope` and derived resolution; delete the runtime switcher | `/scope`, its picker, `setScope`, the reload path |
| 6 | Per-model extension lock; derive topology from `modelConfig` | `topology` as a knob, `/mode`, the mode menu |

**Why `semantic_search` goes (phase 1).** Measured: its tokenizer splits on non-alphanumerics
only, so `getUserById` is one token and the query `user` can never match it — broken for the
query type that dominates code search. A broken tool is worse than a missing one, because the
model reaches for it and concludes the code is not there. Even repaired it is keyword matching
that `grep_search` already does better, and it costs a full-repo read at every startup. The
madge dependency graph dies with it: it is read only inside `search()`.

**Why subagents stay but change (phase 6).** `isParallel` fans the `ask_*` calls out with
`Promise.all`, but every one queues behind a single global `isExtensionBusy` lock, so they run
strictly one at a time — the concurrency is in the JavaScript and nowhere else. Worse, the
extension addresses tabs by URL pattern rather than identity, so two concurrent *same-model*
requests race for one tab and can interleave two prompts into one conversation. Cross-model
review is genuinely valuable and is the reason three bridges exist; same-model review is not.
A per-model lock makes the first real, and deriving topology from `modelConfig` makes the
second unrepresentable instead of silently broken. Multiple tabs of the *same* model are out of
scope: it needs tab identity threaded through the whole bridge, to buy something a second model
already provides.

## Gotchas

- **`server/src/index.js` is the bin and does nothing but re-spawn `main.js` under `tsx`** —
  the sources contain JSX, so plain `node src/main.js` fails.
- `App.jsx` is performance-sensitive: it avoids re-rendering during streaming to prevent
  terminal tearing, and uses raw ANSI (`\x1b[1m`) in places because `marked-terminal` mangles
  inline markdown inside list items. It was split into `ui/` modules by moving blocks verbatim
  behind explicit dependency lists; the `<Static>` element, `staticEpoch` and the streaming
  path stayed in `App.jsx` deliberately, and adding memoization to the transcript rows is how
  the scroll glitches came back the last two times.
- **The live frame must never outgrow the viewport.** This is the single most important rule in
  `ui/`. When Ink's dynamic output is taller than the terminal, `shouldClearTerminalForFrame`
  (`ink/build/ink.js`) switches it to writing `ESC[2J ESC[3J` plus a full repaint on *every*
  render. Measured on the pre-fix code, sitting idle with a 12-turn history in a 24-row
  terminal: 108 full clears and 108 scrollback wipes in 15 seconds, 3.85 MB of escape codes.
  That is what "it flickers and I can't scroll or copy" was — the terminal's scrollback and the
  user's selection were being deleted seven times a second. The same shape is now 36 KB and
  zero clears. So: settled turns go to `<Static>`, only the in-flight turn is live, and every
  live row is bounded by `liveBudget` (`terminalHeight - RESERVED_ROWS`). Adding an unbounded
  row to the live region — a full tool result, an artifact dump, a list that grows — brings the
  whole thing back.
- **No mouse tracking, ever.** Terminal mouse reporting and native scroll are mutually
  exclusive: a terminal that is tracking hands the app the wheel and suppresses drag-select. The
  app therefore enables nothing, and `cli-ui.jsx` writes the disable sequences once on startup
  in case a crashed run left the terminal tracking. Scroll, drag-select and copy are the
  terminal's, exactly as in Claude Code. Everything that used to be clickable is a keybinding.
- **The transcript has no selection model.** `Ctrl+E` toggles verbosity for the *whole*
  transcript rather than one row, because there is nothing to point at a single row with. Ink
  cannot repaint what `<Static>` has committed, so `toggleVerbose` clears the screen and lets
  Static print the transcript again at the new setting — that one clear per keypress is
  deliberate and is the only `ESC[2J` the app writes. ↑/↓ always mean input history.
- **`ink-text-input` types every key it does not recognise.** Its handler special-cases exactly
  one chord, ctrl+c, so a ctrl+e handled in `useKeyBindings` still left a stray `e` in the
  prompt — and ctrl+o, ctrl+t and ctrl+v their letters. Ink offers no way to stop a `useInput`
  handler running, and the text field's is registered first (child effects run before the
  parent's). So the chords never reach Ink at all: `cli-ui.jsx` pulls them out of the stdin
  chunk via `hotkeys.js` and dispatches them through `use-hotkeys.js`. Adding a new ctrl+ binding
  means adding it to `HOTKEYS`, not to `useKeyBindings`.
- **A paste is folded to a marker, not typed into the prompt.** `usePaste` (Ink 7) turns on
  bracketed paste, which is the only thing that distinguishes "pasted forty lines" from "typed
  forty lines very fast" — and it keeps the text off `useInput` entirely. `paste.js` swaps
  anything over four lines for `[Pasted text #1 +42 lines]` and `App.handleSubmit` expands it on
  the way to the model. This is a frame-budget rule as much as a legibility one: the input box
  is in the live frame, and a pasted file is the easiest way to blow the viewport.
- **Ink never reads the real stdin.** `cli-ui.jsx` pipes `process.stdin` through a PassThrough
  so `enter-splitter.js` can peel a trailing `\r` into a chunk of its own. Ink's input parser
  deliberately does not split `\r` from adjacent text (a CR can sit inside a paste), so when the
  terminal delivers the last typed character and the Enter after it in one read — routine when
  typing fast, over ssh, in tmux, or on key repeat — Ink sees `"i\r"` with `key.return` false,
  `ink-text-input` types the CR into the prompt, and **the message is silently never sent**. The
  second write is deferred with `setImmediate`, because Ink's `read()` drains everything
  buffered and two back-to-back writes would arrive as the one chunk this exists to split.
- Running the CLI without a TTY fails with Ink's "Raw mode is not supported". That is the
  harness, not a bug — use `script -q /dev/null <cmd>` to test under a pty.
- Content-script DOM selectors break when the chat sites change; `extractLatestResponse` must
  wait for a *new* block before scraping. Gemini's editor only ingests text via a synthetic
  `ClipboardEvent('paste')` — setting `innerHTML` breaks it (`LEARNINGS.md`).
- `AGENT.md` at the repo root is *workspace* context read by `prompt-builder.js`, not
  instructions for you. It belongs to whatever project the agent is pointed at.
- The agent defaults to `--workspace ../`, so running it here makes it operate on its own repo.
  That is why this repo kept accumulating agent state.
