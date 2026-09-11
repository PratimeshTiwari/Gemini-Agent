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

## The target

One mechanism per job. The column that matters is the last one: most of this
feature does not change.

| job | today | after |
| --- | --- | --- |
| talk to GitHub | `github-poller.js` | **unchanged** — genuinely its own thing |
| decide what deserves a turn | `comment-classifier.js` | **unchanged** — pure, tested |
| parse CI logs | `ci-log-parser.js` | **unchanged**, plus tests |
| write the output | `plan-generator.js` | unchanged, **renamed** so it is not `/plans` |
| run an AI turn | `runHeadlessTask` — a second loop | the **existing** loop |
| assemble the prompt | inline template in the handler | `PromptBuilder`, one tiered path |
| declare tools | a third hand-kept list | the same source as every other caller |
| record failures | `agent.log`, write-only | `error-log.js`, flow `github` |
| pace the work | unbounded queue + fixed cooldown | bounded, **and visible in the status bar** |
| pick the browser lane | hard-coded `'gemini'` | `modelConfig`, like every other caller |

**What "use the existing loop" means concretely.** Not that PR analysis becomes a
user turn — it must stay headless and must not touch the transcript. It means
`runHeadlessTask` stops carrying its own copy of the loop's decisions: the tool
list comes from where every other tool list comes from, the prompt is built by
`PromptBuilder` with a background profile, failures go to `error-log.js`, and the
lane comes from `modelConfig`. The *loop* stays separate; the *duplication* goes.

---

## Phases

Ordered so each is shippable alone, and so the risky one lands on a tested
foundation rather than before it.

| # | phase | why this order | risk |
| --- | --- | --- | --- |
| 1 | Failures → `error-log.js` (flow `github`); delete the `agent.log` writes | two lines, and until it lands every later phase debugs blind | **low** |
| 2 | Characterisation tests for `github-poller.js` and `ci-log-parser.js` against a stubbed API | nothing below is safe to attempt without them | low, slow |
| 3 | Fix `GITHUB_REPOS` being overwritten; move repo detection out of the constructor | a named bug, and it makes phase 5 testable | low |
| 4 | Split the queue out of the handler into its own module, with tests | it is a work queue, not glue; it is also where phase 6 has to change | medium |
| 5 | Prompt assembly → `PromptBuilder`; tool list → one source | removes the third list, and the repetition-filter exposure | **medium-high** |
| 6 | Bound the queue; route the lane through `modelConfig`; surface depth in the status bar | the user-visible half: work they did not ask for stops being invisible | medium |
| 7 | Rename the artifact so `/plans` and `/github plans` are not one word | cosmetic, and it needs a migration for existing dirs | low |

**Phase 5 is the one to be careful with.** It touches `prompt-builder.js`, which
`CLAUDE.md` warns must never be bulk-edited with a regex and whose template
literals turn a stray backtick into a `ReferenceError` from an unrelated
function. Byte-for-byte comparison of the generated prompts before and after, the
way the `prompts/*.md` move was verified — not a read-through.

---

## How to verify

The GitHub agent cannot be exercised the way the UI was, because it needs a
token, a repo with open PRs, and a browser tab. So:

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

- **Should analysis be opt-in per comment rather than automatic?** Today every
  non-noise comment on every watched PR spends browser turns automatically. The
  PR explorer already has an explicit path (`forceAnalyzeComment`, Enter on a
  comment). Automatic-by-default is the expensive half of this feature and the
  half nobody asked for per-comment; making it explicit would remove most of
  phase 6's pressure. **Not proposed** — it is a product decision, and it is the
  one that most changes what this feature *is*.
- **Is the CI-failure path earning its keep?** 198 lines of log parsing plus the
  fetch, producing another markdown file. Untested, and the noisiest source of
  automatic work.
- **Does the plan output want to be a file at all?** Nothing reads it back. A
  plan the agent could re-open — the "session logs as post-compaction recall"
  idea in `CLAUDE.md` → Raised, not yet planned — is the same shape of question.
