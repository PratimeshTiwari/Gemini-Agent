# The GitHub tab — what looks odd, and what to do

Written 2026-09-17, from three screenshots and a reading of
`ui/components/GithubTab.jsx` (396 lines). **Nothing here is built.** It is a
file to decide from, the way `GITHUB-UI-PLAN.md` was — that one was finished
and deleted; this is its successor for the parts the last pass did not reach.

The last pass cut the screen from 11 rows to 5 by removing chrome: no border,
no heading, one status line, hints on one row, `@who commented` instead of a
constant. That was the right work and it is done. What is left is not chrome —
it is that **the activity list does not look like a list of things you can act
on**, which is what the screenshots show.

---

## What the screenshots actually show

```
@PratimeshTiwari  ·  2 PRs  ·  polled 41s ago

Recent activity
  📝 Requires AI Review on PR #15 by @PratimeshTiwari → /Users/pratimesh/Doc…
❯ PR #15  ·  @PratimeshTiwari commented
    💬 test#1 , why there is merge conflict
    → PR-15/comment-5704447693.md

↑↓ move  ·  ⏎ open plan  ·  r refresh  ·  ? more
```

Six problems, each naming its line.

### 1. Two rows say the same event — `:371` and `:355`

`github_notification` and `github_plan_generated` are drawn as separate rows,
and the handler emits **both** for one comment. So every comment produces a
notification row *and* a plan row, one above the other, saying the same thing
in different words with different glyphs. In the screenshot they are adjacent
and it reads as two events.

### 2. ~~An absolute path, truncated from the wrong end~~ — fixed

The notification row carried the full absolute path cut at the *right*, so the
part that identifies it was the part removed. The plan row below it showed
`PR-15/comment-5704447693.md` — short, and **not clickable**: VS Code resolves
a terminal path against the shell's cwd, and those two segments resolve to
nothing, which is why clicking it said "No matching results" while the keyboard
worked.

Now `.agent/github-reviews/PR-15/comment-….md` — relative to the workspace,
so it resolves and becomes a link, and still far shorter than absolute. The
notification row's own copy of the path is problem 1's job to remove.

### 3. Nothing says whether a row has an analysis in it

Fixed in the behaviour — enter now re-runs an unanalysed comment rather than
opening the placeholder — but the row still looks identical either way. The
one thing you want to know before pressing enter is invisible.

### 4. `Recent activity` is a heading over an unbounded list — `:318`

It has no count, no bound, and the list grows to 50 entries in a live frame.
There is no "…and 30 more"; it simply gets taller than the screen.

### 5. Three glyph vocabularies on one screen

`📝` in the notification, `💬` for the body, `→` for the path, `❯` for the
cursor, `·` as the separator. The rest of the product draws in `●`/`○`, `⌁`,
`→` and dim text. Two pictographic glyphs remain in this file.

### 6. The PR list and the activity list look the same

`p` opens the PR explorer, which is a different kind of thing — a list of
*objects* you browse — but it is drawn with the same row shape as the activity
feed, which is a list of *events*. Nothing signals which one you are in except
the hint row.

---

## What I would do

Ordered by how much confusion each removes, not by effort.

### A. One row per event  *(fixes 1 and 2)*

Stop drawing `github_notification` for anything that also produces a
`github_plan_generated`. The notification exists for the side panel and for
things with no plan (errors, "analysis did not run", CI). The tab should draw
the plan row and let the notification through only when there is no plan row to
carry it.

```
❯ PR #15  ·  @alice commented                      ⟳ analysing
    test#1 , why there is merge conflict
    PR-15/comment-5704447693.md
```

Three rows, one event. `−1 row per event`, and the path is the short one.

### B. Say what state the row is in  *(fixes 3)*

One word at the end of the title line, dim, right-aligned in the space that is
already empty:

```
❯ PR #15  ·  @alice commented                       ⟳ analysing
  PR #14  ·  @bob commented                         ⚠ not analysed
  PR #12  ·  CI failed                                 ✓ plan
```

`⟳ analysing` while the queue has it, `⚠ not analysed` when the analysis did
not run, nothing at all when there is a plan — because that is the ordinary
case and does not need saying. Then `⏎` reads as "open" or "run" before you
press it.

`no row change`, and it is the single most useful addition on this list.

### C. Bound the list and say what was cut  *(fixes 4)*

```
Recent activity                                    showing 6 of 23
```

with the list capped at what the frame can afford. The live-frame rule in
`CLAUDE.md` is that every live row is budgeted; this list is the one place in
the tab that can grow without limit.

### D. One glyph vocabulary  *(fixes 5)*

`📝` and `💬` go. The comment body does not need a glyph — indentation already
says it is subordinate — and the event kind is already in the words
(`commented`, `CI failed`).

### E. Give the PR explorer a different shape  *(fixes 6)*

Not a box — the last pass removed the only border in the product for good
reasons, and adding one here would undo that. A **column header** is enough,
because a list of objects has fields and a list of events does not:

```
  PR    branch                  opened      comments
❯ #15   test-pr                 2d ago             3
  #14   fix/bridge-lock         5d ago             0
```

