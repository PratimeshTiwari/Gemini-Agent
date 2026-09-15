# The GitHub tab — what is wrong with it, and what to do

Written 2026-09-17 from the screenshot and from `ui/components/GithubTab.jsx`
(301 lines). **Nothing here is built.** It is for you to pick from; delete the
file once it is decided.

Every claim below names the line that causes it, so you can check rather than
take my word for it.

---

## The one idea

**It is a page, and everything else in this app is a stream.**

The rest of the CLI settled on a shape: settled turns flow into scrollback, one
short status line at the bottom, no borders, no titles, colour used to mean
something rather than to decorate. `UI-REDESIGN.md`'s round one took the chrome
from seventeen rows to one on exactly that argument.

The GitHub tab never had that pass. It is a bordered card with its own heading,
its own status line, its own key hints and its own empty state — sitting inside
an app that already has a status line and already tells you which tab you are
on. Almost everything below follows from that.

---

## What it looks like now, and what it could

Drawn at 78 columns, which is a narrow-but-ordinary terminal. Row counts are of
the dashboard itself — the app's own status bar sits below all of these and is
not counted.

### Now — the empty state, which is what you see most

```
┌────────────────────────────────────────────────────────────────────────────┐
│ GitHub PR dashboard                                                        │
│                                                                            │
│ connecting…  ·  token ok  ·  0 PRs watched  ·  CI watch on  ·  polled neve │
│                                                                            │
│ Recent activity                                                            │
│ Nothing yet — waiting for PR comments or CI runs.                          │
│                                                                            │
│ ↑↓ move · space expand · ⏎ open plan · a avoid words · p PRs               │
│   · r refresh · ^o agent                                                   │
└────────────────────────────────────────────────────────────────────────────┘
● github  ·  agent ^o  ·  /help                    plan ⇥  ·  DEEP  ·  0% of 96k
```

**11 rows**, of which one is content. The status line is already being cut off
at this width. The hints wrap and leave a `·` stranded at the start of a row.

### After — the same state

```
connecting…

Nothing yet — waiting for PR comments or CI runs.

↑↓ move  ·  ⏎ open plan  ·  r refresh  ·  ? more
```

**5 rows.** No border, no title (the status bar below already says `● github`),
no heading over an empty list, and the fields that are only saying "still the
default" are gone until they are not.

### After — once it is actually doing something

```
@pratimesh  ·  3 PRs  ·  polled 2m ago
Analysing @alice on PR #42  ·  queue 1

❯ PR #42  ·  @alice commented
    💬 Please rename this variable to something clearer…
    → PR-42/comment-9.md
  PR #41  ·  CI failed on build
    → PR-41/ci-1788.md

↑↓ move  ·  ⏎ open plan  ·  r refresh  ·  ? more
```

Who said it, not what a classifier called it — see problem 8. "plan generated"
went too: every row in this list is a plan, so saying so on each one is the
same kind of constant.

Identity first, because "0 PRs watched" reads very differently once you can see
it is watching as the wrong account — which is the reasoning `getStatus()`
already has for reporting `username` at all.

### After — when it needs you

The one case that should be loud, and currently is not:

```
! GitHub rejected the stored token  ·  /github remove-token to clear it

↑↓ move  ·  ⏎ open plan  ·  r refresh  ·  ? more
```

---

## What is actually wrong

### 1. A border nothing else has — `GithubTab.jsx:35`

```jsx
<Box borderStyle="single" borderColor="cyan" paddingX={1} width="100%">
```

The only box-drawn frame in the product apart from the input field, and the
input's border *means* something — it is the mode, yellow for plan and cyan for
auto. A cyan frame around the dashboard says nothing and reads, at a glance,
like the prompt has grown to fill the screen.

It also costs **4 rows** (two border, two padding) of a live frame the rest of
the app budgets to the row.

### 2. A title for the thing you just navigated to — `:36`

```jsx
<Text bold color="cyan">GitHub PR dashboard</Text>
```

You arrive here by pressing `^o`, and the status bar already reads `● github`.
The heading tells you where you are after you knew.

### 3. Two status bars on screen at once

The screenshot shows `● agent · github ^o · /help … plan ⇥ · DEEP · 0% of 96k`
**and** `● github · agent ^o · /help …` — the app's status bar plus the
dashboard's own header. Same information, twice, four rows apart.

### 4. Five fields crammed into one line, none of them ranked

```
connecting…  ·  token ok  ·  0 PRs watched  ·  CI watch on  ·  polled never
```

Everything is the same weight, so nothing is. Two of them contradict each other
at a glance — "token ok" next to "connecting…" — and two are almost never
interesting: `CI watch on` is the default, and `polled never` is only news for
the first thirty seconds of a session.

### 5. A heading over an empty list — `:256`

```
Recent activity
Nothing yet — waiting for PR comments or CI runs.
```

Two rows to say nothing is happening, plus a blank line above them. The empty
state carries the same chrome as a full one.

### 6. The key hints wrap, and the wrap is ugly — `:288`

