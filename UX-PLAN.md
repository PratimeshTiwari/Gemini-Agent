# What to fix next, ordered by what the user feels

Written 2026-09-14, from measurement rather than reading. Every claim below has a
number or a reproduction behind it; where something is inferred rather than
observed, it says so.

**Read `CLAUDE.md` first** for the architecture. This file replaces the scattered
status in `HANDOFF.md`, `EXTENSION-PLAN.md` and `UI-REDESIGN.md` — those keep
their *reasoning*, which is the part worth having, but stop being three places
that each claim to know what is done.

---

## The one idea

**The pipeline is sound and the last inch is broken.**

The engine was measured end to end this session and it holds up: a turn runs, the
prompt economics work (17,067 characters on turn 0, then 399), the approval path
refuses to write without a diff and a backup, the VS Code companion round-trips on
all four of its file channels, and the live frame never overflows the viewport —
zero `ESC[2J` across nine sessions in five states.

What is broken is everything in the last inch, where the product meets the person
using it: the reply arrives with its code blocks mangled and some prose deleted,
the browser is yanked to a Gemini tab on every send and left there, a new tab
opens on every launch whether or not one is needed, and the model is instructed to
use a tool that does not exist.

None of these is architectural. Each is small. Each is felt on **every single
turn**, which is why they outrank the nine-phase refactors.

---

## How this was measured

A harness that drives the real CLI under a pty with a fake extension answering
prompts from a script, so a full turn — inject, reply, tool call, tool result,
next prompt — runs with no browser and no Gemini account. Plus the real extension
in headless Chrome against a real `WebSocketServer`.

Kept in the session scratchpad; rebuild from this recipe if gone:

- `drive.py` — `pty.fork()` the CLI with `--workspace <scratch> --port <p>
  --editor <shim> --no-github`. `PATH` is prefixed with a `bin/` of shims for
  `open`, `code`, `xdg-open` and `cursor` that log their argv instead of
  launching anything, which is how "did it open the editor" became checkable.
  Steps are a JSON list: type text, send a key, or write a file into
  `.agent/state/` to stand in for the VS Code companion.
- `fake-extension.js` — connects with a `chrome-extension://` origin, sends
  `{type:'identify', payload:{clientType:'extension'}}` (`clientType`, not
  `client`), and answers each `inject_prompt` from a scripted list. Logs every
  prompt it is given, which is how the per-turn character counts came out.
- `ext-cadence.js` — the real extension in headless Chrome, against a server
  whose `verifyClient` **refuses every handshake**, so each retry becomes an
  observable timestamp.
- `scrape-test.mjs` — `extractTextContent` lifted verbatim out of
  `gemini-bridge.js` and run against a Gemini-shaped DOM in jsdom.

**Two ways the harness lied before it told the truth**, both worth remembering.
It reported `get_editor_state` returning `Line undefined` — that was the harness
inventing field names; the companion writes `cursorLine`/`cursorChar`/
`visibleText` and both sides agree. And a "never connects" result for the
extension was the harness dialling 7778 when the extension only ever dials 7777
unless `chrome.storage.local.agentPort` is set. Check the harness before
believing a negative.

---

## P0 — felt on every turn, proven, cheap

**All four are done** (`38b1c00`, `732e0ae`, `68d5dc4`, `eee60b2`), with tests.
Kept here because the reasoning is the part worth having later; what each fix
turned out to be is recorded under its item.


### 1. The code-block scrape deletes content

`gemini-bridge.js:582`. Run against a Gemini-shaped DOM, not argued from reading:

```js
clone.querySelectorAll('pre code, code-block').forEach(codeBlock => {
  const lang = codeBlock.getAttribute('data-language') || ...;
  const code = codeBlock.textContent;
  codeBlock.parentElement.replaceWith(document.createTextNode(...));
});
```

The selector matches the `<code-block>` wrapper **and** the `<pre><code>` inside
it, `querySelectorAll` returns document order so the wrapper is processed first,
and `.parentElement.replaceWith` then replaces the wrapper's **parent**.

Measured, two distinct failure modes depending on nesting:

| `<code-block>` is… | fence language | header chip | surrounding prose |
| --- | --- | --- | --- |
| inside a wrapper with siblings | **lost** | `JavaScriptcontent_copy` welded to line 1 | **deleted** |
| a direct child | kept | leaks as loose text above the fence | kept |