That reads as a table without drawing one, and it is visibly not the activity
feed.

---

## What this is not

- **Not a box around the tab.** The screenshots suggest one, and it is the one
  thing I would argue against: the only box-drawn frame in this product is the
  input field, where the border *means* something (yellow for plan, cyan for
  auto). A second border would make that meaningless, and it costs four rows of
  a live frame that is budgeted to the row.
- **Not colour.** The palette is fine. Every problem above is structure.
- **Not the emoji sweep.** Two glyphs in this file are in scope because they
  are part of the row being redrawn. The other ~100 across the UI are a
  separate decision, deliberately deferred.

## Rows, if A–D are done

```
now      3 rows per event, unbounded list, no state shown
after    3 rows per event, bounded list, state shown, one path not two
```

The saving is not rows — it is that every row means one thing.

---

## The bigger change: make it a screen, not a tab of the transcript

Asked for directly, and the two small fixes above are already pointing at it.
`/github refresh` was writing "Polling GitHub now…" into the **agent's**
transcript — twice, in the screenshot, above a conversation that had nothing to
do with it. That is fixed, but it is a symptom: the GitHub agent is a different
program that happens to share a terminal, and it currently borrows the other
one's surface whenever it has something to say.

### What "its own screen" actually means here

Not a window — there is one terminal. It means: **everything GitHub says
appears on the GitHub screen, and nothing else does.** Three consequences,
each of which is a thing to build:

1. **No GitHub output in the agent transcript, ever.** Command results are
   routed now. `github_notification` still reaches the transcript in one place
   (`ui/hooks/use-github-tab.js` pushes a dim row per event, decided
   2026-09-16) — that stays, because *one dim line* is a notification and a
   polling log is not. The rule: the transcript may learn that something
   happened; it may not carry the detail.
2. **The screen keeps its own scrollback.** Today the activity list is state
   held in a hook and capped at 50. A screen wants history you can scroll —
   the last poll, the one before it, what each produced.
3. **The screen has its own status line.** `@user · 2 PRs · polled 41s ago` is
   already that; it should be pinned, not a row that scrolls with the feed.

### Drawn

```
 ●  github          @PratimeshTiwari · 2 PRs · polled 41s ago        r  refresh

 ┌ PR #15  test-pr ─────────────────────────────────── 2 comments · 1 analysed
 │
 │  @alice                                                       ⚠ not analysed
 │    test#1 , why there is merge conflict
 │    .agent/github-reviews/PR-15/comment-5704447693.md
 │
 │  @bob                                                                 ✓ plan
 │    the watermark only moves when something was found — is that right?
 │    .agent/github-reviews/PR-15/comment-5704447694.md
 │
 └ PR #14  fix/bridge-lock ──────────────────────────── 0 comments · CI failing

 ⟳ Polling GitHub now…

 ↑↓ move   ⏎ open or analyse   r refresh   ^o back to the agent
```

**Grouped by PR**, which is the thing people hold in their head. Today every
comment is a flat row and the PR number is repeated on each one; a reviewer
thread is a conversation about a PR, so the PR is the container.

The left rule (`│`) is not a box — it is the same device the transcript
already uses for a tool call, so it reads as "this belongs to the thing above"
without adding a frame. This is the one place I would push back on the
screenshots: a full border here would be the second box-drawn frame in the
product and would make the input field's border stop meaning the mode.

### The comment body, on a background

Asked for: *"maybe the comment with a background similar to user message
background"*. Agreed, and it is the right instinct — the comment is the one
piece of text on the screen written by a **person**, exactly like the user's
own message in the transcript, and that surface already has a treatment for
"a human said this".

`ui/format.js`'s `blockLines(text, width, indent)` is what draws the user's
message bar. It wraps and pads each line so Ink's `backgroundColor` paints a
solid bar rather than a ragged highlight — the reason it exists is that Ink
colours *characters*, not lines. Reusing it here means the two "a person wrote
this" surfaces are drawn by one function.

Indented under its author, not full width: a PR comment is subordinate to the
PR, where the user's own message is top-level.

### Cost

`blockLines` already exists, `KeyHints` already exists, and the status line is
already drawn. The work is the grouping (flat list → PR → comments) and the
scrollback, which is where the real effort is: the live-frame rule means the
list has to be windowed rather than simply rendered, the way the transcript is.

### What I would not do

- **A box around the whole screen.** As above — it costs four rows of a
  budgeted live frame and devalues the one border that means something.
- **Colour per state.** `⚠` and `✓` carry it; colouring rows as well is the
  thing the last pass removed from this file.
- **A second scroll model.** Whatever windows this list should be the same
  approach the transcript uses, or there are two ways to scroll in one product.

---

## Open question

**Should the activity feed and the PR explorer be one screen?** Today `^o`
opens activity and `p` switches to PRs. They answer different questions ("what
happened?" vs "what is open?"), and the second is the one people go looking for
when the first is empty. Merging them means a mode switch inside one list;
keeping them means two screens to learn. I lean towards keeping them and
fixing E, but it is a product call rather than a layout one.
