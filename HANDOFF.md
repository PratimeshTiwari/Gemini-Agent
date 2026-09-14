# Session handoff

Started 2026-09-11; last updated **2026-09-15**, end of the fourth long session.
Delete this file once the work below is finished — it is a baton, not
documentation.

**Read `CLAUDE.md` first** for the architecture and the gotchas, then
**`UX-PLAN.md`**, which is the board: what is done, what is next, and the
reasoning behind each call. This file only says where the baton is.

---

## Start here

`UX-PLAN.md` → **`## Next session's P0 — found by running it`**. Four bugs the
owner found by using the product, each verified against the code before being
written down, none fixed. Two of them cost real money.

1. **Auto-compaction has never fired and cannot.** `needsCompaction` is handed
   the history array where it wants a token count; `Number([…])` is `NaN` and
   `NaN > x` is always false. The meter was watched past 200% of 50k. The fix is
   one word — and is *not* a one-word job: nothing tests `needsCompaction`, which
   is why it survived, and the change turns on a path that has never run.
2. **Nothing bounds a successful tool loop.** 750 rounds in 40 seconds against a
   scripted model. `MAX_FAILED_ROUNDS` bounds failures only, and the comment
   next to it treats unbounded success as the feature.
3. **The reconnect message duplicates your turn** — it is already in
   `conversationHistory`, and the notice is missing `isLocal`.
4. `Small edit: 1 lines changed`.

## State

- Branch `v1-stable`. **Check `git log origin/v1-stable..HEAD`** rather than
  trusting a number here — it is stale the moment either of you moves. The owner
  pushes by hand; do not push without being asked.
- `main` is still untouched and the merge is **still a clean fast-forward**
  (`git rev-list --left-right --count main...v1-stable` → `0 <n>`). Nothing from
  four sessions has been through a PR. It is free today and does not stay free;
  `CLAUDE.md` documents the divergence trap. **The owner has said the PR happens
  once the current run of changes is done.**
- Tests: `npm test` runs **both workspaces** now — `server/test/` and
  `extension/test/`. All green.

## Done this session

The whole of `UX-PLAN.md`'s original P0, plus what using the product turned up.

- **The code-block scrape was deleting prose**, not just mangling code, and the
  same bug was in both bridges. First tests the extension has ever had.
- **The prompt is a real multi-line editor** — ctrl+j everywhere, shift+enter
  where the terminal reports it, up/down moving by line and falling through to
  history at the edges. `ink-text-input` is gone; it owned its cursor and would
  not give it back, which was also the cause of pastes landing behind the caret.
  The prompt is **bounded to a third of the viewport** and scrolls inside that.
- **A reply could arrive, be stored, and never reach the screen.** `<Static>`
  counts what it has printed by index, so the transcript must be append-only.
- **Diffs are drawn in the transcript** — and the approval prompt, which is the
  one screen whose whole job is showing you a change, had **never drawn one**.
- **One animation clock instead of three-plus-N.** 38% fewer bytes.
- **Destructive commands ask first**, on the one rule that they destroy more
  than you named.
- **A failed editor command waits behind ctrl+f** instead of typing itself into
  your prompt.
- **The mode picker is readable and switchable**, verified against the live page.

## The model/effort work, half built

`core/model-match.js` (14 tests) decides which browser mode a rung wants from
whatever the plan is offering, matching on what an option is *for* rather than
its name — the version numbers move and the list differs by subscription.
`gemini-bridge.js` reads and switches, **verified against gemini.google.com**.

**Still to build:** the server asking for the list on connect, caching it,
showing it on the Status tab, and `/effort` acting on the plan. All server-side
and testable with the pty harness.

Until then `/effort` still only prints "💡 Set your browser tab to **Gemini
Pro**" and hopes — which is the gap this closes.

## What the owner has decided

- **GitHub stays shelved** until the current UI/extension run is finished. Its
  phase 1 (two lines routing analysis failures into `/logs`) is worth doing
  whenever someone is next in that file.
- **ext8 — collapsing the two bridges — is not being done.** The cost it was
  meant to remove is "fix it twice", and fixing the scrape twice took one commit
  and ten minutes. The jsdom tests now run against *both* files, so a divergence
  in scraping fails the build, which is most of its value for none of its risk.
- **The extension reconnect is settled.** The owner read Status → Extension in a
  real browser and the connect time had improved. No offscreen document.
- **The jitter's second half — committing finished actions to `<Static>` — is
  deliberately not done.** The live frame is ~13 rows of which 9 are fixed
  furniture, so shrinking the turn portion buys ~20% for the seam that brought
  the scroll glitches back twice. 38% was taken for free instead.
- `cli-agent-companion-1.3.1.vsix` deleted.

## Still open, roughly in order

After next session's P0: **Track F** in `UX-PLAN.md` (see which `AGENT.md`,
memory and skills are actually loaded — this repo's own `AGENT.md` is the
unedited template and nothing would tell you), finishing the model switcher,
`src/background/` tests, extension phase 5 (trace events), and the `:` command
palette — thin, since `:stop` is the only `:` command.

## How to test anything here

The pty harness is the reason this session found what it did. It lives in the
session scratchpad and is worth rebuilding if gone; `UX-PLAN.md` → **How this
was measured** has the recipe.

- `drive.py` — pty-forks the CLI with `PATH` prefixed by shims for `open`,
  `code` and `xdg-open` that log their argv instead of launching, which is how
  "did it open the editor" became checkable.
- `fake-extension.js` / `hold-extension.js` — answer prompts from a script, or
  hold a turn open so the live frame can be measured.
- `measure-jitter.py`, `overflow-test.py` — bytes, erase-lines and `ESC[2J` per
  terminal size. **The bar is 0 clears and 0 idle bytes, at every size.**
- `scrape-test.mjs` — `extractTextContent` lifted out of the shipped source and
  run against a Gemini-shaped DOM in jsdom.

**And check the harness before believing a negative.** It lied four times this
session: a port the extension never dials, a file-seeding step that also typed
its content into the prompt, an extractor that dropped an `async` keyword, and a
test assertion loose enough to pass on "5 alloweds and 2 blockeds". Three of
those looked like product bugs first.

## Gotchas this session added

- **`<Static>` counts by index.** The transcript must be append-only. Replacing
  it with anything shorter makes Ink skip exactly as many turns, permanently —
  and silently.
- **`ink-text-input` reads `value.length` into its cursor on mount and never
  moves it forward.** It is gone; `PromptInput` replaces it.
- **The live frame's budget has a floor.** `Math.max(3, …)` means charging rows
  to `liveBudget` is not enough on its own — anything that can grow needs its own
  bound, or the total goes past the viewport anyway.
- **Gemini calls it a *mode* picker, not a model picker**, and the trigger's
  label contains the current model, so matching the whole label breaks on every
  switch. Selection is a `selected` **class** — `aria-checked` is absent — and
  `active` is on whichever item opened focused, so reading it reports the first
  option as current every time.
- **Never close that menu with Escape.** It removes the items but leaves
  `aria-expanded="true"`, and the next open then reads as already-open, does not
  click, and fails. Click the trigger; it toggles, so check `aria-expanded`
  first.
- **A fallback that cannot fire is worse than none**, because the ladder looks
  like it has a safety net. The first structural fallback for the picker
  returned nothing at all and would never have been noticed.
