# UI redesign

Written 2026-09-11. A plan, not a change — nothing here is built yet.

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
- **The byline joins the dim orientation line.** It is not a peer of the
  wordmark.

```
  ██████╗  ██████╗██╗  ██╗  ...          ← accent, solid
  Pratimesh Tiwari · ~/Documents/Gemini-Agent · gemini · plan
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

| | now | after |
| --- | --- | --- |
| mode chip + its blank row | 2 | 0 |
| keyhints row | 1 | 0 |
| `borderTopStyle` rule | 1 | 0 |
| **`RESERVED_ROWS`** | **17** | **~13** |
| transcript on a 24-row terminal | 7 rows | 11 rows (**+57%**) |

The `~13` is an estimate and must be **measured, not asserted** — that is the
whole lesson of `RESERVED_ROWS`. Undershooting it brings the clear-and-repaint
bug straight back.

---

## Work items

Ordered by ratio of result to risk. Each is independently shippable.

| # | item | touches | risk |
| --- | --- | --- | --- |
| 1 | Route mid-session `console.*` through `error-log.js` / a system row | 7 files, ~24 call sites | low — pure bug fix |
| 2 | Collapse the palette to five roles; delete magenta, blue, gradient | `components/*.jsx`, `App.jsx` | low |
| 3 | Replace emoji with single-width glyphs | `App.jsx`, `InputBar.jsx`, `Menus.jsx` | low — fixes alignment |
| 4 | Mode onto the input border; delete the chip | `InputBar.jsx` | medium — frame budget |
| 5 | Status bar to one row, fixed columns, one context number | `App.jsx`, `KeyHints.jsx` | medium — frame budget |
| 6 | Keyhints behind `?` | `App.jsx`, `use-key-bindings.js` | low |
| 7 | Lower `RESERVED_ROWS`, **measured** | `constants.js` | **high — this is the bug** |
| 8 | Header: solid wordmark, byline demoted | `Banner.jsx` | low |

**Do 7 last, and only from a measurement.** Items 4–6 remove rows; the constant
must follow the measurement rather than lead it.

---

## How to verify

Not a read-through. From `CLAUDE.md` and the previous session's notes:

1. Run under a pty — `script -q /dev/null <cmd>`; Ink refuses to start without a
   TTY.
2. Connect a **fake extension client** over the WebSocket with a
   `chrome-extension://` origin and never answer. That is the only way to make
   the agent hold a running turn with no browser, and it is how the running-line
   animation was measured.
3. Send escape sequences **one at a time** — `\x1b[B` ×3 in a single write
   arrives as one keypress. Send, sleep ~150ms, drain, repeat.
4. The acceptance bar, unchanged: **`0` `ESC[2J` and `0` idle bytes** from every
   screen, at 24 rows and at 72 columns. Every screen added last session was
   measured this way; anything that regresses it is not done.

---

## Open questions — the owner's call, not this file's

- **The figlet wordmark.** Kept above on the argument that it is free and it is
  the brand. The alternative is a 3-row compact header, which is more
  conventionally "professional" and loses the only thing that makes the app look
  like itself. Recommendation: keep it, drop the gradient, revisit if it still
  reads as loud in solid accent.
- **Does anything survive as emoji?** A single wordmark glyph is defensible; a
  status bar full of them is not.
- **`vscode-companion/cli-agent-companion-1.3.1.vsix`** is still tracked
  alongside 1.4.0. Raised in `HANDOFF.md`, still undecided — unrelated to the UI,
  noted here so it is not lost.