The copy button's own text comes through too, which the earlier diagnosis did not
catch. The symptom reported from use — `JavaScript// 1. Using async/await` — is
the first row, which is evidence that real Gemini has the wrapper, and therefore
that **prose next to a code block is being silently dropped from replies**.

**The fix**: select `code-block, pre` (not the inner `code`), read the language
off the inner `[data-language]` or `.language-*`, take `textContent` of the
`<pre>` rather than the wrapper, and `replaceWith` the **element**, never its
parent. Ship the two fixtures as the regression test — they are also what will
catch Gemini's next redesign.

Blocks `UI-REDESIGN.md` round two, which cannot be judged while its input is
corrupted.

### 2. The system prompt instructs a tool that does not exist

`prompt-builder.js:282`, live in every pro-tier prompt:

> ALWAYS proactively create a `.agent/artifacts/task.md` checklist using the
> `write_to_file` tool to plan your work, similar to Antigravity IDE.

There is no `write_to_file`. `TOOL_DEFINITIONS` holds ten: `search_files`,
`grep_search`, `read_file`, `edit_file`, `create_file`, `list_directory`,
`run_command`, `open_in_editor`, `run_background`, `manage_task`. A model that
obeys the instruction gets its call rejected and burns a turn — and the
Antigravity-style task checklist, which is a named feature, can never be produced
the way the prompt asks for it.

`use-agent-callbacks.js:83` also tests for `write_to_file` when deciding whether a
write was a plan, so that branch is dead too.

**The fix** is one word — `create_file` — in both places, unless the intent was a
distinct tool. See "What needs you".

### 3. Every launch opens a Gemini tab, whether or not one is needed

`main.js:246` runs `open https://gemini.google.com/app` unconditionally at
startup. Confirmed by the shim: it fires even when the extension connects
normally, because it runs before anything is known about the connection. Five runs
of `agent` in a day is five tabs.

**The fix**: only open when no extension has identified within a few seconds. The
information needed is already there — `extensionConnectMs` exists for the Status
row.

### 4. Every send yanks the browser and leaves it there

`content.js:84`. `trySendToTab` captures `originalActiveTabId`, uses it only to
decide *whether* to switch, and never switches back. On a tool whose whole premise
is that the browser is a background engine, this is the most intrusive thing it
does, and it does it on every turn.

**The fix was not the obvious one.** Restoring after the send — a
`chrome.tabs.update` in a `finally`, which is what this plan first said — would
have made things worse. Completion is detected by a 2-second `setInterval` in the
content script, and Chrome throttles that to roughly once a minute in a
background tab, so handing focus back immediately trades a visible annoyance for
turns that take a minute to be noticed as finished. `content.js:122` already said
as much in a comment: keeping the tab active is deliberate.

So the restore happens **on completion**, in the message handler where the turn
actually ends, and it does nothing if the model tab is no longer active — the
user moving on mid-reply is the common case, and pulling them back is a second
theft rather than a repair. Bookkeeping is a map keyed by tab, because a subagent
turn and the user's own turn can be in flight at once.

Subagents had it worse than the main path and that was not noticed until the fix:
their tab is created `active: false` on purpose, and the wakeup pulled it to the
front anyway, defeating the background lane entirely.

---

## P1 — felt continuously, but wants care or a number first

### 5. The live frame is rewritten twelve times a second

Measured previously and unchanged: **21.9 rows per tick, 12.5×/second** at 24×100
during a live turn — the whole visible frame, because Ink does not diff by line
and the spinner is a state change every 80ms. Any selection in that region is
written over twelve times a second.

The fix is to shrink the live region: commit each action to `<Static>` as it
completes rather than holding the whole turn live — around eight rows instead of
twenty-two. **This is the seam that produced the scroll glitches twice**, so it
wants the before/after measurement at four terminal sizes, not a read-through.
`drive.py` now makes that cheap.

### 6. Code blocks cannot be copied cleanly

`marked-terminal` is configured `tab: 2`, so a drag-select takes the indentation
with it. Un-indent, mark the block's edges with a dim rule carrying the language
(outside what a drag picks up), and add `ctrl+y` to copy the last block. There is
no clickable copy button and there cannot be — that needs mouse tracking, which is
what would take native selection away.

Pairs with P0.1: the language is only available to render once the scrape stops
losing it.

### 7. The extension reconnect is still the alarm floor

Measured with the shipped bundle, refusing every handshake:

```
attempts at:  4.7s   20.7s   50.7s   80.7s
gaps:               16.01s  30.01s  30.01s
```

