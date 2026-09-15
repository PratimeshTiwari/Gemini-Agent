# Decisions

What was decided, why, and what was measured to get there — kept after the plans
that produced it were finished and deleted.

Those plans (`EXTENSION-PLAN.md`, `GITHUB-AGENT-PLAN.md`, `UI-REDESIGN.md`,
`UX-PLAN.md`, `HANDOFF.md`) were working documents: a diagnosis, a phase table,
and a status column. Every phase in all five is now done or explicitly declined,
which left five files whose tables agreed about nothing except that there was
nothing left to do. They are in git — `git log --diff-filter=D -- UX-PLAN.md`
finds the last version of any of them — and this file keeps the part that
outlives them.

`CLAUDE.md` is the architecture and the gotchas. This is the *why*, for the
decisions someone would otherwise re-derive or re-argue.

---

## How anything here gets measured

The pty harness is why most of the findings below are numbers rather than
opinions. It is kept in the session scratchpad, not the repo; rebuild it from
this recipe.

- **`drive.py`** — `pty.fork()` the CLI with `--workspace <scratch> --port <p>
  --editor <shim> --no-github`. `PATH` is prefixed with a `bin/` of shims for
  `open`, `code`, `xdg-open` and `cursor` that log their argv instead of
  launching anything, which is how "did it open the editor" became checkable.
  Steps are a JSON list: type text, send a key, resize the window
  (`{"resize": [rows, cols]}`), or write a file into `.agent/state/` to stand in
  for the VS Code companion. It counts bytes, `ESC[2J`, `ESC[3J` and erase-lines
  per step, which is what makes a frame regression visible.
- **`fake-extension.js`** — connects with a `chrome-extension://` origin, sends
  `{type:'identify', payload:{clientType:'extension'}}` (`clientType`, not
  `client`), and answers each `inject_prompt` from a scripted list. It logs
  every prompt it is given, which is where the per-turn character counts come
  from.
- **`ext-cadence.js`** — the real extension in headless Chrome against a server
  whose `verifyClient` **refuses every handshake**, so each retry becomes an
  observable timestamp.
- **`scrape-test.mjs`** — the scrape lifted verbatim out of the bridge and run
  against a Gemini-shaped DOM in jsdom.

**Check the harness before believing anything, positive or negative.** It has
lied at least six times, and most of those looked like product bugs first: a
port the extension never dials; a file-seeding step that also typed its content
into the prompt; an extractor that dropped an `async` keyword; a fake extension
that answered subagent requests without `isSubagent`, so compaction hung; a
`ClipboardEvent` probe that silently did nothing, making an empty composer look
like proof the send button was unfindable; and a `ws` import that was wrong, so
a "resize during a live turn" measurement had no live turn in it.

**A passing test lies the same way.** `toolCatalogDrift()` compared an empty
registry to an empty catalog and went green. It needed a negative control per
branch before the pass meant anything.

---

## Standing constraints

These are choices, not limitations to route around.

- **Gemini Web is the primary target.** Other bridges exist and work for
  subagents; Gemini is what the product is tuned for.
- **Purely local.** No hosted backend, no telemetry, no API keys. Inference
  happens in the user's own browser session, which is the whole point.
- **Two front-ends** — the terminal CLI and the Chrome side panel.
- **One answer per turn.** Never drafts or A/B alternatives to choose between.
- **No mouse tracking, ever.** A terminal that is tracking hands the app the
  wheel and suppresses drag-select, so enabling it would take away the native
  selection it was meant to improve on.

---

## Decisions that still bind

### No embedding index for code search

Considered and argued down, not overlooked. Four reasons, the last specific to
this architecture:

- Code search is mostly **exact-symbol** search, where lexical matching wins.
- An index goes **stale on every edit**; the alternative to continuous
  re-indexing is serving a confident map of code that no longer exists.
- **Chunking destroys structure** — the deleted `ast-chunker` resolved 24% of
  this repo's own symbols.
- **The context window is a browser chat tab.** Twenty retrieved chunks is
  10,000 tokens typed into Gemini per query, most of it unread, in a project
  whose entire prompt strategy exists to avoid large repeated payloads.

What a large codebase actually needs instead: multi-pattern `grep_search` with
context lines and ranking (done), a symbol index that is exact and invalidates
on mtime (done — `find_symbol` / `find_references`), and a human-written
`AGENT.md` map, which beats a generated one because someone vouched for it.

If grep genuinely fails on real questions in a large codebase, that evidence
outranks this argument — and the *shape* of the failures says which row bites.

### The two bridges stay separate

~600 duplicated lines across `gemini-bridge.js` and `chatgpt-bridge.js`, and it
is the reason the ChatGPT image bug survived for months. Collapsing them was
planned as extension phase 8 and **declined**: the cost it removes is "fix it
twice", and fixing the scrape twice took one commit. The jsdom tests now run
against *both* files, so a scraping divergence fails the build — most of the
value for none of the risk of breaking both bridges at once.

### An API backend is a fork, not a plan

The agent layer's ceiling is the absence of a tool-call API: tool calls are
parsed out of prose, and `looksLikeCapabilityDenial` plus half of
`PromptBuilder`'s economics exist only because of that. An optional API backend
would remove the ceiling — structured calls, real parallelism, caching — and it
contradicts the standing "no API keys" decision that is the identity of the
project. The framing that preserves the thesis: the browser bridge stays the
default, an API backend is opt-in for people who already have a key.

