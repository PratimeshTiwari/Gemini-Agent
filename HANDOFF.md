# Handoff — for the next session

Written 2026-09-16, end of the second session that day. **Delete this file once
the work below is done** — it is a baton, not documentation. `CLAUDE.md` is the
architecture and the reasoning; `README.md` has the release history; `AGENT.md`
is what the agent is told about this project; `TEST.md` (untracked) is the
manual run.

---

## State

- Branch `v1-stable`, tree clean, nothing unpushed. `npm test` green on both
  workspaces — it prints the counts, and a count written into a file here does
  not stay true (see below).
- **`main` is behind by everything on this branch and the merge is still a
  clean fast-forward.** The owner has said the PR is theirs; do not open it.
  `git rev-list --left-right --count main...v1-stable` prints `0	<n>`; the `0`
  on the left is the whole claim.
- **`v1-stable` has no upstream tracking ref locally**, though `origin/v1-stable`
  exists and matches HEAD. Nothing is unpushed; `git status` just cannot say so.
  One command if it is annoying: `git branch --set-upstream-to=origin/v1-stable`.

---

## What landed today, after the last handoff

**1. Three documents disagreed about one number.** README said the branch was
113 commits ahead, this file said 121 in two places, `TEST.md` said 118. It was
142. All four now print
`git rev-list --left-right --count main...v1-stable` instead of a figure.
This file already carried the instruction to check rather than trust a number
and was itself wrong two lines later, which is the argument: *do not write a
derived number into prose here.* The same applies to the test counts, which is
why they are not written above.

**2. Nested lists, wrong in three places at once.** A numbered list with
sub-points is how Gemini explains anything, and every layer mangled it. Found
with a round-trip probe — markdown → HTML → scrape → markdown, compared by
meaning — which scored 11/15 before and 15/15 after.

- The **scrape** indented continuation lines by a constant two spaces. A nested
  list has to reach its parent item's *content* column: `- ` is two, `1. ` is
  three, `10. ` is four. Two under a `1. ` parent falls below the column, so
  the item closed and the sublist reopened as a sibling — flat. Loose items
  (`<li><p>…`) also broke straight after the marker, orphaning their own body.
  **The existing test asserted the two-space indent, so it was pinning the bug.**
- **`marked-terminal`'s list renderer is line-based** and cannot tell a child's
  marker from its own, so an ordered list renumbered its children and kept
  counting — one counter, two wrong columns. Replaced with a token walk in
  `ui/format.js`, which cannot have the bug.