Steady state is **exactly 30.0s** — the `chrome.alarms` clamp floor, the same
number as before the fix. Connect times did improve (cold 25.6s → **11.3s**, warm
13.6s → **12.0s**), but phase 1 predicted sub-second, and it did not land.

Headless Chrome has no user activity and reclaims service workers harder, so this
is a lower bound rather than a verdict — which is exactly why the Status row
exists. **Gated on the owner's real-browser number.** If it reads ~30s there, the
answer is an offscreen document and that is the next build.

### 8. `src/background/` has no tests

504 lines, zero tests, and it is where every connectivity bug in this file lives.
Socket state, reconnect policy, message routing and tab selection are ordinary
JavaScript that needs no browser. Slow and unglamorous, and it is the only thing
that makes collapsing the two bridges (~600 duplicated lines) safe to attempt
later.

---

## P2 — correctness debt, and unknowns worth turning into numbers

### 9. `open_in_editor` loses the line number when the editor is a path

`open-in-editor.js` branches on `editor === 'code' || editor === 'cursor'`, the
exact string. Measured:

```
--editor code                  ->  code --goto /path/widget.js:2:1
--editor /usr/local/bin/code   ->  code /path/widget.js        (no line)
```

`config.editor` defaults to `process.env.EDITOR`, which is commonly an absolute
path. Worse, the tool reports `"Opened src/widget.js at line 2"` either way, so
the model is told navigation happened when it did not. Match on the basename.

### 10. Tabs leak on failure, and the throttling defence never fires

**The leak half is done** (`eee60b2`), taken early because it is the same `if`
the focus restore rewrote and leaving a known leak in freshly rewritten code is
worse than the small scope creep. `main.js` removed the subagent tab only for
`payload.complete && isSubagent`; a timeout sends `complete: false`, so it leaked,
and `runHeadlessTask` runs up to ten turns. A turn is now over when it completes
*or* gives up. The throttling half below is still open.

`enableAntiThrottling` loops a silent WAV to keep a background tab awake, and it
does not work — but **not for the reason recorded in `EXTENSION-PLAN.md` and
`HANDOFF.md`**, which both say the `<audio>` element is created and never appended
to the document. That is true and it is not the bug: a detached `<audio>` plays
fine in Chrome, which is exactly what `new Audio()` is. Correcting it here so the
next session does not act on it.

The real reason is the one the code itself admits in its own catch block:
Chrome's autoplay policy blocks playback without a user gesture or a high
media-engagement score, and the fallback binds `click` and `keydown` with
`{ once: true }` — which a **backgrounded** tab never receives. So it plays in
tabs that did not need it and stays silent in the ones it exists for.

Delete it rather than fix it: the Tab Wakeup Protocol is the mechanism that
actually works, and two competing hacks for one problem is how this got
confusing.

### 11. A drained marker expands with no separator

The model received `why is this failing?src/widget.js (lines 2-2):` glued
together. Cosmetic, one newline.

### 12. The refresh interval is a guess, and it counts the wrong thing

`REFRESH_INTERVAL_MESSAGES = 20`, and `messagesSinceRefresh` is incremented by
`noteMessageSent()` once per tool-result batch as well as once per user turn. So a
tool-heavy session refreshes roughly every five *user* turns and a conversational
one every twenty. Nobody has measured whether either is right.

The evidence to collect already exists: `parse_tool_calls`, `tool_amnesia` and
`multiple_drafts` are all logged with timestamps. Correlating them against
distance-from-refresh turns "20 feels about right" into a number. This is the same
shape as the context budgets (24k/48k/96k), which are also guesses.

### 13. `multiple_drafts` has still never been observed firing

Instrumented in P1 precisely so this question could be answered, and the log has
not been read. `/logs agent` after a week of real use, then decide whether the
detector earns its place.

---

## The rest of the pipeline

P0–P2 above is what is felt on every turn. It is **not** the whole board, and
absorbing three items out of the other plans without saying what happened to the
rest is how a plan quietly becomes a smaller plan. Every open item in the project
is below, with where it now lives.

Nothing here is abandoned. It is sequenced behind the last-inch work because none
of it is felt per turn — and two of the tracks get materially safer once P1.8
lands.

### Track A — `EXTENSION-PLAN.md` (9 phases)