Its cheap half is **not** a fork and is done: `/logs rates` turns
`parse_tool_calls`, `tool_amnesia`, `provider_error` and `multiple_drafts` into
rates. Any claim about how far behind the text channel is was an estimate until
that view existed.

### One instruction surface

Seven mechanisms once existed for "tell the model about this project", with six
different discovery rules between them. The count of *rules* was the mess, not
the count of files. Two axes, one mechanism each:

| axis | question | mechanism |
| --- | --- | --- |
| scope | who does this apply to? | **where the file is** — walk up from the code, nearest wins |
| cost | always in context, or on request? | **which file** — `AGENT.md` vs `.agent/skills/` |

Repo-specific knowledge is **not** a skill. A skill's contract is "read me when
my description matches"; repo conventions match *always* when you are in that
repo, and encoding "always" as "when relevant" hands the model a judgement it
will sometimes get wrong — after it has already edited something. The test:
*should the agent know this before its first action here?*

**Configurable paths to instruction files are not coming back.** That is
`contextFolders`, deleted on purpose. A path list is a claim about where files
are, written once and then wrong; the walk is a fact about where they are now.
The answer to "I cannot tell which files are in play" is to *show the walk* —
which the Context tab and `/context` now do — not to replace it with something
equally invisible and additionally stale.

### Scope is chosen at launch, never switched

`setScope` rebuilt the session store, the history, the memory manager, the
context manager and the prompt state in one call. Its own doc comment said
switching scope "is closer to opening a different project than to changing a
setting" — which is the argument against having it as a setting. The transcript
on screen belonged to the old scope while the switcher swapped the history out
from under it. `--scope` at launch reaches the same place with no such window.

### The live frame is the most important rule in `ui/`

When Ink's dynamic output is taller than the terminal it writes `ESC[2J ESC[3J`
plus a full repaint on **every** render. Measured on the pre-fix code, idle with
a 12-turn history at 24 rows: **108 full clears and 108 scrollback wipes in 15
seconds, 3.85 MB of escape codes**. That is what "it flickers and I can't scroll
or copy" was — the terminal's scrollback and the user's selection deleted seven
times a second.

It can overflow from **below** as well, which took longer to find: `liveBudget`
has a floor, so the frame had a *minimum* height and any shorter terminal
overflowed however much the turn gave up. Measured: 13 rows → 0 clears, 12 → 1,
**10 → 166**. Spacing is shed below the threshold and the floor comes down with
it; the practical floor is 9 rows.

**The jitter's second half was declined.** Committing each finished action to
`<Static>` as it completes would shrink the live region from ~22 rows to ~8 —
but the frame is ~13 rows of which 9 are fixed furniture, so it buys about 20%
for the seam that brought the scroll glitches back twice.

---

## Negative results — things measured and discarded

Kept so they are not re-tried.

- **The extension's "address theory" was wrong.** The reconnect, not the
  address, was the whole connectivity problem. Measured with the shipped bundle
  refusing every handshake: attempts at 4.7s, 20.7s, 50.7s, 80.7s — steady state
  **exactly 30.0s**, which is the `chrome.alarms` clamp floor. Phase 1 predicted
  sub-second and did not land. Headless Chrome reclaims service workers harder
  than a real browser, so that is a lower bound rather than a verdict.
- **The anti-throttling audio hack never worked, and not for the recorded
  reason.** `EXTENSION-PLAN.md` and two handoffs said the `<audio>` element was
  created and never appended. True, and not the bug — a detached `<audio>` plays
  fine in Chrome. The real reason is in its own catch block: autoplay policy
  blocks playback without a user gesture, and the fallback bound `click` and
  `keydown` with `{ once: true }`, which a **backgrounded** tab never receives.
  So it played in tabs that did not need it and stayed silent in the ones it
  existed for. Deleted; the Tab Wakeup Protocol is the mechanism that works.
- **`semantic_search`'s tokenizer split on non-alphanumerics only**, so
  `getUserById` was one token and the query `user` could never match it — broken
  for the query type that dominates code search. A broken tool is worse than a
  missing one, because the model reaches for it and concludes the code is not
  there.
- **`ast-chunker` resolved 24%** of this repo's top-level symbols: it walked
  `ast.body`, so every class method and every `export const foo = () => {}` was
  invisible, and plain acorn cannot parse `.jsx` at all.
- **The batch loop's flat re-serialisation was diagnosed as an oversight and was
  not.** Every batch turn opened a fresh tab that was closed when the turn
  ended, so turn 2 had never seen turn 1 — there was no thread to opt into.
  Measured at **81% resent** over ten turns before the tab was held for the life
  of the task.

---

## The write-only trap, twice

Worth its own section because it has now happened in two unrelated places and
will happen again.

`manage_memory add` wrote facts to `memory.json`, the system prompt instructed
the model to use it, and **no prompt ever carried a single fact back** — a tool
call per fact, forever, for nothing. `getAllMemories` had no callers.

The same shape turned up in `.agent/artifacts/task.md`: the model is told to
create a checklist and tick items off, the file is read only by the UI to draw a
row, and nothing carried it back. Verified absent from turn 0, from every
tool-result turn, and from twenty-five further turns. So ticking meant guessing
the exact line text for `edit_file`, which fails outright on a mismatch — and
the observed behaviour was a checklist that got created and never updated.

**If you add an artifact the model is told to maintain, the question to ask is
what carries it back.**
