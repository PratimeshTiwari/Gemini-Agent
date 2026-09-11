# Session handoff

Written 2026-09-11, end of the second long session. Delete this file once the work
below is finished — it is a baton, not documentation.

**Read `CLAUDE.md` first.** It carries the architecture, the gotchas, `## Direction`
(the six phases, all done, with the reasoning behind each call) and `## What's next`
(P0–P3 with the evidence for each, plus the things still to plan). This file only says
where the baton is.

---

## State

- Branch `v1-stable`. **Seven commits unpushed**; `origin/v1-stable` is at
  `c04b355`. The owner pushes by hand — do not push without being asked.
- `main` is untouched at `68f76cd`. **None of this has been through a PR yet.**
  Work merges into `main` through a PR only; the branches here are deliberate
  history, so do not delete them and do not rewrite history.
- Tests: `npm test` → **624 passing**, in `server/test/` mirroring `server/src/`.
- Four plan files at the root, all evidence-led and none finished:
  `UI-REDESIGN.md` (round one done, round two open), `EXTENSION-PLAN.md`
  (phases 1–2 done but **unverified**), `GITHUB-AGENT-PLAN.md` (designed,
  shelved by the owner), and this file.

## Done, session three (2026-09-11 → 12)

- **The CLI redesign**, all eight items of `UI-REDESIGN.md`. Chrome went from 17
  rows to one; seven colours became five roles; no emoji left in the live frame;
  the mode moved onto the input border. `RESERVED_ROWS` is a **base of 9 plus the
  conditional furniture**, not a constant — the slash palette is six rows a single
  number could never be right about. Measured at four sizes in five states.
- **The extension's reconnect cause**, found by measurement after the first
  diagnosis was wrong. Everything below in "Known and unfixed".
- **Context invalidation.** Reloading the extension orphaned every running
  content script, and `chrome.runtime.sendMessage` throws *synchronously* — so a
  reply was scraped and then dropped on the last step while the CLI sat on
  "Thinking…". All three content scripts now route through `safeSend`, and the
  worker re-injects into open tabs on start, so a reload heals itself.
- **`looksLikeProviderError` learned Gemini's refusal** ("I'm having a hard time
  fulfilling your request"), which is structurally identical to a finished answer
  and would otherwise become the turn's result.
- **`/workspace` is one command.** It was three names for one noun, and
  `/workspace <path>` silently ignored the path.
- **`.vscode/` deleted** — untracked, gitignored, and recommending an extension id
  that is not on the marketplace.

## Next

**The owner's order: the extension first, then the UI quirks. GitHub is shelved.**

### Waiting on the owner — nothing below can be settled without these

1. **Read `/settings` → Status → `Extension`** after reloading the extension and
   hard-refreshing the Gemini tab. It shows how long the bridge took to find the
   server. If it still reads ~30s, `EXTENSION-PLAN.md` says the answer is an
   offscreen document, and that is the next build.
2. **The two-tab Gemini test** (`GITHUB-AGENT-PLAN.md` → phase 0): two tabs,
   concurrent prompts, once with both backgrounded. The lane design depends on it.
3. `vscode-companion/cli-agent-companion-1.3.1.vsix` is still tracked next to
   1.4.0. Undecided since session two.

### `EXTENSION-PLAN.md` — 2 of 9 phases, and those two are unproven

| # | phase | state |
| --- | --- | --- |
| 1 | fast retry + keep the worker resident | **done, unverified** |
| 2 | `127.0.0.1`, port overridable, dead constants gone | **done** |
| 3 | tests for `src/background/` | not started |
| 4 | fix the code-block scrape | not started — **blocks UI round two** |
| 5 | structured trace events → `/logs extension` | not started |
| 6 | one throttling mechanism; restore focus; close tabs on failure | not started |
| 7 | selector discovery fallback | not started |
| 8 | collapse the two bridges (~600 lines) | not started |
| 9 | tab identity (lane → tabId) | not started |

### `UI-REDESIGN.md` round two — neither started

- **Code blocks.** Half is extension phase 4 (the `JavaScript` welded to the first
  line is a scrape bug). The CLI half: un-indent so a drag-select copies clean
  code, mark the block's edges, and `ctrl+y` to copy. There is no clickable copy
  button and there cannot be — that needs mouse tracking, which is what would
  take native selection away.
