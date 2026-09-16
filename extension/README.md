# Agent CLI Bridge — the Chrome extension

This is the half of the project that makes it work without an API key.

The Node server has no LLM client at all. It sends a prompt over a local
WebSocket to this extension, a content script **types it into a real chat tab**
you are already signed into, scrapes the streamed reply out of the page, and
sends the text back. Every design decision here follows from that one fact.

```
CLI  ──ws://127.0.0.1:7777──▶  service worker  ──▶  content script  ──▶  gemini.google.com
                      ◀──────  (reply text)   ◀──  (scraped DOM)   ◀──
```

---

## Current version: **1.4.0**

The panel prints its own version in the status bar, read from the manifest at
load — so it is the build Chrome actually has, not a number someone forgot to
update. If that badge and the version here disagree, **the extension has not
been reloaded**.

---

## Installing and updating

```
chrome://extensions  →  Developer mode  →  Load unpacked  →  select this folder
```

**Three artifacts ship from one repository and a `git pull` updates none of
them in the browser.** This is the single most common reason something here
"does not work" — the symptom is the agent going quiet, not an error.

| what | how it loads | what it needs after a pull |
| --- | --- | --- |
| `service-worker.js` | a **committed esbuild bundle** of `src/background/` | `npm run build --workspace=extension`, then Reload |
| `content-scripts/*.js` | loaded directly, never bundled | Reload **and a hard-refresh of the chat tab** |
| `side-panel/*` | loaded directly | Reload |

Editing anything under `src/background/` without rebuilding ships stale code:
Chrome runs the bundle, not the sources.

---

## Layout

```
manifest.json              MV3, side panel, three content scripts
service-worker.js          committed build artifact — do not edit by hand
src/background/            the sources it is built from
  main.js                  message router: panel ⇄ worker ⇄ server
  socket.js                the WebSocket, reconnect, server-message dispatch
  messaging.js             sendToServer / broadcastToSidePanel
  content.js               tab lanes, batch sessions, focus restoring
  state.js  policy.js
content-scripts/
  gemini-bridge.js         type into Gemini, scrape the reply
  chatgpt-bridge.js        the same for ChatGPT (subagents)
  github-bridge.js         PR comments
side-panel/                panel.html / panel.js / panel.css
test/                      jsdom tests, run by `npm test` from the repo root
```

**The two bridges are deliberately not merged.** ~600 duplicated lines, and
collapsing them was considered and declined: the jsdom tests run against *both*
files, so a scraping divergence fails the build — most of the value, none of the
risk of breaking both at once.

---

## Version history

Dates are when the work landed on `v1-stable`. Versions before 1.1.0 predate the
per-change history below.

### 1.4.0 — 2026-09-16

Three surfaces, one page — and two faults the screenshots caught.

- **The toolbar icon opens a popup.** Clicking the icon drops the panel down
  where you are looking, which is what people expect of an extension button.
  Chrome closes a popup when it loses focus, so the popup is a doorway: `⊟`
  docks it to the side panel, `⧉` floats it as its own window. A popup and a
  side panel cannot both own the same click, which is the trade.
- **The floating window said Disconnected over a working bridge.** `get_status`
  returned the *stored* flag, and `getState()` falls back to
  `connected: false` when nothing is stored — the state after the service
  worker is recycled. It reports the live socket now, and a panel that still
  finds itself disconnected asks the worker to connect.
- **Replies are rendered.** `**bold**` and `` `code` `` were shown as typed,
  and a multi-line answer like `/effort` was crammed into a status *pill* with
  no `pre-wrap` — a wall of run-together prose. Fenced blocks, inline code and
  bold now render; anything long gets a block instead of a pill. Escaping
  happens before formatting, so nothing the model writes can become markup.
- **The workspace can be changed from the panel** (`⌂`). Same code as
  `/workspace <path>` — validation, the supervisor check and the handover file
  live in `core/restart.js` so the two front-ends cannot disagree. It restarts
  the agent, so the socket drops and returns; that is the signal it worked.

### 1.3.0 — 2026-09-16

The panel looks like the rest of the product, and can leave the dock.

- **A floating window.** `chrome.sidePanel` is docked by design and no API
  floats it — Chrome's own Gemini panel sits in the same dock for the same
  reason. `⧉` opens this same page as a popup window instead: a real OS window,
  movable anywhere including another monitor. The button hides itself when it
  *is* the floating window, so one cannot spawn another.
- **The welcome screen stopped shouting.** A 48px cartoon face was the loudest
  thing on a panel whose job is to be quiet, and centred text goes ragged on
  every line in a monospace panel. Left-aligned now, with the slash commands as
  an aligned two-column grid rather than a centred staircase of pills.
