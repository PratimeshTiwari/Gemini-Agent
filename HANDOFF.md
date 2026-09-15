# Session handoff

Started 2026-09-11; last updated **2026-09-16**, end of the sixth long session.
Delete this file once the work below is finished — it is a baton, not
documentation.

**Read `CLAUDE.md` first** for the architecture and the gotchas, then
**`UX-PLAN.md`**, which is the board. This file only says where the baton is.

---

## State

- Branch `v1-stable`, tree clean. **Check `git log origin/v1-stable..HEAD`**
  rather than trusting a number here. The owner pushes by hand; do not push
  without being asked.
- `main` is **101 commits behind and still a clean fast-forward**
  (`git rev-list --left-right --count main...v1-stable` → `0 101`). **The owner
  has said the PR is theirs and they will do it.** Do not open it.
- `npm test` runs both workspaces: **763 server + 37 extension**, all green.
- The extension must be **reloaded in Chrome and the Gemini tab hard-refreshed**
  before any of the last two sessions' extension work does anything in a real
  browser. The page keeps the old content script until a hard refresh.

## Where to start

**`ExtensionLock` lanes, keyed by name rather than by model.** It is a small
diff and it was blocked on tab identity, which landed this session: two
same-model turns now reach genuinely different tabs, so serialising them on one
lane is the only thing still making a GitHub turn wait behind a user prompt.
`UX-PLAN.md` → Track B phase 5.

Then, in order: **P1.5, the jitter** (the one remaining measured UI cost — but
read the owner's decision below before touching the `<Static>` seam), and
**GitHub phase 2**, the 1,031 untested lines, if the owner unshelves it.

## What is left, verified against the code

**Extension** — 8 of 9 phases done. Only **phase 8** remains (collapse the two
bridges), and **the owner decided against it**.

**UI redesign round two** — done. Code-block copyability was the last item.

**GitHub** — 3 of 9. Shelved by the owner *until the current UI/extension run is
done*, which it now largely is. Still true: `github-poller.js` (476 lines),
`github-event-handler.js` (357) and `ci-log-parser.js` (198) have no tests, and
`runHeadlessTask` re-serialises the whole history every turn.

**Measurement, not code.** `errors.jsonl` holds **two lines**, so P2.12 (is the
refresh interval right?) and P2.13 (has `multiple_drafts` ever fired?) cannot be
answered yet. They want a week of real use, not an afternoon.

**Capability gaps** — a symbol index (`find_symbol` / `find_references`), the
`/skills` shape, large-codebase search, and the fork. All unchanged.

**Parked by the owner** — the `/effort` browser switch. Built, tested under the
harness, never run against a real Gemini tab.

## Owner decisions, so they are not re-litigated

- **The PR into `main` is the owner's to make.** They said so explicitly.
- GitHub stays shelved until the owner says otherwise.
- ext8 (collapsing the bridges) is **not** happening.
- The extension reconnect is settled — no offscreen document.
- The jitter's second half — committing finished actions to `<Static>` — is
  deliberately **not** done. The live frame is ~13 rows of which 9 are fixed
  furniture, so shrinking the turn portion buys ~20% for the seam that brought
  the scroll glitches back twice.

## Done this session

Seven commits, each measured rather than argued.

- **The app broke below 13 rows** — 166 full-screen clears in one turn at 10×80,
  the flicker bug that deletes scrollback and selection. Found by answering "does
  resizing glitch?" (it does not). `liveBudget`'s floor gave the frame a
  *minimum* height of twelve rows; the three blank furniture rows are now shed
  below `COMPACT_BELOW_ROWS` and the floor comes down with them. Floor moved 13 → 9.
- **One list of tools.** Four places had to agree about which tools exist and
  nothing checked any pair — which is how `recall_history` and `get_diagnostics`
  shipped registered, implemented and unreachable. `core/tool-catalog.js` is the
  list; all twenty prompt shapes verified byte-identical.
- **`AGENT.md` was the stock template** — 740 bytes of "describe your project
  here" going into every turn-0 prompt as this project's context.
- **Code blocks you can copy.** `tab: 2` meant a drag-select took the indent;
  now `tab: 0`, edges drawn as dim rules on their own lines, `ctrl+y` for the
  last block.
- **A lane knows which tab is its own.** Tabs were addressed by URL pattern and
  `tabs[tabs.length - 1]`, so the user's prompt could land in a subagent's
  conversation. Four paths had it.
- **Four small ones**: the editor's line number when `$EDITOR` is a path, a
  marker that did not terminate its fence, `GITHUB_REPOS` being read and thrown
  away, and `/context` finally printing what is feeding the prompt.

## How to test anything here

The pty harness is why this session found what it did. Rebuild it in the session
scratchpad from `UX-PLAN.md` → **How this was measured**; the version used here
adds `{"resize": [rows, cols]}` steps and a per-bucket count of `ESC[2J`,
`ESC[3J` and erase-lines, plus `ROWS`/`COLS` env vars for the starting size.

**Check the harness before believing anything, positive or negative.** It lied
three times in this session alone: a fake extension whose `ws` import was wrong,
so a "resize during a live turn" measurement had no live turn in it; a
`replies.json` written with `echo` so the JSON was invalid and the same thing
happened again; and a chunk extractor that took a separator newline with it,
which would have shipped a one-character prompt change as "byte-identical".

A passing test can lie the same way. `toolCatalogDrift()` compared an empty
registry to an empty catalog and passed; it needed a negative control per branch
before the green meant anything.

## Gotchas this session added

- **The live frame can overflow from below.** `liveBudget`'s floor sets a
  *minimum* frame height, so a terminal shorter than `RESERVED_ROWS + floor`
  overflows however much the turn gives up. Charging conditional rows to the
  budget only defends the top.
- **`path.basename` is the platform's.** A Windows path handed to a POSIX
  process keeps its backslashes and reads as one filename. Split on `[\\/]`.
- **Do not touch the real clipboard in a test.** The person running it may have
  copied an image they were about to attach with `/paste-image`. `writeThrough`
  exists as a seam so the piping can be tested against `cat`.
- **A row whose label is a path needs two bounds, not one.** Pad to the longest
  label and one long path sets the column width for every row; the label elides
  from the *left* (a path's tail names the file) and the detail truncates first.