- **Jitter.** Measured: **21.9 rows rewritten per tick, 12.5×/second** — the whole
  visible frame. Ink does not diff by line. The fix is to shrink the live region:
  commit each action to `<Static>` as it completes instead of holding the whole
  turn live. ~8 rows instead of 22. Same seam that produced the scroll glitches
  twice, so measure before and after.

### `GITHUB-AGENT-PLAN.md` — shelved by the owner, 0 of 9

Designed, not started. The diagnosis and the lane finding are worth keeping:
the browser contention is **artificial** — the extension already gives background
work its own tab, and `ExtensionLock._lane(model)` is what makes it queue.

### Still parked from session two

`/skills` shape; **session logs as post-compaction recall** (the strongest of
these); search on a genuinely large codebase; the API-backend fork.

## Known and unfixed

- **The extension reconnect fix is not proven.** The cause is: `chrome.alarms`
  clamps to a 30-second floor and `RECONNECT_MAX` was *exactly* that floor, so the
  1s/2s/4s/8s/16s ladder was a constant. Measured with the real extension in
  headless Chrome: 13.6s to connect warm, 25.6s cold, **one** handshake each; and
  refusing every handshake gives two attempts in 75s, gap exactly 30.0s. Four
  different fixes were built and **none moved that number** — Chrome kills the
  idle worker and takes its timers. Two of those four could not even be tested,
  because Chrome match patterns cannot contain a port and the injection detector
  was wrong anyway. Headless reclaims workers harder than a real browser, so the
  Status row exists to answer it where it matters.
- **`enableAntiThrottling` creates its `<audio>` element and never appends it to
  the document.** The throttling defence has always been a detached node.
- **A local process running as the user can still reach the bridge.** Needs a
  shared secret the extension can read, which needs a setup step.
- **Context budgets (24k / 48k / 96k per rung) are guesses.**
- **`multiple_drafts` has never been observed firing** (`/logs agent`).
- **Tool definitions are three hand-kept lists**, not two: `prompt-builder.js`
  has two and `runHeadlessTask` in `agent-loop.js` has a third with a different
  subset. Nobody had counted the third.

## Gotchas that actually bit, this session

- **Never bulk-edit `prompt-builder.js` with a regex**, and **escape backticks** in
  anything inserted into its template literals — a bare one ends the string and
  surfaces as `ReferenceError` thrown from an unrelated function.
- **An edit script that asserts before writing loses every earlier replacement.** Two
  batches of description fixes silently did nothing this way. Verify with `grep`.
- **`import('./src/index.js')` runs the CLI.** Same trap as `main.js`: both are
  scripts, not modules.
- **The pty harness must send escape sequences one at a time.** `b"\x1b[B" * 3` in one
  write arrives as a single keypress. Send, sleep ~150ms, drain, repeat.
- **It earns its keep.** It caught the phase-4 bug where the default `effort:
  'standard'` shadowed every legacy config key, which the unit tests did not. To make
  the agent *run* a turn without a browser, connect a fake extension client over the
  WebSocket with a `chrome-extension://` origin and never answer — that is how the
  animation was measured.
- **`RESERVED_ROWS` is load-bearing and now 9 — a *base*, not a total.** App.jsx
  adds the conditional furniture (palette, disconnected warning, "taking a while")
  for the frame it is about to draw. Adding always-on furniture means raising the
  constant; adding conditional furniture means adding it to that sum, or the
  clear-the-terminal bug comes back. Expect `0` `ESC[2J` and `0` idle bytes from
  every screen. The harness recipe is in `UI-REDESIGN.md` → How to verify — including
  the `clientType` field the fake extension client must send, which is not `client`.
- **A prompt refactor needs a byte-for-byte check**, not a read-through. Moving prose
  into files changed one of ten prompt shapes because `trimEnd()` ate a trailing
  newline the assembly depended on.

## Owner preferences observed

- Simple over clever. "Keep things simple stupid yet effective."
- Wants the reasoning, not a list of changes, and pushes back when a plan is a pile of
  tasks rather than one idea.
- Benchmarks against Claude Code and asks how Claude Code solves things.
- Asks for the unsugared answer and means it. Measure before asserting; label an
  estimate as an estimate.
- Reverses course when the argument is good, and expects the same in return — `/help`
  was removed and restored within a minute on that basis.
- Sends short mid-turn corrections while work is running. Read them as steers, finish
  the thing in flight, then act.
