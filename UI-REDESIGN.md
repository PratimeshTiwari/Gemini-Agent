# UI redesign

Written 2026-09-11, and **built the same day** — items 1–8 below are done. The
plan is kept rather than deleted because the reasoning is the part worth having
later; the status table at the bottom says where each item landed.

**Read `CLAUDE.md` → `## Gotchas` first.** Every item below is constrained by one
rule that is not negotiable: *the live frame must never outgrow the viewport.*
When it does, Ink answers with `ESC[2J ESC[3J` and a full repaint on every
render, which is what "it flickers and I can't scroll or copy" was. The measured
shape of that bug and the way to re-measure it are in `CLAUDE.md`.

---

## The one idea

**The chrome should cost one row and say one thing at a time.**

Everything under the transcript today is furniture explaining the app to you: an
input box, then a blank row, then a mode chip, then a blank row, then a rule,
then two rows of status, of which one is a list of keys you learned on day one.
Seventeen rows (`RESERVED_ROWS`) on a 24-row terminal — more than half the screen
is the app talking about itself, and the transcript, which is the entire product,
gets seven.

The fix is not to make the furniture prettier. It is to make it an **instrument
panel**: one row, always in the same place, each field in a fixed column so it is
read by position rather than hunted for. Everything that is learned once and then
known — the keybindings, the vanity byline, the second copy of "how full is the
context" — comes out of the frame entirely.

That is the whole redesign. The rest of this file is what it means per surface,
and the evidence for each call.

---

## What is actually wrong

Measured against the running app, not guessed.

### 1. Seven colours, no system

```
cyan ×15   yellow ×11   green ×8   magenta ×5   red ×3   gray ×2   blue ×2   white ×1
```

plus a rainbow gradient on the banner. Nothing maps a colour to a meaning:

- **yellow** is currently: processing, warning, plan mode, artifacts, background
  tasks, and the disconnected-extension state.
- **green** is currently: success, auto mode, active scope, and connected.

A colour that means five things means nothing, and the eye stops using it to
triage — which is the only job colour has in a terminal.

### 2. Emoji mixed with box-drawing

```
⚠️ ×6   📋 ×4   🎯 ×2   🟢 🟡 🔴 🐙 ×1 each
```

sitting next to `❯ ⏺ ✻ ✔ ✖ ─ │`. Three problems, in order of severity:

- Emoji are **double-width and terminal-dependent**, so they break column
  alignment in the status bar — the one row whose whole value is that fields stay
  put.
- They carry their own colour, which the theme cannot override, so 🟢 is a
  *fourth* green that no longer matches the three above.
- Against ASCII everywhere else they read as a consumer app bolted onto a
  developer tool.

### 3. The mode chip is detached from the thing it governs

`▶▶ plan mode on (shift+tab to cycle)` sits **outside and below** the input box.
Plan vs auto is the single most consequential piece of state on screen — it is
the answer to "will this edit happen without asking me?" — and it is rendered as
a footnote to the box it actually governs, costing two rows to do it.

### 4. The status bar asks the same question twice, on two rows, misaligned

```
🟢 Agent │ GitHub (ctrl+o)              FLASH · ~1,427/50,000 (3%)
^t terminal · ^e expand · ^u clear                      2/50 ctx
```

`~1,427/50,000 (3%)` and `2/50 ctx` are different units (tokens, turns) answering
one question. They are right-aligned on different rows, so they do not line up
with each other and neither can be read at a glance. And the keyhints row is
permanent screen rent for information that is load-bearing exactly once.

### 5. Raw `console.log` lands in the live frame

The three `[GitHub Bridge] User viewing PR #13` lines in the transcript come from
`server/src/bridge/websocket-server.js:303`. There are **45 `console.*` writes in
`server/src`**, of which roughly 24 are on paths that can fire *during* a session:

| file | writes |
| --- | --- |
| `core/agent-loop.js` | 8 |
| `bridge/websocket-server.js` | 5 |
| `storage/session-store.js` | 4 |
| `github/github-poller.js` | 3 |
| `ui/components/GithubTab.jsx` | 2 |
| `watcher/file-watcher.js` | 1 |
| `core/slash-commands.js` | 1 |

(`main.js` and `migrate.js` print before Ink mounts and are fine.)

This is the one straight bug in the list. `CLAUDE.md` already states the rule —
"console output inside an Ink app is destroyed by the next repaint" — which is
why `core/error-log.js` exists. These writes never got moved to it.

### 6. The banner is the loudest element and carries the least

