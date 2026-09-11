# The GitHub PR agent — restructure

Written 2026-09-11. A plan, not a change — nothing here is built.

The owner's instruction, recorded twice in `HANDOFF.md` and once in `CLAUDE.md`:
**restructure, not delete**, and plan it on its own once everything else had
landed. It has, so this is that plan.

**Read `CLAUDE.md` first** for the architecture this sits inside — in particular
`### Prompt economics`, `### Subagents` and phase 6's per-model extension lock,
because the central finding below is about all three.

---

## The one idea

**It is a second agent, built beside the first one rather than on top of it.**

Everything else in this file follows from that sentence. The GitHub agent has
its own agent loop, its own system prompt, its own tool-definition list, its own
prompt assembly, its own retry logic, its own failure log, and its own word for
"plan". Not because any of those decisions was wrong on its own, but because the
feature was written as a parallel system, and a parallel system re-derives
everything — including the things the main loop had already got right, and the
bugs it had already fixed.

The restructure is not a reorganisation of `github/`. It is **making the GitHub
agent a caller of the existing loop instead of a copy of it.** The parts that
are genuinely its own — talking to GitHub, deciding what deserves a turn,
writing the output — are good, tested where it matters, and should barely change.

There is a second half, found while designing it and arguably the more valuable
one: **the browser-tab contention everyone assumed was inherent is not.** The
extension already isolates background work in its own tab. The server throws
that away. See "Lanes are named, not per-model".

---

## Evidence

Measured against the code, file and line. 1,658 lines across seven files.

### 1. `runHeadlessTask` is a second agent loop, and it lives in `agent-loop.js`

`core/agent-loop.js:1362`. Ten turns, its own dispatch, its own retry. Inside it:

- **A third hand-written tool-definition list** (`agent-loop.js:1369–1397`),
  listing five tools in a format of its own. `CLAUDE.md` → P2 already records
  that `_buildToolDefinitions` is "two hand-kept lists that must agree with
  `TOOL_DEFINITIONS`" and that generating them is blocked on five tools being
  declared inside `agent-loop.js`. This is a *third* list nobody counted, with a
  different subset and a different description of the call format.
- **The entire history re-serialised every turn**:
  `localHistory.map(t => …).join('\n\n')` (`agent-loop.js:1409`). Turn ten resends turns one through
  nine in full. This is precisely what `PromptBuilder`'s turn-0-and-every-Nth
  rule exists to avoid, and `CLAUDE.md` is explicit that the reason is not
  economy but *safety*: a large repeated payload trips Gemini's repetition
  filters. The background path opted out of the protection.
- **`_executeSubagent('gemini', …)` hard-coded** (`agent-loop.js:1411`).
  `modelConfig` is ignored, so the GitHub agent always takes the main lane.

### 2. It competes for the browser tab, and nothing on screen says so

The scarcest resource in this whole architecture is one browser tab, serialised
by a per-model lane (phase 6). Per PR comment, the background path can spend up
to **ten round-trips through that lane**, plus more for any `ask_subagent` it
spawns — and `_commentQueue` (`github-event-handler.js:62`) is **unbounded**,
paced only by a 30-second cooldown between completions.

A poll covers up to 50 PRs every 60 seconds and enqueues every comment newer
than its watermark. Twenty comments arriving together is ten minutes of cooldown
alone, before any analysis time. During all of it, a prompt the user types
queues behind work they did not ask for, and the only sign of it is one line on
the GitHub tab naming the comment currently being analysed.

**And the queueing is artificial** — see "Lanes are named, not per-model" below.
The extension already puts background work in its own tab; it is
`ExtensionLock._lane(model)` keying on the model that makes a GitHub turn and a
user prompt share a queue.

**Stopping your own turn stalls it.** `App.jsx:393` (Esc) calls
`abortExtensionWork` → `abortAll`, which clears *every* lane's queue. Background
work already in flight has a pending promise nothing resolves, so it sits on the
five-minute safety timeout (`agent-loop.js:1267`) with `_isProcessingComment`
stuck true the whole time.