| # | phase | state, checked today |
| --- | --- | --- |
| 1 | fast retry + keep the worker resident | done — and **measured this session: it did not land**. → **P1.7** |
| 2 | `127.0.0.1`, port overridable, dead constants gone | done and verified: dials `127.0.0.1:7777`, overridable via `chrome.storage.local.agentPort` |
| 3 | tests for `src/background/` | not started, still 0 tests → **P1.8** |
| 4 | fix the code-block scrape | not started → **P0.1** |
| 5 | structured trace events → `/logs extension` | **not started, stays its own track** |
| 6 | one throttling mechanism; restore focus; close tabs on failure | split: focus → **P0.4**, tabs + audio → **P2.10** |
| 7 | selector discovery fallback | **not started, stays its own track** |
| 8 | collapse the two bridges | **not started.** Verified today: all ten functions still exist in both files, 776 + 610 lines |
| 9 | tab identity (lane → tabId) | **not started.** Same work as GitHub phase 4 |

**Phase 5** (trace events) is the one I would pull forward first of these. Right
now "the extension got slower" is unmeasurable from inside the product — P2 added
`op`/`stage` to *errors*, but a successful turn records no timings at all. It is
what turns the next regression into a number instead of an argument.

**Phase 8** stays last. It is ~600 duplicated lines and the reason the ChatGPT
image bug survived for months, but it is also the one change that can break both
bridges at once. It wants phases 3 and 5 under it first.

### Track B — `GITHUB-AGENT-PLAN.md` (9 phases, 0 started, shelved by the owner)

Shelved, and the diagnosis was re-checked today rather than copied. Every finding
still holds:

| # | phase | state, checked today |
| --- | --- | --- |
| 0 | measure parallel Gemini tabs | **owner only.** Gates the lane design, nothing else |
| 1 | failures → `error-log.js` | `github-event-handler.js:258,261` still `appendFileSync` to `agent.log`; grep confirms **nothing reads it**. Two lines |
| 2 | characterisation tests | still none for `github-poller.js` (476), `github-event-handler.js` (357), `ci-log-parser.js` (198) — **1,031 lines of I/O untested** |
| 3 | fix `GITHUB_REPOS` | still overwritten at `:47` by the git-remote detection, so the env var is ignored exactly where someone would set it |
| 4 | extension lane→tabId | same work as extension phase 9 |
| 5 | `ExtensionLock` lanes by name not model | tiny diff, needs 4 first |
| 6 | extract `core/turn-runner.js` | `agent-loop.js:1409` still re-serialises the whole history per turn; `:1411` still hard-codes `_executeSubagent('gemini', …)` |
| 7 | split work-queue / review-task / plan-writer | not started |
| 8 | rename the plan artifact | not started |

**Phase 1 should be done regardless of the shelving.** Two lines, and until it
lands the most failure-prone path in the project — an AI turn depending on a
browser tab staying awake — is the one path `/logs` cannot see. I would fold it
into the P2 batch.

Everything else here stays shelved until you unshelve it.

### Track C — `UI-REDESIGN.md` round two

**Fully absorbed.** Jitter → P1.5, code blocks → P0.1 (the scrape half) and P1.6
(the copyability half). Round one's eight items are done. Nothing is left in that
file except reasoning worth keeping.

### Track D — raised in `CLAUDE.md`, never planned

These have no plan file and have been carried as prose for three sessions:

- **Session logs as post-compaction recall.** The strongest of them. Compaction
  replaces old turns with a summary and the detail is gone from the model's view
  — but not from disk. A tool that reads back into `sessions/history.jsonl` turns
  "compaction ate it" from a loss into a lookup, and does not require deciding in
  advance what will matter. **This is the one I would plan next after P0.**
- **A symbol index** — `find_symbol` / `find_references`, tree-sitter or ctags.
  The structural half of what a large codebase needs and the half grep is worst
  at. Listed as a P3 gap and never started.
- **Generating tool definitions from `TOOL_DEFINITIONS`.** Blocked, and worse
  than recorded: `_buildToolDefinitions` keeps two hand-written lists,
  `runHeadlessTask` has a **third** with a different subset, and five tools
  (`ask_question`, `ask_subagent`, `ask_researcher`, `ask_reviewer`,
  `manage_memory`) are dispatched from inside `agent-loop.js` and declared
  nowhere. GitHub phase 6 removes the third list by construction, which is the
  real argument for doing that phase even with GitHub shelved.
- **`/skills` shape.** Reachable and aligned; the shape of the feature was never
  examined.