Six rows of figlet (measured: `Standard` font, "DCX Agent" → 6 rows × 49 cols) in
a rainbow gradient, a magenta vanity byline, then the line that actually orients
you — workspace, model — dimmed underneath. The hierarchy is exactly inverted.

It is in `<Static>`, so it costs scrollback rather than frame budget, and it is a
one-time cost. **Its height is therefore not the problem; its priority is.**

---

## The system

One rule, checkable with a grep, so it cannot silently drift back.

| role | colour | means, and means only |
| --- | --- | --- |
| accent | `cyan` | where you are, what has focus, what is interactive |
| alert | `yellow` | needs a decision from you |
| positive | `green` | a step succeeded |
| negative | `red` | a step failed |
| structure | `dimColor` | everything else |

**Magenta, blue and the gradient go.** Nothing in the app is a fifth kind of
thing. Status is carried by glyph and position; colour only ever says *how
urgent*.

**Emoji go, replaced by single-width glyphs** already in use elsewhere in the
app: `●` connected, `○` disconnected, `◐` working, `!` needs attention. One
exception worth arguing over rather than deciding here: the banner wordmark.

---

## Target layout

### Header — restructure, do not shrink

The figlet stays; it is the product's wordmark and it is free (Static). Two
changes:

- **Solid accent instead of the rainbow gradient.** A gradient reads as terminal
  art; a solid or two-tone wordmark reads as a product. This is the single
  highest-ratio change in the file — one line, and it is most of what "looks
  unpolished" is.
- **The byline joins the dim orientation line**, keeping `Developed by` so it
  reads as attribution rather than as a stray name. It is not a peer of the
  wordmark, but it is not anonymous either.

```
  ██████╗  ██████╗██╗  ██╗  ...          ← accent, solid
  Developed by Pratimesh Tiwari
  ~/Documents/Gemini-Agent · gemini
```

### Bottom — one row of chrome

```
┌──────────────────────────────────────────────────────────────────────────┐
│ > Ask anything, or / for commands                                        │
└──────────────────────────────────────────────────────────────────────────┘
  ● agent  ○ github ^o                      plan ⇥  ·  FLASH  ·  3% of 50k
```

- **Border colour carries mode.** Cyan when auto, yellow when plan. The state is
  bound to the box it governs, and the border is already the most visible line
  on screen. The chip's two rows come back.
- **Status is one row**, fixed columns: identity and tabs left, mode/effort/context
  right, in that order, always.
- **One context number.** Tokens, because that is the real constraint; turn count
  appears only as it approaches compaction, where it becomes actionable.
- **The keyhints row goes behind `?`** (and, optionally, shows once while the
  input is empty and the session is new). This is how Claude Code does it, and
  the reason is the same: a hint is a teaching surface, not an instrument.
- **The rule above the status bar goes.** The gap already separates it; the line
  is a row of furniture drawing a boundary that was not in doubt.

### The payoff, in rows

| | before | after |
| --- | --- | --- |
| mode chip + its blank row | 2 | 0 |
| keyhints row | 1 | 0 |
| `borderTopStyle` rule | 1 | 0 |
| **base furniture (`RESERVED_ROWS`)** | **17** | **9** |
| transcript on a 24-row terminal, idle | 7 rows | 15 rows (**+114%**) |

The conditional rows are charged only when drawn, so the palette-open case is
now *correctly* tighter than the idle one rather than silently over budget.

---

## Work items

All eight are done. Ordered as they were planned — by result over risk.

| # | item | where it landed | status |
| --- | --- | --- | --- |
| 1 | Mid-session `console.*` → `error-log.js` | 6 files, 17 call sites | **done** |
| 2 | Five colour roles; magenta, blue and the gradient deleted | `components/*`, `App.jsx` | **done** |
| 3 | Emoji → single-width glyphs in the live frame | `App.jsx`, `InputBar`, `Menus`, `GithubTab` | **done** |
| 4 | Mode onto the input border; chip deleted | `InputBar.jsx` | **done** |
| 5 | Status bar to one row, fixed columns, one context number | `App.jsx` | **done** |
| 6 | Keyhints into `/help` | `App.jsx` | **done** |
| 7 | Frame budget, measured | `constants.js`, `App.jsx` | **done** |
| 8 | Header: solid wordmark, byline demoted | `Banner.jsx` | **done** |

### What changed against the plan

