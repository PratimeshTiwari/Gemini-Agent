# Agent CLI — server

The brain and the terminal UI. It has **no LLM API client**: inference happens by
driving a real browser tab. This process sends a prompt over WebSocket to the Chrome
extension, a content script types it into gemini.google.com, scrapes the streamed
reply, and sends the text back. Every oddity below follows from that.

For what the product does, see the [root README](../README.md). For why the code is
shaped this way, see [CLAUDE.md](../CLAUDE.md). This file is for working in `server/`.

## Running it

```bash
npm install                 # from the repo root — it installs both workspaces
npm start                   # workspace defaults to ../, i.e. this repo itself
npm start -- --workspace /path/to/your/project
npm run dev                 # the same, under tsx --watch
```

`src/index.js` is the bin and does nothing but re-spawn `src/main.js` under `tsx` —
the sources contain JSX, so plain `node src/main.js` fails. It is also the supervisor:
a `/restart` exits with a code it recognises and relaunches in place.

**There is no `npm link` step, deliberately.** It writes into npm's global prefix,
which on a managed or work laptop you often cannot write to, and `sudo npm link`
leaves root-owned files in a tree npm later tries to modify as you. `../setup.sh` asks
where to put the checkout and writes a two-line shim into `~/.local/bin` (or `~/bin`)
that calls it by absolute path — a directory you already own.

## Tests

```bash
npm test                                          # from the repo root
node --test server/test/core/risk-classifier.test.js
```

Tests live in `test/`, mirroring `src/` directory for directory — `src/core/paths.js`
is tested by `test/core/paths.test.js`. **Expected state: everything passes.**

Two things worth knowing before you trust a green run:

- **`# pass N  # fail 0` prints even when a suite failed.** Grep for `^not ok` too.
- **A passing test lies as readily as a broken one.** `toolCatalogDrift()` once
  compared an empty registry to an empty catalog and went green. Every new assertion
  wants a negative control — break the thing on purpose and watch the test fail.

## Layout

```
src/
├── index.js        bin shim + restart supervisor
├── main.js         arg parsing, migration, wiring, bootstrap
├── core/           the loop and everything it decides with
├── bridge/         websocket-server, extension-lock (one lane per tab)
├── context/        code-minifier, context-manager, memory-manager, symbol-index
├── mcp/            mcp-server.js + tools/ — the tool handlers
├── prompts/        static prompt prose as .md, loaded by prompt-loader
├── storage/        session-store (history, written to two places)
├── watcher/        chokidar; invalidates context on external edits
└── ui/             the Ink terminal front-end
```

### The parts of `core/` you will actually touch

| file | what it owns |
| --- | --- |
| `agent-loop.js` | the turn: send, parse tool calls, dispatch, feed results back |
| `prompt-builder.js` | what goes into each prompt, and what deliberately does not |
| `tool-catalog.js` | the single declaration of all 18 tools |
| `tool-policy.js` | who may run what — approval and the outright block |
| `loop-tools.js` | the three tools the loop answers itself |
| `diff-approval.js` | what happens between building a diff and it reaching disk |
| `diff-engine.js` | per-hunk accept/reject, backups, atomic writes, undo |
| `risk-classifier.js` | safe / risky / critical, per shell command segment |
| `effort.js` | the one ladder: flash · flash-thinking · brief · standard · deep |
| `paths.js` | every path under `.agent/`. Never hardcode that directory |

## Four rules that are load-bearing

**Adding a tool means three edits, not one.** The handler in `mcp/tools/`, an entry in
`mcp/mcp-server.js`'s `TOOL_DEFINITIONS`, and one in `core/tool-catalog.js` — which is
what the prompt is rendered from. `toolCatalogDrift()` fails the build if they
disagree. **The description is the contract**: six parameters the catalog never
mentioned were six the model never sent.

**Prompts are tiered on purpose, not as an optimisation.** The full system prompt and
tool definitions ride on turn 0 and every Nth turn; only the *tool anchor* (names
only, 56 tokens against 1,575) rides on every one. Resending a large payload every
turn trips Gemini's repetition and A/B-test filters. Every character is retyped into a
browser by a content script.

**Writes never go straight to disk.** `edit_file` and `create_file` produce a diff;
commands pass the risk classifier. What needs approving is decided in
`core/tool-policy.js`, from the catalog's own `mutates` / `shell` / `detached` flags —
not from a list at the call site, because the list at the call site is what drifted and
let `run_background` past every gate.

**The live frame must never outgrow the viewport.** This is the single most important
rule in `ui/`. When Ink's dynamic output is taller than the terminal it writes a full
clear and repaint on *every* render — measured at 3.85 MB of escape codes and 108
screen wipes in 15 seconds, which is what "it flickers and I can't scroll or copy"
was. Settled turns go to `<Static>`; only the in-flight turn is live; every live row is
bounded. A row that wraps is charged as one and drawn as two.

## State

Everything the agent writes lives under `.agent/` in the workspace — **import
`core/paths.js`, never hardcode it.** `paths.resolveState()` walks *up* looking for an
existing `.agent/` the way git finds `.git`, so a monorepo can share one.

Conversation history is written twice: next to the project, and under
`~/.agent/workspaces/<name>-<hash>/history.jsonl` so it survives a clean checkout.
The two are reconciled on startup — more turns wins.

## Two subsystems this file used to advertise, and why they are gone

Recorded because "the README said it did this" is a fair thing to be confused by.

- **AST chunking.** `ast-chunker.js` was deleted on 2026-09-10. It resolved 24% of
  this repo's own top-level symbols — it walked only `ast.body`, so every class method
  and every `export const foo = () => {}` was missed, and plain acorn cannot parse the
  `.jsx` files at all. `context/symbol-index.js` is the replacement that works, on
  acorn + acorn-jsx + acorn-walk, behind `find_symbol` and `find_references`.
- **A skills *framework*.** `SkillRegistry` was a second, parallel way to declare a
  tool, competing with the `TOOL_DEFINITIONS` that actually runs. Skills survive as
  what they should always have been: `.md` files under `.agent/skills/`, read when
  relevant. Nothing is "executed securely" — see `core/skills.js`.