- **Two fence regexes were anchored at column 0**, and a fence inside a list
  item is indented — which the first fix turns from a curiosity into normal
  output. `_extractToolCalls` missed its clean path and fell through to the
  brace matcher, which finds the JSON but cannot know the backticks belonged to
  it, leaving a bare ``` on screen. `format.js`'s `FENCE` missed them too, so
  those blocks lost their rules and `ctrl+y` could not see them.

The probe is kept as a test (`extension/test/content-scripts/markdown-roundtrip.test.js`).
The fixtures pin the DOM shapes the two sites emit; the probe pins the general
property, which is the half that catches a construct nobody wrote a fixture for.

---

## Asked and answered today — do not re-derive

**"Should we instruct Gemini to reply in a structured format, the way we do for
tool calls and questions?"** Measured rather than argued, and the answer is no
for prose — with one exception already taken.

The site renders the model's markdown into HTML and we scrape the HTML back.
So an instruction to "reply in structure X" still passes through that renderer
and arrives as HTML like everything else. **The one exception is a fenced code
block, which the site does not render** — it stays verbatim in `<pre><code>`.
That is the entire reason tool calls are reliable and prose is reconstruction,
and it is a property of the channel, not of the prompt.

Which splits the reply in two:

| | today | structure would buy |
| --- | --- | --- |
| what we **parse** (tool calls, questions) | already fenced JSON | nothing — it is already taken |
| what we **display** (prose, lists, tables) | reconstructed from the DOM | exactness, at a real price |

And after today the reconstruction is 15/15 on the round trip. The four losses
were our own indent bug, not the channel.

The price of an envelope, for the record: the browser tab stops being readable
to the person watching it (a supported surface); `gemini_response_stream` can
no longer render live, because JSON cannot be drawn until it closes and parses;
every reply becomes as fragile as `_cleanJsonString` already is, since prose is
exactly what escaping gets wrong; and it is more text typed into a browser every
turn, against a prompt strategy that exists to avoid that.

The three drift detectors look like candidates and are not: a provider error is
Gemini's own error page rather than model output, and a model confused enough to
deny its own tools will not emit a correct marker saying so.

**What is worth doing instead, if this comes back:** a short output-contract
line in the prompt asking for the constructs the renderer handles best. It costs
a few tokens, changes no plumbing, and makes the DOM more regular. Not done —
there was no measured loss left to justify it.

---

## The gate, still: `TEST.md`

**`TEST.md` in the repo root is untracked and is the actual work.** Setup and §1
gate everything below them. Nothing in it has run against a real browser.

Before anything: **reload the extension, hard-refresh the Gemini tab, reinstall
`cli-agent-companion-1.5.0.vsix`.** Chrome is otherwise running an old bundle
and the symptom is the agent going quiet rather than an error. Content scripts
are *not* bundled and need only the hard refresh — which is what today's fix
ships in, so it will not be visible without one.

The sections most likely to find something, least proven first:

- **§6a nested lists — new today, and the whole point.** Put the Gemini tab and
  the terminal side by side and ask for steps with sub-points. Everything above
  was verified against jsdom and `marked`, never against what Gemini's DOM
  actually emits, and the site's renderer is not `marked`.
- **§4 batch tab continuity** — a failure path that has never fired. Close the
  background tab mid-analysis and check it recovers.
- **§5 `/effort` switching the browser** — parked weeks ago, never once run
  against a real tab.
- **§10 the task checklist** — the bug reported from use. Does it tick now.

**§1 still has a blank to fill in: the extension connect time.** It is the one
measurement that could not be taken here and it decides real work. Headless
Chrome read exactly 30.0s steady state, which is the `chrome.alarms` clamp
floor — but headless reclaims service workers harder than a real browser, so
that is a lower bound, not a verdict. If a real browser also reads ~30s, the
reconnect needs an **offscreen document** and that is the next real build. Under
a second means the work is already done and the measurement was lying.

If something in §2–§11 fails, that outranks everything else in this file. Four
of the better fixes came from the owner running it and reporting what broke; the
task-checklist bug in particular was invisible from the inside.

---

## Real work that is waiting, in order

**1. `/update` has still never run against a real merge.** Everything shipped:
the background check 1.5s after mount, the refusal on a dirty tree, the restart
through the supervisor, the reload checklist derived from `git diff --name-only`
so it names only the surfaces that moved, and the `~/.agent/pending-reload.json`
that survives until `/update done`. Test it the first time you merge to `main`
and pull. It is also what makes the four-step setup ritual at the top of
`TEST.md` unnecessary, which is the reason it exists.

**2. Image pasting — built, verified, never wired.** `ui/clipboard-image.js`
reads a PNG off the clipboard and produces the marker; it has **no importers**,
so it is the write-only trap in its other direction: a writer with no caller.
The blocker is the trigger, not the code. `ctrl+v` is bound, but macOS users
press `Cmd+V` and the terminal consumes it. The plan was to hook an *empty*
bracketed paste — the terminal reports a paste with no text, which is what a
clipboard holding only an image looks like. Untested.

**3. The side panel drops three message types the server sends.**
`response_stream`, `github_processing_started`, `github_processing_finished`
reach `socket.js`'s `default:` branch and are discarded, so the panel never
shows streaming text or GitHub activity and every streamed chunk crosses the
socket to be thrown away. Recorded in `CLAUDE.md` as an *incomplete surface*
rather than dead code, deliberately: deleting the sends removes a panel feature,
adding handlers is one. The panel is a supported front-end.

**4. The PR agent should pick its own effort from the comment.** Asked for
explicitly and not yet designed. The constraint found while looking: `switch_model`
routes through `sendToModelTab` → `pickMainTab`, which is *the user's* tab — so a
batch task that changes effort changes the model the person is using. It needs
the lane threaded through first, the same shape as handoff item 6.

**5. `GITHUB-UI-PLAN.md` fix 6 is waiting on a decision.** The file is tracked
and has the mockups; fixes 1–5 are drawn and costed, and fix 6 (tab-or-stream)
is a product call that was put to the owner and not answered.

**6. `/logs rates` needs a week of use, not work.** All zeros today —
`errors.jsonl` has a handful of lines and `traces.jsonl` does not exist. Two
open questions depend on it: whether `REFRESH_INTERVAL_MESSAGES = 20` is right,
and whether `multiple_drafts` has ever fired at all.

**7. The batch task could hold its tab across *models*, not just turns.**
`_executeSubagent('gemini', …)` is hard-coded in `runHeadlessTask`, so a batch
task runs on Gemini whatever `modelConfig` says. Deliberate — nothing else has
been exercised on that path — and the obvious next step if ChatGPT becomes a
real background option.

**8. `/skills` has never been examined.** Reachable and aligned; the *shape* was
never looked at. `/skills dir` prints a four-entry search path, `skillFolders`
is an escape hatch from config, creating one opens an editor. An open question,
not a bug list. Lowest priority, and the only item with no evidence behind it.

---

## Decisions already made — do not re-litigate

- **The PR into `main` is the owner's.** Said explicitly, twice.
- **No reply envelope.** Argued from a measurement today; see above.
- **Collapsing the two bridges is declined.** The jsdom tests run against both,
  so a scraping divergence fails the build.
- **No embedding index.** Argued from the architecture in `CLAUDE.md`; the
  symbol index is the part that was worth building.
- **The jitter's second half is not happening** — ~20% of the live frame for the
  seam that brought the scroll glitches back twice.
- **Terminal failures are opt-in per terminal**, chosen over an age filter.
- **Code blocks are drawn flush left, never indented** — even inside a list
  item, where the markdown they came from was indented. There is no copy button
  and there cannot be (it needs mouse tracking, which kills drag-select), so a
  drag-select has to yield the code and nothing else.
- **The emoji sweep is not happening.** ~100 glyphs across 16 files were changed
  and reverted: the only real complaint was the tick on a dark background, which
  is now `✔`. Do not re-run the sweep.
- **An API backend stays a fork**, not a plan.

---

## Things that will waste your time if you do not know them

- **A test can pin the bug.** Today's list-indent fix failed two tests that
  asserted the broken two-space indent. A test written from observed output
  describes what the code does, which is not the same as what it should do —
  and it will defend the bug.
- **Check any tool you write before believing it.** The dead-code audit produced
  four false positives, each the same mistake: static analysis of a dynamic
  language. Names matched inside comments; `find_references` correctly ignoring
  member expressions made `paths.*` look dead; an import graph could not see
  manifest- and HTML-loaded files; literal class matching missed
  `` `message-${role}` ``. Nothing was deleted on any of them.
- **A passing test lies the same way.** `toolCatalogDrift()` compared an empty
  registry to an empty catalog and went green. Negative controls per branch, or
  the pass means nothing.
- **Do not write a derived number into a document here.** Commit counts and test
  counts both drifted within a day. Print the command instead.
- **`extension/service-worker.js` is a committed build artifact.** Editing
  `extension/src/background/` without `npm run build --workspace=extension`
  ships nothing. Content scripts are *not* bundled and need only a reload — so a
  content-script fix looks like it did nothing until the tab is hard-refreshed.
- **The pty harness recipe is in `CLAUDE.md` → Commands → The pty harness.** It
  lives in a session scratchpad, so that recipe is the only copy.
