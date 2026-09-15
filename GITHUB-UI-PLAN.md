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

Border, title, status, blank, activity heading, empty line, blank, seven hints
— **13 rows to tell you there is nothing to look at.**

---

## What I would do

Ordered by how much they buy against how much they change. **1–3 are the ones I
would do whatever else you pick.**

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

### 5. Consider: is it a tab at all?

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
command does, offered rather than inserted.

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
now      13 rows to say nothing is happening
after     4 rows
```

