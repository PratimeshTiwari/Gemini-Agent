# Session handoff

Written 2026-09-10 at the end of a long session. Delete this file once the work
below is finished — it is a baton, not documentation.

**Read `CLAUDE.md` first.** It carries the architecture, the gotchas and the
`## Direction` section with the phased plan and the reasoning behind each call.
This file only says where the baton is.

---

## State

- Branch `v1-stable`, pushed and current (`8e60a24` on origin).
- `main` is untouched at `68f76cd`. **Work merges into `main` through a PR only** —
  never push to it. The branches in this repo are deliberate history; do not delete them.
- Tests: `npm test` → 295 passing. Keep it there.
- Commits carry no `Co-Authored-By` trailer. The owner asked for that; earlier ones were
  rewritten and then the rewrite was reverted, so old commits still have trailers and
  that is intentional — do not rewrite history again.

## Done this session

The UI was unusable and is now not. In order:

1. **Ink was clearing the terminal ~7×/second** whenever the live frame outgrew the
   viewport — that is what "flickers, can't scroll, can't copy" was. Measured idle:
   108 clears and 3.85 MB in 15s → 0 clears and 36 KB. Settled turns now go to
   `<Static>`; only the in-flight turn is live, bounded by `RESERVED_ROWS`.
2. **Enter was silently dropped** when the terminal delivered a character and the
   Enter after it in one read (`enter-splitter.js`).
3. **ctrl+e/o/t/v typed their letter into the prompt** — `ink-text-input` inserts any
   key it does not recognise. Chords are pulled off stdin before Ink sees them
   (`ui/hotkeys.js`).
4. Multi-line paste folds to `[Pasted text #1 +60 lines]`; ctrl+u / ctrl+w added.
5. GitHub: a 401 looped forever and printed into Ink's frame; the token screen's
   import path was wrong so **every token submission failed**.
6. `/compact` threw on a fresh session and the UI had no try/catch, so it hung silently.
7. `run_command` hung for the full timeout on anything reading stdin (6.00s → 0.01s) —
   the likely cause of `git show` failing on a work laptop.
8. Renamed the CLI to `agent-cli`; skills; failure log at `.agent/logs/errors.jsonl`;
   one `.agent/` for a group of repos; VS Code companion (diagnostics, Add to Agent
   Chat, PR-style plan review) at `cli-agent-companion-1.3.1.vsix`.
9. Phases 0, 1 and 7 of the plan (see `CLAUDE.md` → Direction).

Net for the refactor phases: **2,863 lines deleted, 551 added.**

## Next — phase 2

`CLAUDE.md` → `## Direction` has the table and the reasoning. Phase 2 is the big one
and lands the whole design:

- `AGENT.md` walked from `codeDir` is already in (phase 0). What remains is deleting
  the mechanisms it replaces: `rulesPath`, `scopedRulesPath`, `mistakesPath`,
  `/init-skills`, `contextFolders`, `_loadContextFolders`, `/context add|remove|list`.
- Then 3 → 4 → 5 → 6, one at a time, running the CLI in between.

After the phases, the owner wants to **simplify the extension and backend** for a
stable release.

## Loose ends not in any phase

- **VS Code terminal shell integration** — discussed, never built. Needs the companion
  engine bumped `^1.80.0` → `^1.93.0` and the vsix repackaged. Would give the
  Cursor-style "your dev server broke and the agent noticed" loop for terminals inside
  VS Code. `watch_task` already exists to receive it.
- **`/plans`** — plans are archived to `.agent/artifacts/plans/` but nothing lists them.
- **Extension error richness** — the bridge logs whatever the content script sends, but
  the content scripts send no `op`/`stage`, so `/logs extension` is thin.
- **README skills section** still describes the three-folder search that phase 2 replaces.
  Left deliberately: documenting an unbuilt design is worse than being a phase behind.

## Gotchas that actually bit, this session

- **Never bulk-edit `prompt-builder.js` with a regex.** A greedy pattern removing
  `semantic_search` twice also ate `get_editor_state`, `ask_subagent` and
  `ask_researcher` — three tools the model would have silently stopped knowing about.
  The test suite caught it both times. Use exact strings or line boundaries.
- **`RESERVED_ROWS` in `ui/constants.js` is load-bearing.** Add a row to the bottom
  furniture without raising it and the clear-the-terminal bug returns. It is 16.
- **`npm test` needs the quoted glob.** `node --test src/` runs `main.js` as a test and
  hangs forever. Never import `main.js` to check syntax, for the same reason.
- **The pty harness is how UI changes get verified.** `script -q /dev/null` does not
  work in this environment; `pty.fork()` from Python does. Type one byte at a time with
  ~90ms gaps and write escape sequences whole — Ink parses a chunk as one keypress, so a
  fast harness produces false failures. Count `\x1b[2J` in the raw capture; expect zero,
  except exactly one per ctrl+e, which reprints the transcript by design.
- **`.agent/` is written in exactly one place**, `core/paths.js`. Keep it that way.

## Owner preferences observed

- Simple over clever, every time. "Keep things simple stupid yet effective."
- Wants the reasoning, not a list of changes — and will push back when a plan is a
  pile of tasks rather than one idea.
- Benchmarks the CLI against Claude Code and asks how Claude Code solves things.
- Neutral names in examples (`base-repo`, never a real employer).
