# Session handoff

Written 2026-09-10 at the end of the second long session. Delete this file once the
work below is finished — it is a baton, not documentation.

**Read `CLAUDE.md` first.** It carries the architecture, the gotchas, the `## Direction`
section (all six phases, now done, with the reasoning behind each call) and
`## What's next` (P0–P3, with the evidence for each). This file only says where the
baton is.

---

## State

- Branch `v1-stable`. **Seven commits ahead of `origin/v1-stable`, not yet pushed.**
- `main` is untouched at `68f76cd`. Work merges into `main` through a PR only.
  The branches in this repo are deliberate history; do not delete them.
- Tests: `npm test` → **539 passing**, up from 295.
- Commits carry the `Co-Authored-By` and `Claude-Session` trailers the harness asked for.
  Older commits are inconsistent on purpose — the rewrite was reverted. Do not rewrite
  history again.

## Done this session

**All six Direction phases**, in the order 2 → 3 → 4 → 5 → 6:

| | | commit |
| --- | --- | --- |
| 2 | One instruction surface: `AGENT.md`, walked. `rules.md`, `mistakes.md`, `contextFolders`, `/context add\|remove\|list`, `/init-skills` all gone | `7e8a595` |
| 3 | Memory read back into `<memory>` — `getAllMemories` had *no callers*, so every remembered fact cost a tool call and bought nothing. `memory.json` → `memory.md` | `7d8c03d` |
| 4 | One effort ladder, five rungs. `modelTier` + `reasoningLevel` + `reasoningEffort` → `effort` | `6a4f391` |
| 5 | Scope chosen at launch. `setScope` rebuilt the session store under a transcript still on screen | `92b3008` |
| 6 | A lock per model (`bridge/extension-lock.js`), topology derived from `modelConfig.reviewer` | `4abc845` |

**And the loose ends** (`9a82d3a`): `/plans`, `/settings`, `/help` generated from
`SLASH_COMMANDS` rather than hand-kept, plus three commands that reported success without
doing the thing — `/restart` (touched a mtime nothing watched), `/image` (delivered fine,
but stored the base64 in history, both session files, every compaction prompt and the
retry objective), `/context` (padded ANSI strings with `padEnd`, so the box never aligned).

## Next

`CLAUDE.md` → `## What's next` has the detail and the evidence. In short:

- ~~**P0**~~ — **done 2026-09-11.** The classifier now splits the command line and lets
  the worst segment decide; the bridge binds to loopback and refuses web-page origins;
  `diff-engine.js` has 25 tests, one of which found backups escaping the backup
  directory for any file edited outside the workspace.
- ~~**P1**~~ — **done 2026-09-11.** Validate tool args with the `zod` that is already installed and never imported;
  with the zod that was installed and never imported; the workspace commands, where
  `setWorkspace` left memory and the allowlist pointing at the old project; settings row
  wrapping; `looksLikeMultipleDrafts` now logs. `_extractToolCalls` is pinned by tests.
  **One thing to come back to: read `/logs agent` after a week and decide whether
  `multiple_drafts` has ever fired.**
- **P2, next.** Settings tabs; `prompts/*.md`; extension `op`/`stage`; the ChatGPT image path.
- **P3.** VS Code shell integration; folder picker; **restructure** the GitHub PR agent
  (not delete — the owner asked for a separate plan); split `agent-loop.js`.

Then the fork in `## What's next` → "The fork": whether an opt-in API backend joins the
browser bridge. That is a product decision, not a task.

## Loose ends now closed

`/plans`, the README skills section, `/restart`, `/image`, `/context`, and the two wrong
command descriptions (`/memory` said "view memory" and toggled it off; `/agent-dir` said
"open a directory" and repointed the workspace).

Still open, and now in P2/P3: extension error richness, VS Code terminal shell integration.

## Gotchas that actually bit, this session

- **Never bulk-edit `prompt-builder.js` with a regex.** Still true. Also: **escape
  backticks** in text you insert into its template literals — a bare one ends the string
  and the failure surfaces as `ReferenceError: memory is not defined` from an unrelated
  function.
- **A Python edit script that asserts before writing loses every earlier replacement.**
  Two batches of description fixes silently did nothing this way. Verify with `grep`.
- **`import('./src/index.js')` runs the CLI.** Same trap as `main.js` — it is a script,
  not a module, and the import hung for 120s.
- **The pty harness must send escape sequences one at a time.** `b"\x1b[B" * 3` in one
  write arrives as a single keypress; Ink parses a chunk as one key. Send, sleep ~150ms,
  drain, repeat.
- **The pty harness earns its keep.** It caught the phase-4 bug where the default
  `effort: 'standard'` shadowed every legacy config key — the unit tests did not.
- **`RESERVED_ROWS` is still load-bearing**, and the settings screen showed why: any new
  full-width row can overflow the viewport and bring the clear-the-terminal bug back.
- Expect `0` `ESC[2J` and `0` idle bytes from every new screen. Every one added this
  session was measured that way.

## Owner preferences observed

- Simple over clever. "Keep things simple stupid yet effective."
- Wants the reasoning, not a list of changes — and will push back when a plan is a pile
  of tasks rather than one idea.
- Benchmarks against Claude Code and asks how Claude Code solves things.
- Asks for the unsugared answer and means it. Measure before asserting; an estimate
  should be labelled as one.
- Reverses course when the argument is good — and expects the same in return.