Seven hints, and at this width they break mid-list leaving a dangling separator
at the start of the second row:

```
↑↓ move · space expand · ⏎ open plan · a avoid words · p PRs
  · r refresh · ^o agent
```

`KeyHints` uses `flexWrap="wrap"`, which knows nothing about the separators it
is wrapping between.

### 7. It is permanently as tall as its busiest state

Border, title, blank, status, blank, activity heading, empty line, blank, and
seven hints over two rows — **11 rows to tell you there is nothing to look
at**, one of which is the sentence saying so.

### 8. The row shows a label that is always the same word, and hides the one that matters

```
❯ PR #42 — plan generated  ·  requires_review
```

`requires_review` is not a judgement. It is the **only** non-noise value the
classifier can return (`comment-classifier.js:51`), and anything it calls noise
is dropped before a plan is ever written — so on a comment row that word is a
constant. `websocket-server.js:441` is
`data.classification?.category || data.type`, which for CI falls back to
`ci_failure`: one real bit, better said as "CI failed" in the row's own words.

Meanwhile **the author is already in the payload** (`comment: data.comment`)
and is not shown. "@alice commented" is the thing you scan this list for; "a
comment happened, and it was not noise" is not.

**And there is no LLM verdict to show instead.** The classifier deliberately
stopped categorising when the AI took that over — `comment-classifier.js`'s own
header says so — and what the AI produces is the plan itself, not a label.
Inventing a category to display would be a second classifier, which is the
thing that was removed. The right answer is the author and the comment, both of
which are already there.

---

## What I would do

Ordered by how much they buy against how much they change. **1–5 are the ones
I would do whatever else you pick** — none of them depends on the answer to 6.

### 1. Drop the border and the title — `−5 rows`

The status bar already says `● github`. Nothing else in the app frames itself.

### 2. One status line, ranked, with the quiet parts silent — `−0 rows, −2 fields`

Only say what is not the default. `CI watch on` and `polled never` disappear
once they are unremarkable, the way the status bar already hides `0 pastes`:

```
connecting…                             ← while connecting
@pratimesh · 3 PRs · polled 2m ago      ← the ordinary state
! token rejected · /github remove-token ← when it needs you
```

Identity first, because "0 PRs watched" reads very differently once you can see
it is watching as the wrong account — the reasoning `getStatus()` already has
for reporting `username`.

### 3. Let the empty state be one line — `−3 rows`

No heading, no blank lines:

```
Nothing yet — waiting for PR comments or CI runs.
```

The heading earns its place only when there is a list under it.

### 4. Hints on one row, in the app's own idiom — `−1 row`

Seven is too many for one line at 80 columns. The transcript solved this
already: `/help` lists every binding, and the status bar carries only what is
live. Keep `↑↓ ⏎ r` here and let `?` or `/help` hold the rest.

### 5. Show who commented; drop `requires_review` — `no row change`

Both are already in the payload. `@alice commented` replaces a word that is
the same on every row, and "plan generated" goes with it — every row in this
list *is* a plan.

### 6. Consider: is it a tab at all?

The bigger question, and the reason to decide before building. This is a
**stream of events** — a comment arrived, a plan was written, CI failed — and
the app already has a very good stream: the transcript. A dedicated tab exists
because those events would otherwise interleave with your turns.

Two honest options:

| | keep the tab | fold into the transcript |
| --- | --- | --- |
| **what it costs** | a second surface to design and maintain | events interleave with your work |
| **what it buys** | GitHub activity stays out of your way | one place to look, no `^o`, no second status bar |
| **fits the app?** | no — nothing else is a page | yes — everything else is a stream |

A middle path: keep the tab for *browsing* (PR explorer, plans), and let new
activity arrive in the transcript as one dim line — the way a failed terminal
command does, offered rather than inserted. Drawn, because this is the part
worth looking at before deciding:

```
 ❯ why is the poller re-reading comments?

 ● Because the watermark only moves when something was found — otherwise a
   poll that returns nothing could skip a comment written during it.

   ⌁ PR #42 · @alice commented — plan written    ^o to look
                                                                    ← one dim
 ❯ show me the plan                                                   row, here
```

One row, dim, in the flow you are already reading, and `^o` still opens the
tab when you want the detail. Nothing interrupts, nothing is inserted into
your prompt, and there is no second status bar to keep in sync.

The cost is honest too: on a busy repo that row appears often, and it appears
*between* your turns rather than in a place you chose to look.

**This one needs you.** It is the difference between tidying a screen and
deciding the feature's shape.

---

## What this is not

- **Not a colour pass.** The palette is fine; the problem is structure.
- **Not the emoji sweep.** `GithubTab.jsx` has 13 of the ~100 pictographic
  glyphs across the UI. Worth doing, separately, as one decision.
- **Not the GitHub agent itself.** `github/` was restructured and tested; this
  is only what it looks like.

## Rows, if 1–4 are done

```
now      11 rows to say nothing is happening, one of them content
after      5 rows
```

Counted from the drawings above, at 78 columns. The app's own status bar is
below all of them and unchanged.

