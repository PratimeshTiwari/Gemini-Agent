# The GitHub tab — what looks odd, and what to do

> **Status, 2026-09-17:** fixes 1–3 and the grouped screen are **built**. What
> remains is the scrollback (the list is windowed but does not scroll), the PR
> explorer's shape (fix E), and the open question at the bottom.

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

### 1. ~~Two rows say the same event~~ — fixed — `:371` and `:355`

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

### 3. ~~Nothing says whether a row has an analysis in it~~ — fixed

Fixed in the behaviour — enter now re-runs an unanalysed comment rather than
opening the placeholder — but the row still looks identical either way. The
one thing you want to know before pressing enter is invisible.

### 4. ~~`Recent activity` is a heading over an unbounded list~~ — fixed — `:318`

It has no count, no bound, and the list grows to 50 entries in a live frame.
There is no "…and 30 more"; it simply gets taller than the screen.

### 5. ~~Three glyph vocabularies on one screen~~ — fixed

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

---

# Round 2 — "this github one is a mess"

Three more screenshots, 2026-09-17. The agent screen, the GitHub dashboard, and
the PR explorer. The question asked with them: *should we have a separate screen
entirely for GitHub, or what?*

**Short answer: yes — and "screen" should mean it fills the terminal, not that
it becomes a second program.** That costs almost nothing, because the budget is
already granted and simply not spent. The rest of the mess is four faults below.

## What the screenshots show

### 7. Three rows of GitHub under nine rows of the agent's logo

The dashboard renders `@PratimeshTiwari · 2 PRs · polled 22s ago` and *"Nothing
yet"*. Two rows. Above them sits the figlet banner, the byline and the workspace
path — nine rows of a different screen.

The banner is a `<Static>` item (`App.jsx:805`). Ink commits Static output to the
terminal permanently and never repaints it, so **it cannot be removed on a tab
switch** — and must not be attempted: remounting `<Static>` reprints the whole
transcript, which is where the double banner came from (`App.jsx:812-818` records
that bug).

It does not need removing. It needs **pushing off**. `GithubTab` is already handed
`maxRows = terminalHeight - 8` (`App.jsx:840`) and renders three rows into it. A
screen that fills its budget scrolls the banner into scrollback by itself, on the
first frame, with no clear and no remount.

This is the whole of "a separate screen", and it is why the alternatives are not
needed:

| option | verdict |
| --- | --- |
| fill the granted budget | **this one.** No new machinery, no clear, no Static remount. |
| `ESC[2J` on switch | a second deliberate clear; `3J` would delete the transcript's scrollback, and without `3J` Static still will not reprint |
| alternate screen buffer (`?1049h`) | what vim/less do, and genuinely a separate screen — but it needs a second Ink instance sharing one raw-mode stdin, and it throws away native scroll inside the tab. Real cost, for something filling the budget already achieves. |

### 8. The one screen everybody lands on is the only one with no key hints

`Activity` draws the status line, the groups, the trimmed-count and a notice —
and **no `KeyHints` row at all**. Every other view has one (`:134`, `:159`,
`:198`, `:274`, `:300`).

So from the dashboard, `p` (browse PRs), `r` (poll now), `a` (avoid words) and
`?` (everything else) are all invisible. `?` is handled at
`use-github-keys.js:128` and its comment says *"a shortcut nobody can discover is
a shortcut nobody uses"* — which is exactly what happened, because the only place
`?` is advertised is inside the help screen it opens.

**That is the `shift+?` report.** It is not missing; it is unannounced.

### 9. `⏎` means three different things

| view | what Enter does |
| --- | --- |
| dashboard | run the analysis, or open the plan |
| PR explorer | open this PR's comments |
| comments | send the comment to the agent |

Three screens, one key, three verbs, and the hint row is the only thing that
says which — on the two screens that have a hint row.

### 10. The repo name on every row

`[Gemini-Agent] #16 …` / `[Gemini-Agent] #15 test`. This is the same fault already
fixed one level down, where the PR number was repeated on every comment: **the
container is written once, not on each row.** With a single repo it is pure noise
in the 12 columns the title most needs.

## The design: one list, three levels, one row of chrome at each end

The recorded decision is *"the tab is for browsing; the stream is for noticing"*.
The tab currently does both, and that is the mess — the dashboard is a feed, the
explorer is a browser, they overlap, and you land on the feed.

**So delete the activity feed as a view.** Every event already arrives in the
transcript as one dim row, which is the noticing half. What the tab owes you is
the browsing half, and browsing is a drill-down:

```
  PRs  ─⏎→  comments on one PR  ─⏎→  the analysis, in your editor
       ←esc                     ←esc
```

One mental model, one meaning for Enter at each level ("go deeper"), one for
escape ("come back"), and nothing to learn.

### Level 1 — the PRs

```
@PratimeshTiwari · 2 PRs · polled 48s ago                         Gemini-Agent

❯ #16  fix(github): a review without an analysis is not a plan…
       3 comments · ⚠ 1 not analysed · 2h ago

  #15  test
       no comments


  ↑↓ move · ⏎ comments · r refresh · ? keys · ^o agent
```

Repo once, on the right of the status line. Title gets the full width. The second
line is why you would open it — which is the thing the current row cannot say at
all.

### Level 2 — one PR's comments

```
@PratimeshTiwari · #16 fix(github): a review without an analysis…

❯ @PratimeshTiwari                                       ⚠ not analysed
  ▌ can you check the retry path here? it looks like it swallows
  ▌ the second failure
    .agent/github-reviews/PR-16/comment-2451.md

  @someone-else                                                 ✓
  ▌ lgtm


  ↑↓ move · ⏎ analyse · o open plan · esc back · ? keys
```

The comment stays on its bar (`blockLines`) — that decision holds, and it is the
one thing on the screen a person wrote. `⏎` is one verb again: *analyse*. Opening
the file moves to `o`, which is what it is everywhere else in this product.

### The chrome rule

**One row at the top, one row at the bottom, pinned.** The hint row is the last
line of the budget, not a `<KeyHints>` floating after however much content there
happened to be. That is the second reason to fill the budget: the hints stop
moving, so your eye learns where they are.

Every hint row ends with `?` — it is the escape hatch for the four bindings the
row cannot fit, and it has to be on the row it is an escape hatch *from*.

## Rows

At 40 rows the tab gets 32. One status line, one blank, one hint line, one blank:
**28 rows of content**, against three today. At 13 rows it gets 6: status, hints,
and four rows of list — still a usable browser, and the spacing goes first, which
is the rule the main frame already follows.

## What I would not do

- **No box.** Unchanged from round 1: the only box-drawn frame in this product is
  the input field, where the border *means* the mode. A second one makes that
  meaningless and costs four rows.
- **No alternate screen buffer.** Argued above — real cost, and filling the
  budget already gets the banner off the screen.
- **No second scroll model.** Unchanged from round 1.
- **Nothing for the agent screen's empty space.** *"This is a very shorted ui"* is
  Ink drawing at the cursor and growing downward; the strip fills as you talk, and
  the transcript belongs in scrollback rather than in a padded frame. Filling the
  height is right for a browser and wrong for a stream — that is the difference
  between the two tabs, not an inconsistency to iron out.

## Order

1. Hint row on the dashboard, with `?` on it — one line, fixes the reported bug.
2. Fill the budget, pin the hints to the bottom — the banner leaves.
3. Collapse the dashboard into the PR list; `⏎` means "go deeper" everywhere.
4. Repo name once; the PR row gets its second line.