- **The send button is muted until it can do something.** A solid blue tile was
  the brightest element on screen and was lit even with an empty box — drawing
  the eye to the one control that could not act. It now inherits the same
  disabled state the waiting-for-a-reply lock already sets, so it doubles as a
  turn indicator.
- **Mode reads `●` / `○`**, the two glyphs the CLI's own status bar uses,
  instead of 🔒 and ⚡. Filled acts on its own; hollow asks first.

### 1.2.0 — 2026-09-16

The side panel stopped being a half-finished surface.

- **The panel could not answer a blocked turn, so it hung.** `ask_question` and
  a risky `run_command` both park the turn on a promise with **no timeout** and
  send the prompt to the panel. The panel rendered neither, and no inbound
  message type existed for it to reply with — so the first question ended the
  panel's usefulness for the rest of the session, send button disabled. Both are
  now drawn and answerable (`question_response`, `command_approval_response`).
- **Streaming text reaches the panel.** Every chunk had been crossing the socket
  to be dropped, so the panel showed "Thinking…" for a whole turn and then
  jumped to the finished answer.
- **The reply scrape now converts nested lists correctly.** Indentation was a
  constant two spaces whatever the parent marker, so anything nested under a
  numbered item arrived flat — the shape Gemini uses for every set of steps.
  Loose list items broke straight after the marker and orphaned their own body.
  Measured with a markdown → HTML → scrape → markdown round trip: 11/15 before,
  15/15 after, and that probe is now a test.
- Panel UI refreshed: the version badge, a start command that is still real
  (`agent`, not `cd server && npm start`), and current slash commands.

### 1.1.0 — the browser half made reliable

- **Per-model tab lanes** (`main:<model>` / `sub:<requestId>`), so a ChatGPT
  review and a Gemini prompt genuinely overlap instead of racing for one tab.
- **Batch sessions hold one tab across a task's turns.** Every turn used to open
  a fresh tab that closed when it ended, so turn 2 had never seen turn 1 —
  measured at **81% of characters resent** over ten turns.
- **The prompt box and send button are found by shape**, not by a selector, so a
  site redesign degrades instead of breaking.
- **The reconnect was the connectivity problem, not the address.** Measured in
  headless Chrome: retries at 4.7s, 20.7s, 50.7s, 80.7s — steady state exactly
  **30.0s**, the `chrome.alarms` clamp floor.
- **Errors say what failed.** Worker errors carry `op`, `stage` and
  `targetModel`; content scripts prefix `[stage]` and the bridge lifts it back
  out, so a changed selector logs as `find_input` rather than "failed".
- **A reload is no longer reported as an error.** "This content script is
  orphaned" was a `console.warn`, which is what Chrome's Errors panel collects —
  an expected, self-repairing consequence of pressing Reload was listed as a
  fault.
- The code-block scrape was **deleting prose**, not merely mangling code.
- ChatGPT's image path *removed* the image block and pasted the rest, so a
  screenshot prompt discussed a picture nobody had been given.
- The tab is given back when a turn ends, and subagent tabs stop leaking.
- Dropped the Claude bridge along with `swarm` and `ask_reasoner` — 14 DOM
  selectors gone.
- Renamed to **Agent CLI Bridge**.
- A context meter in the panel was removed: the server never sends token counts
  to the panel, so it read a permanent 0% while context could be at 90%. A meter
  that is always wrong is worse than none.

### 1.0.0 — the bridge itself

Multi-model tabs, tab pooling and wakeup, image support, the side panel, the
first scrape, and the WebSocket protocol.

---

## Security

The bridge listens on **loopback only** (`127.0.0.1`) and checks `Origin`, so a
web page in your own browser cannot open it — pages arrive over loopback like
anything else, and browsers cannot forge `Origin`. Both were real: `new WS({
port })` binds to `::`, every interface, which had put an unauthenticated socket
that accepts prompts and runs shell commands onto every network the laptop
joined.

What remains: another process running as the same user on this machine can still
connect. Closing that needs a shared secret the extension can read, which needs a
setup step.

---

## Tests

```bash
npm test --workspace=extension     # jsdom, no browser, no network
```

They run the **shipped source**: `test/load-content-script.js` lifts a single
function out of a content script by brace matching rather than importing it,
because content scripts are not modules and stubbing enough of `chrome` to
evaluate one would test the stubs. Anything a lifted function closes over at
module scope is invisible to it — which is why the scrape's helpers are declared
*inside* `extractTextContent`.

What they cannot catch: "gemini.google.com changed its DOM", and "Chrome
reclaimed the tab differently than we assumed". Those need `TEST.md` in the repo
root and a real browser.