### 3. Failures go to a file nothing reads

`github-event-handler.js:258` and `:261` write analysis failures with
`appendFileSync(logPath(…))` — that is `.agent/logs/agent.log`. Grep for
`logPath(`: those two lines write it, `core/migrate.js:123` moves it, and
**nothing reads it.** `/logs` reads `errors.jsonl`.

So the most failure-prone path in the project — an AI turn that depends on a
browser tab staying awake — is the one path whose failures never reach `/logs`.
Every other flow in the app was converted to `error-log.js`; this one was missed
because it is a parallel system with a parallel logger.

### 4. The orchestrator does four jobs and calls itself glue

`github-event-handler.js`, 357 lines, header comment "This is the glue layer":

- **repo detection** — `execSync('git config --get remote.origin.url')`, in the
  constructor (`:44`), overwriting config at `:47`;
- **a work queue** — enqueue, drain, dedup, cooldown, current-analysis tracking
  (`:62–219`);
- **prompt assembly** — a 20-line template literal building the review prompt
  (`:237–252`);
- **event wiring** — the part that actually is glue (`:281–356`).

**A bug falls straight out of the first one.** `resolveGitHubConfig` reads
`GITHUB_REPOS` (`github-config.js:57`), and then the constructor overwrites
`this.config.repos` with the detected origin whenever the workspace is a git
repo with a GitHub remote. `GITHUB_REPOS` is therefore silently ignored in
exactly the case where someone would set it.

### 5. Two-thirds of it has no tests

| file | lines | tests |
| --- | --- | --- |
| `github-poller.js` | 476 | **none** |
| `github-event-handler.js` | 357 | **none** |
| `ci-log-parser.js` | 198 | **none** |
| `github-review-prompt.js` | 133 | none (prose) |
| `github-config.js` | 62 | **none** |
| `plan-generator.js` | 362 | 227 |
| `comment-classifier.js` | 70 | 106 |

