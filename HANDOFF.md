# Session handoff

Written 2026-09-11, end of the second long session. Delete this file once the work
below is finished — it is a baton, not documentation.

**Read `CLAUDE.md` first.** It carries the architecture, the gotchas, `## Direction`
(the six phases, all done, with the reasoning behind each call) and `## What's next`
(P0–P3 with the evidence for each, plus the things still to plan). This file only says
where the baton is.

---

## State

- Branch `v1-stable`. **Four commits unpushed** (`a4975b7`, `0024961`, the
  UI-redesign plan, and the redesign itself); `origin/v1-stable` is at `df791f5`.
  The owner pushes by hand — do not push without being asked.
- `main` is untouched at `68f76cd`. **None of this has been through a PR yet.** Work
  merges into `main` through a PR only; the branches here are deliberate history, so
  do not delete them and do not rewrite history.
- Tests: `npm test` → **624 passing**, up from 295. They live in `server/test/` now,
  mirroring `server/src/` directory for directory.
- Commits carry the `Co-Authored-By` and `Claude-Session` trailers the harness asks
  for. Older ones are inconsistent on purpose.

## Done this session

**All six Direction phases** (2 → 3 → 4 → 5 → 6 here; 0, 1 and 7 came before), then
four priority tiers. `CLAUDE.md` has the reasoning; the headlines:

- **P0, security.** The auto-mode command classifier read `command.split(/\s+/)[0]`
  and stopped, so `echo hi; rm -rf /tmp/x` classified as `safe` and ran with no
  approval. The bridge bound to `::` — every interface — with no authentication.
  `diff-engine.js` overwrote files with no tests, and writing them found backups
  escaping the backup directory.
- **P1, correctness.** Tool arguments are checked against the schema the prompt
  promises (`zod` was installed and never imported). Workspace switching became a
  restart, because `setWorkspace` left memory writing to the *old* project and the old
  allowlist armed.
- **P2.** Settings tabs; `grep_search` rebuilt for large repos; the ChatGPT bridge was
  **deleting** attached images rather than sending them; static prompt prose moved to
  `server/src/prompts/*.md`.
- **P3.** VS Code terminal integration (companion 1.4.0), folder picker, tests moved,
  a running-line animation, `agent-loop.js` 1,910 → 1,612, and a command audit log.

**Found while looking, not on any plan:** `<thought>` blocks were printed as raw XML
because the parser matched `<think>` and every prompt asks for `<thought>` — one word,
and it was most of "the output comes out messy". The token counter summed local
history and ignored the system prompt and tool definitions. `/restart` touched an
mtime nothing watched. `/image` put base64 in the session files.

## Next

**`UI-REDESIGN.md` is done** — all eight items, 2026-09-11. The chrome cost 17
rows and talked about itself; it is one row now. Seven colours became five
roles, the live frame has no emoji left, the mode moved onto the input border,
and 17 `console.*` writes that landed in the Ink frame (the `[GitHub Bridge]`
lines) went to `error-log.js`. The frame budget is a **sum** rather than a
constant now — the slash palette is six conditional rows a single number could
never be right about. Measured at four terminal sizes in five states: 0 `ESC[2J`
everywhere. Read the file for what changed against the plan, including one
finding recorded as *unproven* rather than fixed.

**Plan the GitHub PR agent restructure.** 1,649 lines, the largest single feature.
The owner was explicit: **restructure, not delete**, and plan it on its own once
everything else had landed. It has. This is the next piece of work.

Then five things raised while the phases ran and parked until they were done. All are
recorded in `CLAUDE.md` → `## What's next`:

1. **The extension** — Chrome throttling of background tabs, the retry behaviour
   around it, what the bridge papers over. To be planned, not patched.
2. **`/skills` shape.** Its alignment and escape handling are fixed; whether a
   four-entry search path plus `skillFolders` as a config escape hatch plus
   editor-opening creation is the right set of moves was never examined.
3. **Session logs as post-compaction recall.** Compaction replaces old turns with a
   summary, but `sessions/history.jsonl` still holds every turn. Letting the model look
   back into it turns "compaction ate the detail" into a lookup instead of asking
   compaction to guess in advance what will matter. The strongest of these five.
4. **Search on a genuinely large codebase.** `grep_search` takes several patterns,
   context lines and groups by file now, and the reasoning for having no index is
   written down — but it was decided from the architecture, not from measurement.
5. **The API-backend fork.** Recorded as a decision, not a task: it contradicts the
   standing "no API keys" line, and that call is the owner's.

## Known and unfixed

- **A local process running as the user can still reach the bridge.** Loopback binding
  and the Origin check close the network and the browser. Closing this needs a shared
  secret the extension can read, which needs a setup step — a UX decision.
- **Context budgets (24k / 48k / 96k per rung) are guesses.** Better than the single
  hardcoded 50,000 they replaced, still guesses.
- **`multiple_drafts` has never been observed firing.** It logs now (`/logs agent`).
  Read it after a week of real use and decide whether the detector earns its place.
- **Tool definitions are still two hand-kept lists** that must agree with
  `TOOL_DEFINITIONS`. Generating them was blocked on `ask_question`, `ask_subagent`,
  `ask_researcher`, `ask_reviewer` and `manage_memory` being dispatched inside
  `agent-loop.js`; the slash-command split unblocked it but it is not done.

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