- **Search on a genuinely large codebase.** The decision not to build an index is
  recorded and argued from the architecture, not measured. The next large repo is
  the measurement.
- **The fork — an optional API backend.** Contradicts the standing "no API keys"
  decision, so it stays a fork rather than a plan. Its cheap half is not a fork at
  all: `parse_tool_calls`, `tool_amnesia` and `provider_error` are all logged and
  nobody reads them as *rates*. That overlaps **P2.12** and **P2.13** and is worth
  doing on its own — any claim about how far the text channel is behind a real
  tool-call API is an estimate until that view exists.

### Track E — process, not code

- **`main` is 53 commits behind and the merge is still a clean fast-forward**
  (`git rev-list --left-right --count main...v1-stable` → `0 53`). Three sessions
  have never been through a PR. It is free today and does not stay free on its
  own; `CLAUDE.md` documents the divergence trap that makes it expensive later.
- **`cli-agent-companion-1.3.1.vsix`** still tracked next to 1.4.0, undecided
  since session two.

### Suggested order across all tracks

1. **P0** — four fixes, all proven, all cheap.
2. **P1.8** (`src/background/` tests) — it is also what makes extension phase 8
   attemptable, so it pays twice.
3. **P1.5 / P1.6** — the jitter and the copyable code blocks.
4. **P2 as one batch**, with **GitHub phase 1** folded in.
5. **Extension phase 5** (trace events), so the next regression is a number.
6. **Plan session-log recall** — the largest genuine capability gap.
7. Extension phases 7 → 9 → 8, in that order.
8. GitHub, when you unshelve it.

---

## What needs you, and what does not

**Five decisions are yours. Everything else below can proceed without you.**

1. **Read `/settings` → Status → `Extension`** in your real browser, after
   reloading the extension and hard-refreshing the Gemini tab. Two minutes. It
   gates P1.7 and nothing else — if it reads ~30s, the offscreen document is the
   next build; if it reads under a second, headless was lying and that work is
   done. The row is verified working; it rendered `connected in 5.9s` under the
   harness.

2. **A product call on the startup tab (P0.3).** Never open it, open it only when
   no extension appears within a few seconds, or leave it. I would do the middle
   one, and I will unless you say otherwise.

3. **What `write_to_file` was meant to be (P0.2).** If the Antigravity-style task
   checklist was meant to be its own tool, that is a small feature rather than a
   typo. If it was shorthand for "write the file", the fix is one word. I would
   do the one word.

4. **Does GitHub stay fully shelved?** I would keep it shelved *except* phase 1 —
   two lines that route analysis failures into `/logs`, so that path stops being
   invisible if you ever switch it back on. Everything else there waits for you.

5. **The order in "Suggested order across all tracks" is a recommendation, not a
   decision.** The one place I would push back on myself: extension phase 5
   (trace events) sits at position 5, and there is a case for it much earlier —
   it is what makes every later performance claim checkable instead of arguable.
   I left it at 5 because it buys measurement rather than relief, and P0 is all
   relief.

Plus two standing items: `cli-agent-companion-1.3.1.vsix` is still tracked next to
1.4.0, undecided since session two — I would delete 1.3.1, git keeps it. And the
PR into `main`, which is free today (`0 53`, a clean fast-forward) and gets more
expensive the longer it waits.

**Not gated on you:** P0.1, P0.4, P1.5, P1.6, P1.8, all of P2, extension phases
3/5/7/8/9, and every Track D item. That is most of the board, and it is why
"waiting on the owner" should not be read as "blocked".

**The two-tab Gemini test** is still unrun, but it only gates the GitHub lane
design, which is shelved. It is not blocking anything in this file.

---

## How to verify

1. **The scrape** (P0.1) — the two jsdom fixtures, run in CI. No browser.
2. **The phantom tool** (P0.2) — grep that no prompt names a tool absent from
   `TOOL_DEFINITIONS`. Cheap enough to be a test, and it is the same drift the
   `prompt-builder` tests already exist to catch.
3. **The startup tab and focus restore** (P0.3, P0.4) — the `bin/` shims log
   argv; assert what was launched and what was not.
4. **The jitter** (P1.5) — `drive.py` under a pty at four sizes, bytes and
   erase-line counts before and after. **The bar stays `0` `ESC[2J` and `0` idle
   bytes in every state.**
5. **The reconnect** (P1.7) — `ext-cadence.js` for the cadence, the Status row for
   the truth. Headless is a lower bound, never the answer.
