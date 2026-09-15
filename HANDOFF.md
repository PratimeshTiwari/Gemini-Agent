# Handoff — for the next session

Written 2026-09-16 after a long session. **Delete this file once the work below
is done** — it is a baton, not documentation. `CLAUDE.md` is the architecture
and the reasoning; `README.md` has the release history; `AGENT.md` is what the
agent is told about this project.

---

## State

- Branch `v1-stable`, tree clean, nothing unpushed.
- **`main` is 121 commits behind and still a clean fast-forward.** The owner has
  said the PR is theirs; do not open it.
- `npm test`: **921 server + 37 extension**, all green.
- Every plan file that used to live here is finished and gone. There is no
  backlog document any more, and nothing was dropped to achieve that.

---

## The one thing that gates everything: `TEST.md`

**`TEST.md` in the repo root is untracked and is tomorrow's actual work.**
Eleven sections of manual flows, ordered so setup and §1 gate the rest.

Nothing below §1 means anything until the bridge connects, and **a large amount
of this session's work has never run in a real browser** — only against a
stubbed `chrome` and a fake extension. The 37 extension tests catch logic
errors; they cannot catch "gemini.google.com changed its DOM" or "Chrome
reclaimed the tab differently than we assumed".

Before anything: **reload the extension, hard-refresh the Gemini tab, reinstall
`cli-agent-companion-1.5.0.vsix`.** Chrome is otherwise running yesterday's
bundle and the symptom is the agent going quiet rather than an error.

The three sections most likely to find something, because they are the least
proven:

- **§4 batch tab continuity** — built yesterday, including a failure path that
  has never fired. Close the background tab mid-analysis and check it recovers.
- **§5 `/effort` switching the browser** — parked weeks ago, never once run
  against a real Gemini tab.
- **§10 the task checklist** — the bug reported from use. Does it actually tick
  now.

**§1 has a blank to fill in: the extension connect time.** It is the one
measurement that could not be taken here, and it decides real work — see below.

---

## What to do with the results

### If §1 reads ~30 seconds

The reconnect needs an **offscreen document**, and that is the next real build.
Headless Chrome measured exactly 30.0s steady state, which is the
`chrome.alarms` clamp floor — but headless reclaims service workers harder than
a real browser, so that number is a lower bound and not a verdict. A real
browser reading under a second means the work is already done and the
measurement was lying.

### If something in §2–§11 fails

That is the best possible outcome and takes priority over everything else in
this file. Four of yesterday's better fixes came from the owner running it and
reporting what broke — the task-checklist bug in particular was invisible from
the inside.

`/logs` and `/logs extension` usually have the detail. `/logs extension` saying
nothing at all, where you expected an entry, almost always means the hard
refresh was missed.

### If it all passes

Merge `v1-stable` into `main` — 121 commits, still a clean fast-forward. That
number only stays free while nothing lands on `main`.

---

## Real work that is waiting, in order

**1. `/update` — built 2026-09-16, needs one real-world run.**
Everything described below shipped: the background check (1.5s after mount,
never on the startup path), `/update` refusing on a dirty tree and restarting
through the supervisor, and the checklist derived from `git diff --name-only`
so it names only the surfaces that moved. It persists in
`~/.agent/pending-reload.json` until `/update done`, because the failure it
prevents is silent. Two rows at the top of the live frame, both truncated and
both charged to the budget.

**What it has never done is run against a real merge.** Test it the first time
you merge to `main` and pull: the check should notice, `/update` should pull
and restart, and the reload list should name the extension only if
`extension/` actually moved. `/update done` clears it.

Building it turned up two frame bugs, both now gotchas in `CLAUDE.md`: the
budget's floor of 3 was never "at least three if there is room", and a
105-character notice wraps at 80 columns, so it was charged as one row and
drawn as two. The arithmetic test caught the first; only the pty run caught
the second.

**2. The side panel drops three message types the server sends.**
`response_stream`, `github_processing_started`, `github_processing_finished`
reach it through `socket.js`'s `default:` branch and are discarded. So the panel
never shows streaming text or GitHub activity, and every streamed chunk crosses
the socket to be thrown away. `CLAUDE.md` records this as an *incomplete
surface* rather than dead code, deliberately: deleting the sends removes a panel
feature, adding handlers is one. The panel is a supported front-end, so this is
a genuine gap with a clear shape.

**3. `/logs rates` needs a week of use, not work.** It reads all zeros today —
`errors.jsonl` has 3 lines and `traces.jsonl` does not exist yet. The view was
built precisely so the data gets read; it cannot answer anything until the data
is there. Two open questions depend on it: whether
`REFRESH_INTERVAL_MESSAGES = 20` is the right number, and whether
`multiple_drafts` has ever fired at all.

**4. The batch task could hold its tab across *models*, not just turns.** What
landed yesterday keys a session to one tab. `_executeSubagent('gemini', …)` is
still hard-coded in `runHeadlessTask`, so a batch task always runs on Gemini
whatever `modelConfig` says. Deliberate for now — nothing but Gemini has been
exercised on that path — and it is the obvious next step if ChatGPT becomes a
real background option.

**5. `/skills` has never been examined.** Reachable and aligned, and the *shape*
of the feature was never looked at: `/skills dir` prints a four-entry search
path, `skillFolders` is an escape hatch from config, creating one opens an
editor. Whether that is the right set of moves is an open question, not a bug
list. Lowest priority here, and the only item with no evidence behind it.

---

## Decisions already made — do not re-litigate

- **The PR into `main` is the owner's.** Said explicitly, twice.
- **Collapsing the two bridges is declined.** The jsdom tests run against both,
  so a scraping divergence fails the build — most of the value, none of the risk
  of breaking both at once.
- **No embedding index.** Argued from the architecture in `CLAUDE.md`; the
  symbol index is the part that was worth building.
- **The jitter's second half is not happening** — ~20% of the live frame for the
  seam that brought the scroll glitches back twice.
- **Terminal failures are opt-in per terminal**, chosen over an age filter.
- **An API backend stays a fork**, not a plan.

---

## Things that will waste your time if you do not know them

- **Check any tool you write before believing it.** Yesterday's dead-code audit
  produced four separate false positives, each the same mistake: static analysis
  of a dynamic language. Names matched inside comments; `find_references`
  correctly ignoring member expressions made `paths.*` look dead; an import
  graph could not see manifest- and HTML-loaded files; literal class matching
  missed `` `message-${role}` ``. Nothing was deleted on any of them.
- **A passing test lies the same way.** `toolCatalogDrift()` compared an empty
  registry to an empty catalog and went green. Negative controls per branch, or
  the pass means nothing.
- **`extension/service-worker.js` is a committed build artifact.** Editing
  `extension/src/background/` without `npm run build --workspace=extension`
  ships nothing. Content scripts are *not* bundled and need only a reload.
- **The pty harness recipe is in `CLAUDE.md` → Commands → The pty harness.** It
  lives in a session scratchpad, so that recipe is the only copy.