**1,093 of the 1,525 lines that are code have no tests, and they are the ones
that do I/O** (the remaining 133 lines are the review prompt's prose). The two
files with tests are the two pure ones. This is the same shape as
`diff-engine.js` before P0 — the untested file was the one that overwrote
files, and writing its tests found a real bug.

### 6. Two different things are called "plans"

- `/plans` → `core/plan-archive.js` → `.agent/artifacts/plans/`
- `/github plans` → `PlanGenerator.listPlans()` → `.agent/github-pr-plans/`

Different directories, different formats, different code, same word. Neither is
ever read back into a prompt.

---

## The decided architecture

Agreed 2026-09-12, after the framing question "on top, or separate?" turned out
to be the wrong axis.

### Why it is messy: there was no seam

`AgentLoop` bundles two unrelated things — **the conversation** (history,
callbacks, the user's turn) and **the machinery** (send a prompt, parse tool
calls, run them, retry, feed the results back). The GitHub agent needed the
second and could not have it without the first, so it copied it. Every duplicate
in the evidence above is a symptom of that one missing layer.

The real duplication is narrower than it looks: `runHeadlessTask` already shares
`_extractToolCalls`, `mcpServer.executeTool`, `riskClassifier` and
`_executeSubagent`. What it duplicates is the **prompt strategy** and the **turn
driver** — about ninety lines pretending to be a second agent.

### Same process. Not a close call.

The browser lane lives in this process, bound to one WebSocket to one extension.
A separate process needs its own bridge, and then two extensions fight over the
same tabs. The architecture rests on one process owning that connection.

### One turn-runner, two schedulers

```
core/turn-runner.js   NEW — "prompt + tool set + budget → final text".
                      No session, no UI, no GitHub. Mostly moved, not written:
                      the overlap between runHeadlessTask and the main loop.
core/agent-loop.js    the interactive scheduler: conversation state, callbacks.

github/
  poller.js           unchanged — genuinely its own thing
  classifier.js       unchanged — pure, tested
  ci-log-parser.js    unchanged (+ tests)
  work-queue.js       NEW, extracted from event-handler: what to analyse, when
  review-task.js      NEW: builds the prompt, calls turn-runner
  plan-writer.js      renamed, so `/plans` and `/github plans` are not one word
  index.js            the actual glue, ~80 lines
```

The two *loops* stay distinct, because they genuinely differ: the interactive one
is stateful with a human waiting; the GitHub one is batch and stateless per
comment. That difference is real. Everything **below** it is shared.

### Lanes are named, not per-model — and the tab mechanism already exists

This is the finding that reshaped the plan. The extension **already** creates a
separate tab per background request (`src/background/content.js`, the
`payload.isSubagent` branch), already captures the conversation id
(`src/background/main.js:32`, `payload.subagentUrl = sender.tab.url` — the
`/app/<hash>` URL), already sends it to the server, already resolves it into the
subagent result — and **nothing reads it**. The same write-only shape as
`getAllMemories` before phase 3.

GitHub analysis already runs through that path: `runHeadlessTask` →
`_executeSubagent` → `isSubagent: true` → a fresh tab. **It is already not using
the user's tab.**

So the contention is entirely artificial: `ExtensionLock._lane(model)` keys on
the *model*, so a GitHub turn and a user prompt are both `gemini` and serialise —
in the server, while the browser would have put them in two different tabs.

The fix is one change in shape:

| lane | tab | lifetime |
| --- | --- | --- |
| `gemini:main` | the user's, addressed by **tab id** | the session |
| `gemini:github` | a background tab | **fresh per analysis** |
| `chatgpt:main` | the reviewer's | the session |
| `gemini:subagent-N` | ephemeral | one request |

Fresh-per-analysis was chosen deliberately over a persistent GitHub tab: each
comment starts clean, so context cannot bleed between unrelated PRs, and no
conversation-length limit accumulates. It costs the ~4s tab setup already paid
today.

**`extension-lock.js`'s own caveat is half-right and should be rewritten.** It
says two same-model requests "race for one tab". Subagents each get a fresh tab,
so they do not race with each other. The real race is that the *main* path picks
`tabs[tabs.length - 1]` — whatever tab is last — so a subagent's tab can be
handed the user's prompt. Identity-based addressing removes it; the global lock
only hides it.

### Three extension bugs found on the way

- **Focus theft is permanent.** `trySendToTab` captures `originalActiveTabId`,
  uses it only to decide whether to switch, and never switches back. Every send
  yanks the browser to a Gemini tab and leaves it there.
- **Leaked tabs on failure.** `chrome.tabs.remove` runs only for a `complete`
  response. A timeout or an error leaks the tab, and `runHeadlessTask` runs up to
  ten turns.
- **`tabs[tabs.length - 1]`** is non-deterministic once anything else makes tabs.

### The open assumption

Whether Google tolerates two concurrent conversations on one account — and
whether Chrome's background-tab throttling breaks the backgrounded one — **is
not knowable from the code and is being measured before this is built.** If
parallel turns out not to work, the lane map is also where a concurrency cap
would go, so it is a smaller design, not a different one.

---

## Phases

Ordered so the tests land before the risk, and so the extension work — which is
independently testable in a browser — comes before the refactor that depends on it.

| # | phase | why here | risk |
| --- | --- | --- | --- |
| 0 | **Measure parallel Gemini tabs** | the assumption the lane design rests on | — |
| 1 | Failures → `error-log.js` (flow `github`); delete the `agent.log` writes | two lines, and until it lands every later phase debugs blind | low |
| 2 | Characterisation tests: `github-poller.js`, `ci-log-parser.js`, stubbed API | nothing below is safe without them | low, slow |
| 3 | Fix `GITHUB_REPOS`; move repo detection out of the constructor | a named bug; makes phase 7 testable | low |
| 4 | Extension: lane→tabId map, restore focus, close tabs on failure, drop `tabs[length-1]` | self-contained, verifiable in a browser, fixes three bugs | medium |
| 5 | `ExtensionLock`: key lanes by name, not model | tiny diff, unlocks parallelism — **needs phase 4 first** | medium |
| 6 | Extract `core/turn-runner.js`; `runHeadlessTask` becomes a caller | removes the third tool list and the flat re-serialisation **by construction** | **high** |
| 7 | Split `work-queue` / `review-task` / `plan-writer` out of the event handler | the `github/` restructure proper, on a tested base | medium |
| 8 | Rename the plan artifact; migrate existing dirs | cosmetic, needs a migration | low |

**Phase 6 is the careful one.** It touches `prompt-builder.js`, which `CLAUDE.md`
warns must never be bulk-edited with a regex and whose template literals turn a
stray backtick into a `ReferenceError` thrown from an unrelated function. Verify
byte-for-byte, the way the `prompts/*.md` move was — not by reading it.

**Phase 4 ships a build artifact.** `extension/service-worker.js` is committed
and Chrome loads the bundle, not `src/background/`. `npm run build --workspace=extension`
or the change does nothing.

## How to verify

**Phase 0 is a manual browser test, and only the owner can run it.** Open two
tabs at `gemini.google.com/app`. Send a slow prompt in the first, and within ~2
seconds a *different* slow prompt in the second. Watch whether both stream to
completion, whether either shows a rate-limit notice or an A/B modal, and whether
either answer is contaminated by the other's prompt; confirm the two URLs are
distinct `/app/<hash>` ids. Repeat three or four times, **including once with
both tabs backgrounded** — that is the state the GitHub lane actually runs in,
and Chrome throttles background tabs, which `CLAUDE.md` already lists as
unexamined. A failure only when backgrounded is a throttling problem with a known
shape, not a Google limit.

The rest cannot be exercised the way the UI was, because it needs a token, a repo
with open PRs, and a browser tab. So:

1. **A stubbed API, not a live one.** `_apiGet` and the one raw `fetch` (the CI
   log download, `github-poller.js:350`) are the only two network calls; both
   take the base URL from `config.apiBaseUrl`. Point it at a local fixture
   server and the poller is testable end to end with no token.
2. **Watermark behaviour is the thing to characterise.** First sight of a PR
   sets the watermark to *now* and returns nothing (`github-poller.js:263`), which is correct and
   deeply non-obvious — it is what stops a new install from analysing every
   comment in your backlog. Pin it before touching anything.
3. **For phase 5, diff the prompts.** Build the review prompt before and after
   for the same comment and compare bytes.
4. **For phase 6, measure the lane.** The fake extension client from
   `UI-REDESIGN.md` → How to verify holds a turn open; with the poller pointed at
   a fixture, that is enough to watch a user prompt queue behind background work
   and confirm the status bar says so.

---

## Open questions — the owner's call

- **Should analysis be opt-in per comment rather than automatic?** Raised, and
  deliberately **deferred**: it was the biggest lever while background work was
  taxing the user's own tab, and a dedicated `gemini:github` lane removes most of
  that pressure. Revisit after phase 5, when the cost of automatic analysis is
  measurable rather than felt. The explicit path already exists either way
  (`forceAnalyzeComment`, Enter on a comment in the PR explorer).
- **Is the CI-failure path earning its keep?** 198 lines of log parsing plus the
  fetch, producing another markdown file. Untested, and the noisiest source of
  automatic work.
- **Does the plan output want to be a file at all?** Nothing reads it back. A
  plan the agent could re-open — the "session logs as post-compaction recall"
  idea in `CLAUDE.md` → Raised, not yet planned — is the same shape of question.
