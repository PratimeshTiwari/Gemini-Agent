# Session handoff

Started 2026-09-11; last updated **2026-09-15**, end of the fifth long session.
Delete this file once the work below is finished — it is a baton, not
documentation.

**Read `CLAUDE.md` first** for the architecture and the gotchas, then
**`UX-PLAN.md`**, which is the board: what is done, what is next, and the
reasoning behind each call. This file only says where the baton is.

---

## State

- Branch `v1-stable`, tree clean. **Check `git log origin/v1-stable..HEAD`**
  rather than trusting a number here. The owner pushes by hand; do not push
  without being asked.
- `main` is **93 commits behind and still a clean fast-forward**
  (`git rev-list --left-right --count main...v1-stable` → `0 93`). Five sessions
  have never been through a PR. The owner has said the PR happens once the
  current run of changes is done. It is free today and does not stay free —
  `CLAUDE.md` documents the divergence trap.
- `npm test` runs **both workspaces**: 703 server + 25 extension, all green.

## Where to start

**Generating the tool definitions**, which `CLAUDE.md` → P2 records as blocked.
It is not glamorous and this session produced two pieces of hard evidence for it:
`recall_history` and `get_diagnostics` were both **registered, implemented and
completely unreachable**, because `_buildToolDefinitions` is two hand-written
lists and nobody had added them to the prose. A tool the model is never told
about does not exist.

There is now a test that catches it in both directions — a prompt naming a tool
that does not exist, and a tool the prompt never names — but a guard is a smoke
alarm. Generation removes the fire. CLAUDE.md says it is blocked on five tools
(`ask_question`, `ask_subagent`, `ask_researcher`, `ask_reviewer`,
`manage_memory`) being dispatched inside `agent-loop.js` and declared nowhere;
that is the contained piece of work to do first. `runHeadlessTask` has a third
list of its own.

Then, in order: **code-block copyability** (small, visible, and unblocked now the
scrape is fixed) and **extension phase 9, tab identity**.

## What is left, verified against the code

**Extension** — 7 of 9 phases done.
- **9 · Tab identity** (lane → tabId). `content.js` still picks
  `tabs[tabs.length - 1]` — whatever tab is last — so a subagent's tab can be
  handed the user's prompt. Unblocks GitHub 4 and 5.
- **8 · Collapse the two bridges** — **the owner decided against it.** The cost
  it removes is "fix it twice", and fixing the scrape twice took one commit; the
  jsdom tests now run against *both* files, so a scraping divergence fails the
  build. That is most of its value for none of its risk.

**UI redesign round two** — one item left.
- **Code blocks are not copy-clean.** `ui/format.js:12` is still `tab: 2`, so a
  drag-select takes the indentation with it. Wants: no indent, a dim rule
  marking the block's edges *outside* what a drag picks up, and `ctrl+y` to copy
  the last block. There is no clickable copy button and there cannot be — that
  needs mouse tracking, which is what would take native selection away.

**GitHub** — 1 of 9. Shelved by the owner *until the current UI/extension run is
done*, not abandoned. Every finding re-verified as still true this session:
`GITHUB_REPOS` silently overwritten at `github-event-handler.js:45`;
`github-poller.js` (476 lines), `github-event-handler.js` (357) and
`ci-log-parser.js` (198) still untested; `runHeadlessTask` still re-serialises
the whole history every turn (`agent-loop.js:1580`); `ExtensionLock._lane` still
keys on the **model**, so a GitHub turn and a user prompt share a queue even
though the extension would put them in different tabs.

**Capability gaps** — `CLAUDE.md` → Raised / P3.
- **Symbol index** (`find_symbol` / `find_references`, tree-sitter or ctags) —
  the structural half of large-codebase work, and the half grep is worst at.
- **`/skills` shape** — never examined.
- **Large-codebase search** — a decision awaiting measurement, not a task.
- **The fork** (an API backend). Its cheap half is now much cheaper: reading
  `parse_tool_calls`, `tool_amnesia` and `provider_error` as *rates* rather than
  lines, which the new trace infrastructure makes straightforward.

**Parked by the owner** — the `/effort` browser switch. Built, tested under the
harness, selectors verified against the live page, **never run against a real
Gemini tab**. `UX-PLAN.md` → "Parked" has what is built and where to resume.

## Owner decisions, so they are not re-litigated

- GitHub stays shelved until the UI/extension run is finished.
- ext8 (collapsing the bridges) is **not** happening.
- The extension reconnect is settled — the owner read Status → Extension in a
  real browser and the time had improved. No offscreen document.