**Item 1 routed 17 call sites, not ~24.** The count came from grepping files,
and two of the hits in `GithubTab.jsx` turned out to be comments warning against
exactly this — the rule was already written down next to the code that kept
breaking it. `error-log.js` gained a `storage` flow for `session-store.js`, which
had four writes and no flow that fitted.

One write was deleted rather than routed: `file-watcher.js` announced its own
successful startup, once, into a frame Ink repaints. Nothing acted on it.
`websocket-server.js`'s `github_pr_viewing` — the three `[GitHub Bridge]` lines
in the screenshot — became a field on the bridge instead of a log line, because
it is routine `MutationObserver` traffic, not a failure.

**Item 7 became a sum, not a smaller constant.** The plan said `RESERVED_ROWS`
17 → ~13, measured. Measuring it turned up the thing the constant could not
express: some of the furniture is conditional, and one piece is *tall* — the
slash palette is up to six rows. A single number is either too big for the
common case or too small for the rare one. So the constant is now the **base**
(9, always drawn) and `App.jsx` adds the palette, the disconnected warning and
the "taking a while" note for the frame it is actually about to draw.

**The status bar wrapped, and the measurement is what caught it.** `activeScope`
is a *path* from the state root down to the workspace, so it can be several
segments long — and on the scratch workspace used for the harness it wrapped the
bar onto two rows. A fixed-height instrument with an unbounded field in it. The
scope is now clamped to its last segment, and both halves of the bar truncate
rather than wrap. The old bar had the same field with the same lack of a bound;
it just took a long path to expose it.

**An honest negative.** The conditional-sum budget prevents a frame overflow
that the old constant did not cover — but a control run at the old
`RESERVED_ROWS = 17` with the palette open during a live turn came back **0
clears**, so the bug is reachable in principle and was *not* reproduced. The
reason is that `liveBudget` is a cap on the live turn's rows, not a target: a
turn with few action rows never reaches it. Producing the failure needs a live
turn with many tool rows, which needs a real model reply, which the fake
extension client cannot give. Recorded as unproven rather than fixed.

## How to verify

Not a read-through. The harnesses used are in the session scratchpad
(`measure.py` for the plain frame, `stress.py` for the load-bearing case);
rebuild them from this recipe if they are gone.

1. Run under a pty — `script -q /dev/null <cmd>`, or `pty.fork()`; Ink refuses to
   start without a TTY.
2. **Seed the transcript.** Write turns into `<ws>/.agent/sessions/history.jsonl`
   and start with `--continue`. An empty screen proves nothing: the frame is
   short no matter what the budget says.
3. **Hold a turn open** with a fake extension client — a WebSocket connection
   with a `chrome-extension://` origin that sends
   `{type:'identify', payload:{clientType:'extension'}}` and then never answers.
   `clientType` is the field the bridge reads; `client` silently leaves the
   client as `unknown`, `broadcast('extension', …)` returns false, and the agent
   gives up with "Extension Reconnecting" instead of running. That mistake cost a
   full measurement round.
4. Send escape sequences **one at a time** — `\x1b[B` ×3 in a single write
   arrives as one keypress. Send, sleep ~150ms, drain, repeat.
5. Shadow `open` with a no-op on `PATH`, or the run opens Gemini tabs in the
   user's browser on every iteration.

**The bar: `0` `ESC[2J` and `0` idle bytes in every state.** Measured at 20×80,
24×72, 24×100 and 40×140, in five states each — boot, connected, running,
idle-while-running, and palette-open-while-running. All zero. The single clear on
ctrl+e is deliberate and documented in `App.jsx`: Ink cannot repaint what
`<Static>` has committed, so toggling verbosity reprints the transcript.

## Open questions — the owner's call, not this file's

- **The figlet wordmark.** Kept above on the argument that it is free and it is
  the brand. The alternative is a 3-row compact header, which is more
  conventionally "professional" and loses the only thing that makes the app look
  like itself. Recommendation: keep it, drop the gradient, revisit if it still
  reads as loud in solid accent.
- **Does anything survive as emoji?** The live-frame chrome has none left. The
  boundary drawn was deliberate: emoji in *transcript prose* — `✅ Created skill`,
  `❌ No such command` from the slash commands — were left alone, because that is
  message content on its own line, not an instrument, and it breaks no
  alignment. Whether it should go too is a taste call, not an alignment bug.
- **`vscode-companion/cli-agent-companion-1.3.1.vsix`** is still tracked
  alongside 1.4.0. Raised in `HANDOFF.md`, still undecided — unrelated to the UI,
  noted here so it is not lost.
