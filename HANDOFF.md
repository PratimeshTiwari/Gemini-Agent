# Session handoff

Started 2026-09-11; last updated **2026-09-16**, end of the sixth long session.
Delete this file once the work below is finished — it is a baton, not
documentation.

**Read `CLAUDE.md` first** for the architecture and the gotchas, then
**`UX-PLAN.md`**, which is the board. This file only says where the baton is.

---

## State

- Branch `v1-stable`, tree clean. **Check `git log origin/v1-stable..HEAD`**
  rather than trusting a number here. The owner pushes by hand.
- `main` is **112 commits behind and still a clean fast-forward** (as of this
  commit; `git rev-list --left-right --count main...v1-stable` is the truth). **The owner
  has said the PR is theirs and they will do it.** Do not open it.
- `npm test`: **915 server + 37 extension**, all green.
- **The extension needs reloading in Chrome and the Gemini tab hard-refreshing**
  before this session's bridge work does anything in a real browser. The page
  keeps the old content script until a hard refresh.
- The VS Code companion needs reinstalling for the terminal opt-in:
  `cli-agent-companion-1.5.0.vsix`.

## Where to start

**There is no obvious next task, which is new.** Every plan file is finished:
`EXTENSION-PLAN.md` is 8 of 9 with phase 8 declined, `GITHUB-AGENT-PLAN.md` is
1-8 done with phase 0 owner-only, `UI-REDESIGN.md` round two is done, and
`UX-PLAN.md`'s P0-P2 and Tracks A-F are done or explicitly parked.

What is left is three things that need *use*, not work:

1. **Run it and report what is wrong.** Four of this session's better fixes came
   from the owner doing exactly that — the checkbox one especially.
2. **`/logs rates` after a week.** It reads all zeros because `traces.jsonl` is
   empty and `errors.jsonl` has two lines. That is the point: the view exists
   now, so the data will be read. P2.12 (is the refresh interval right?) and
   P2.13 (has `multiple_drafts` ever fired?) become answerable rather than
   arguable.
3. **The parked `/effort` browser switch.** Built, tested under the harness,
   never run against a real Gemini tab.

If you want code: **one tab held across a batch task's turns**. It is the only
thing left that is both known-wrong and unbuilt — see below.

## The one open design question

**A batch task re-serialises its whole history every turn, and has to.**

`GITHUB-AGENT-PLAN.md` called this an oversight; it is not. Every send in
`runHeadlessTask` goes through `_executeSubagent`, which sets
`isSubagent: true`; the extension answers that by creating a **fresh tab** and
closing it when the turn ends. Turn 2 is a browser tab that has never seen turn
1, so re-serialising is the only thing making a multi-turn batch task work.

Fixing it means a tab held for the life of a task rather than a turn. The lane
work is the prerequisite and it has landed, so the shape is available:
`sub:<requestId>` already gives a task its own lane. What is missing is telling
the extension "reuse the tab you made for this lane" instead of creating one per
request. Recorded in `core/turn-runner.js`, where whoever meets it will be.

## Owner decisions, so they are not re-litigated

- **The PR into `main` is the owner's to make.** They said so explicitly.
- GitHub was unshelved and finished. Phase 0 is a manual two-tab browser test
  only they can run, and nothing shipped depends on it.
- ext8 (collapsing the two bridges) is **not** happening.
- The extension reconnect is settled — no offscreen document.
- The jitter's second half — committing finished actions to `<Static>` — is
  deliberately **not** done. ~20% of the live frame for the seam that brought
  the scroll glitches back twice.
- Terminal failures are **opt-in per terminal**, chosen over an age filter or
  keeping only the newest.
- The symbol index is **acorn**, chosen over ctags and tree-sitter: exact on the
  languages it covers, honest about the ones it does not.

## Done this session

Fifteen commits.

- **The app broke below 13 rows** — 166 full-screen clears in one turn at 10×80.
  Found by answering "does resizing glitch?" (it does not). Floor moved 13 → 9.
- **One list of tools.** `core/tool-catalog.js`; all twenty prompt shapes
  byte-identical. It has already earned itself, catching `find_symbol` and
  `find_references` registered-but-unnamed on the day they were written.
- **`AGENT.md` was the stock template**, going into every turn-0 prompt as this
  project's context.
- **Code blocks you can copy** — `tab: 0`, edges as dim rules, `ctrl+y`.
- **A lane is a tab, not a model** — in the extension and in `ExtensionLock`.
  A stalled subagent also stopped taking the user's turn down with it.
- **`find_symbol` / `find_references`** — 282 of 282, against the 24% that got
  `ast-chunker` deleted.
- **`/logs rates`** — the text channel's failure rate, with `traces.jsonl` as
  the denominator.
- **The task checklist was write-only** — reported from use, and the same trap
  as `manage_memory` before Direction phase 3, in a second place.
- **GitHub 1-8** — 50 characterisation tests first, then the turn-runner
  extraction, the orchestrator split, and `.agent/github-reviews/`.
- **Terminal failures are opt-in per terminal** — companion 1.5.0.
- Four small ones: the editor's line number when `$EDITOR` is a path, a marker
  that did not terminate its fence, `GITHUB_REPOS` read and thrown away, and
  `/context` printing what feeds the prompt.

## How to test anything here

The pty harness is why this session found what it did. Rebuild it in the session
scratchpad from `UX-PLAN.md` → **How this was measured**; this session's version
adds `{"resize": [rows, cols]}` steps, per-bucket counts of `ESC[2J`, `ESC[3J`
and erase-lines, and `ROWS`/`COLS` for the starting size.

**Check the harness before believing anything, positive or negative.** It lied
three times this session: a fake extension whose `ws` import was wrong, so a
"resize during a live turn" measurement had no live turn in it; a `replies.json`
written with `echo`, so the same thing happened again; and a chunk extractor
that took a separator newline with it, which would have shipped a one-character
prompt change as "byte-identical".

**A passing test lies the same way.** `toolCatalogDrift()` compared an empty
registry to an empty catalog and went green; it needed a negative control per
branch before the pass meant anything. Two characterisation tests "failed"
because *they* were wrong about the code, not the other way round.

## Gotchas this session added

- **The live frame can overflow from below.** `liveBudget`'s floor sets a
  *minimum* frame height, so a terminal shorter than `RESERVED_ROWS + floor`
  overflows however much the turn gives up.
- **`acorn-jsx` teaches the parser, not the walker.** A `.jsx` file parses fine
  and then throws `No walker function defined for node type JSXElement`. And
  `acorn-walk` defines `ImportSpecifier` as `ignore`, so "who imports this?"
  silently answers nothing.
- **`path.basename` is the platform's.** A Windows path in a POSIX process keeps
  its backslashes and reads as one filename. Split on `[\\/]`.
- **Do not touch the real clipboard in a test.** The person running it may have
  copied an image they were about to attach with `/paste-image`.
- **A row whose label is a path needs two bounds.** One long path sets the column
  width for every row; elide the label from the *left* and truncate the detail
  first.
- **A queue drained without `await` turns a thrown item into an unhandled
  rejection**, which Node may answer by taking the CLI down. `finally` releases
  the lock; it does not contain the error.
- **If you add an artifact the model is told to maintain, ask what carries it
  back.** That is twice now.