- The jitter's second half — committing finished actions to `<Static>` — is
  deliberately **not** done. The live frame is ~13 rows of which 9 are fixed
  furniture, so shrinking the turn portion buys ~20% for the seam that brought
  the scroll glitches back twice. 38% was taken for free instead.
- `cli-agent-companion-1.3.1.vsix` deleted.

## Done this session

Forty commits. The whole of `UX-PLAN.md`'s P0, the four bugs the owner found by
running it, and five of the nine extension phases.

- **Auto-compaction has never fired** — `needsCompaction` was handed the history
  array where it wants a token count, so `NaN > x` was always false. Fixing it
  exposed three more behind it: the budget was a stale field that ignored
  `/effort`, the status bar hardcoded a different limit than the threshold, and
  `_resetContextCount` was **called and never defined** — which also meant
  `/compact` had been broken for any conversation long enough to compact.
- **A reply could arrive, be stored, and never reach the screen.** `<Static>`
  counts what it has printed by index, so the transcript must be append-only.
- **The prompt is a real multi-line editor** (`ctrl+j`, arrows move by line),
  bounded to a third of the viewport so it cannot blow the frame.
- **Diffs are drawn** in the transcript — and the approval prompt, whose entire
  job is showing you a change, had **never drawn one**.
- **Nothing bounded a successful tool loop** — 750 rounds in 40 seconds. Now 30.
- **Session recall**: the agent can search turns a summary replaced. The premise
  had to be built first — CLAUDE.md says the history file keeps every turn and
  it does not; compaction rewrote both copies.
- Destructive commands confirm; failed editor commands wait behind `ctrl+f`
  instead of typing themselves in; one animation clock instead of three-plus-N
  (38% fewer bytes); `/logs extension` reports real timings; `setup.sh` installs
  a shim when `npm link` is not allowed; the README finally says how to use the
  thing.

## How to test anything here

The pty harness is why this session found what it did. It is in the session
scratchpad; `UX-PLAN.md` → **How this was measured** has the recipe.

- `drive.py` — pty-forks the CLI with `PATH` prefixed by shims for `open`,
  `code` and `xdg-open` that log their argv instead of launching.
- `fake-extension.js` / `hold-extension.js` — answer prompts from a script, or
  hold a turn open so the live frame can be measured. The fake one now also
  speaks the mode-picker protocol and echoes `isSubagent`.
- `measure-jitter.py`, `overflow-test.py` — bytes, erase-lines and `ESC[2J` per
  terminal size. **The bar is 0 clears and 0 idle bytes, at every size.**
- `scrape-test.mjs` — `extractTextContent` lifted from the shipped source and
  run against a Gemini-shaped DOM in jsdom.

**Check the harness before believing a negative.** It lied six times this
session: a port the extension never dials; a file-seeding step that also typed
its content into the prompt; an extractor that dropped an `async` keyword; a
test assertion loose enough to pass on "5 alloweds and 2 blockeds"; a fake
extension that answered subagent requests without `isSubagent`, so compaction
hung and looked like a product bug; and a `ClipboardEvent` probe that silently
did nothing, which made an empty composer look like proof that the send button
was unfindable. Most of those looked like product bugs first.

## Gotchas this session added

- **`<Static>` counts by index.** The transcript must be append-only. Replacing
  it with anything shorter makes Ink skip exactly as many turns, permanently and
  silently.
- **`ink-text-input` is gone.** It read `value.length` into its cursor on mount
  and never moved it forward. `ui/components/PromptInput.jsx` replaces it.
- **The live frame's budget has a floor.** `Math.max(3, …)` means charging rows
  to `liveBudget` is not enough on its own — anything that can grow needs its
  own bound too, or the total goes past the viewport anyway.
- **A value that must track another is read, not stored.** `maxTokens` was a
  field with a comment claiming it was replaced per turn; nothing replaced it.
- **Instrumentation must not be able to fail a turn**, and a fallback that
  cannot fire is worse than none — one that fires *wrongly* is worse than that.
- **Gemini calls it a *mode* picker.** The trigger's label contains the current
  model, so matching the whole label breaks on every switch. Selection is a
  `selected` **class**; `active` is on whichever item opened focused. Never close
  that menu with Escape — it leaves `aria-expanded="true"` and the next open
  fails. Click the trigger; it toggles, so check `aria-expanded` first.
- **Send is identified by behaviour, not position.** It is the button that
  appears when the prompt gains text. Position picks the mode picker (37px) or
  Dictate (122px) before send (163px), and `type="submit"` is on all of them.
