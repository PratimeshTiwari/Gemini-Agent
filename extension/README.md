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

## Current version: **1.24.0**

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
  github-bridge.js         PR comments
side-panel/                panel.html / panel.js / panel.css
test/                      jsdom tests, run by `npm test` from the repo root
```

**There is one bridge.** This used to say the two were deliberately not merged
— ~600 duplicated lines kept apart because the jsdom tests ran against *both*
files, so a scraping divergence failed the build. `chatgpt-bridge.js` was
deleted on 2026-09-19 and took that argument with it. The tests still run,
against the one bridge, and say in a comment **not** to restore a second target
to make the comparison mean something again: it was a side-effect of having two,
never a reason to have two.

**Every bridge is wrapped in an IIFE, and that is load-bearing.** The
content-script world outlives the script that created it, so a top-level `const`
makes a second injection throw `Identifier … has already been declared` before
a single statement runs. That is not a rare case: `sendWithRepairs` re-injects
precisely when a copy is already in the page. A new copy also calls
`window.__agentBridgeStop` first, so the orphan it replaces disconnects its
observers and clears its timers instead of ticking on.

---

## Version history

Dates are when the work landed on `v1-stable`. Versions before 1.1.0 predate the
per-change history below.

### 1.24.0 — 2026-09-19

- **One bridge.** `chatgpt-bridge.js` is gone, with its host permissions and its
  content-script registration. A second Gemini tab is what *duo* means now.
- **The bridge survives a second injection, and replaces what it finds.** Its
  constants sat at the top level of a world that outlives the script, so
  re-injecting threw `Identifier 'RESPONSE_IDLE_TIMEOUT' has already been
  declared` on line one and the fresh copy never evaluated. That silently
  disabled `sendWithRepairs`'s `reinject` rung — written for an orphaned script,
  which is exactly the case where a copy is already there to collide with. The
  rung did nothing and `waitForBridge` then spent its whole budget waiting for a
  script that had failed to load; the only evidence was an entry on
  `chrome://extensions`. Wrapped in an IIFE, plus a `window.__agentBridgeStop`
  handover so the orphan's observers and timers stop at once rather than when
  something next happens to call `safeSend`.
- **`new_chat` is acknowledged.** `/compact` is a handover — it summarises the
  old thread and sends the summary into a new one — and it cannot do that
  blindly. Without an ack, a new chat that never happened means the summary goes
  into the thread that already holds every turn it summarises.

### 1.23.0 — 2026-09-17

- **The end of a turn is noticed in a quarter second, not on the next tick.**
  Measured over 74 real turns from one machine's `traces.jsonl`, every
  `complete` landed on a ~2000ms boundary — 6004, 8966, 10001, 16002, 30064 —
  because a finished reply is only seen when the poll next fires. A reply that
  genuinely ended at 4.2s was delivered at 6s, and requiring two consecutive
  quiet checks (1.22.0, which stopped replies arriving truncated) added a
  second whole interval on top of that.

  Two independent observations is the right rule; waiting a *slow* interval for
  the second one is not. The cadence is now slow while the model is writing —
  where a fast poll buys nothing and just burns messages — and the tab reports
  `confirmSoon` the moment it goes quiet, so the worker comes back at a quarter
  of the interval for the confirming look.

- **`first_token` was measuring nothing, and it is the number that matters.**
  It was marked one line after the send, so it timed the gap between two
  adjacent statements: 0ms or 1ms on all 74 recorded turns. Everything real
  went into `complete`, which meant *Gemini thinking* and *our detection lag*
  could not be told apart — exactly the distinction needed to make turns faster
  without touching reasoning. It is now marked when the observer first sees
  response text.

### 1.22.0 — 2026-09-17

- **A reply is no longer cut off mid-sentence.** The turn ended on a single
  observation — no Stop button, and one second since the observer last saw the
  text change — and that was only ever safe because the check was being
  throttled. In a hidden tab it ran roughly once a minute, so a transient gap
  was almost never *sampled*. Moving the clock into the service worker (1.19.0)
  made the cadence reliable at 2s and the transients started getting caught: a
  reply arrived truncated mid-token while Gemini was still writing. Gemini
  pauses longer than a second between sections, and the Stop button is briefly
  absent while the composer re-renders; either alone looks exactly like
  "finished". The condition now has to hold across consecutive checks.

### 1.21.0 — 2026-09-17

- **The A/B modal is actually dismissed now.** Gemini's "Which response is more
  helpful?" holds two complete replies and resolves to neither until a button
  is pressed, so a turn that meets it never finishes — it waits out the
  five-minute cap and reports a timeout. The dismissal existed and never fired,
  for two reasons: it read `document.querySelector('h2, .title')`, which is the
  first such node in the *document* rather than the dialog's own heading, and
  it hunted for a button reading `Choice A` when the real control says **"This
  response is more helpful"** with its text two spans deep. An earlier repair
  here fixed a `:has-text()` SyntaxError and stopped, because nobody had seen
  the real DOM. Tests now run against that markup, and the previous
  implementation fails them.

  It **chooses** rather than retries: re-sending costs a whole turn, can raise
  the same modal again, and leaves two half-answers in the thread. It takes the
  first choice deterministically — there is no signal here that would make a
  quality judgement anything but a coin toss.

### 1.20.0 — 2026-09-17

- **A failing send now repairs the tab instead of giving up on it.** A failed
  send reaches the server as `tab_unreachable`, and the server's only answer is
  to abort the turn — yet nearly everything that breaks a send is transient and
  local to the tab: an orphaned content script, a discarded tab, a page that
  navigated, an interstitial. The ladder is send → re-inject → reload, cheapest
  repair first. **It stops there deliberately.** A reload returns to the same
  `/app/<id>` and Gemini still has the thread; a fresh tab is a fresh
  conversation, and an incremental prompt sent into one gets a confident answer
  to a question the model never saw.

- **A prompt that never reached the composer is sent again, once.** The content
  script already knew the difference and threw it away. If it saw Gemini
  generating, the model has an answer we failed to read, and resending would
  ask the same question twice into a thread that already holds the first reply.
  If generation never started and nothing was scraped, the submit did not
  happen — the model has no idea the turn exists, so sending it is the first
  attempt landing rather than a repeat. Only the second case retries, it
  retries once, and it resends the **verbatim** bytes: rebuilding the prompt
  would mark the system prompt as already seen and hand the model a bare
  question with no tools.

### 1.19.0 — 2026-09-17

- **A turn no longer needs the tab in front.** Completion was detected by a 2s
  `setInterval` in the content script, and Chrome throttles page timers in a
  hidden tab — which is the entire reason this extension activated the model
  tab and held your focus for the length of a turn. Measured on example.com in
  a genuinely hidden tab, Chrome 152, over 334 seconds:

  | mechanism | delivered | expected |
  | --- | --- | --- |
  | page `setInterval(100ms)` | 63 | 3340 (**1.9%**) |
  | Worker `setInterval(100ms)` | 3344 | 3340 (100%) |
  | `MutationObserver` | 10/s throughout | 10/s |
  | `getBoundingClientRect()` | 3213 real boxes | 0 empty |

  So the scrape was never the problem and neither was layout — only the clock
  was, and it degraded to roughly one tick per minute within 60 seconds of the
  tab being hidden, holding there past the five-minute intensive-throttling
  boundary. A service worker is not a tab and is not throttled, and
  `chrome.tabs.sendMessage` is an event rather than a timer, so the worker now
  drives the check over `tick_completion` at full rate while the evidence
  stays in the page. The local interval remains as a backstop for a worker
  that has been evicted mid-turn.

- **Focus comes back when the prompt lands, not when the reply does.** It was
  held for the whole turn because giving it back early meant completion took a
  minute to notice. With the clock outside the tab, the tab only has to be in
  front long enough to accept the paste.

- **Model tabs are opted out of discarding, and repaired if they were.** Chrome
  discards background tabs under memory pressure: the tab stays in the strip
  and looks fine while the page and its content script are gone.
  `autoDiscardable: false` asks Chrome not to, and a tab found already
  discarded is reloaded and re-handshaked rather than reported unreachable.

### 1.18.0 — 2026-09-17

- **The reconnect alarm now outlives the connection.** It was created on retry
  and cleared on `onopen`, so a *healthy* bridge had no alarm at all. Chrome
  can still evict a service worker that believes it is connected, and when it
  does the socket dies with it: `onclose` never runs inside a worker that is
  already gone, no timer survives it, and nothing outside the browser can wake
  it. What actually revived it was the user focusing a tab and
  `chrome.tabs.onUpdated` starting the worker to deliver the event — which is
  exactly the reported symptom, "the prompt only sends once I open Chrome".
  The alarm is periodic and permanent now; while connected it costs nothing,
  because the heartbeat already keeps the worker resident.

- **The send path asks the tab whether it is ready instead of sleeping.**
  4000ms after opening a subagent tab, 1500ms after a new main tab loaded and
  1000ms after re-injecting were flat `setTimeout`s — 6.5 seconds of
  unconditional waiting per new tab, and wrong in both directions: seconds
  wasted on a warm machine, and still too early on a cold one, where the send
  lands before the listener exists and is reported as an unreachable tab. A
  `ping` the content script answers replaces the guess with the fact. It
  reports two things, because they fail differently: `ready` (this script is
  listening and not orphaned) and `canType` (the composer is actually in the
  DOM). The tail of the budget accepts `ready` alone, so a changed composer
  selector still produces a real send error rather than burning the budget.

### 1.17.0 — 2026-09-17

- **Reopening the sidebar keeps the conversation.** The server sent history
  when the **socket** connected — and opening the side panel does not reconnect
  anything: the service worker holds one socket for the whole browser session.
  A panel opened afterwards is a fresh page arriving mid-connection, and the
  connect-time send had already happened, to a page that no longer existed. It
  asks now (`get_history`) rather than waiting to be told, and the connect-time
  send stays for the case where the panel is already open when the socket comes
  up.

### 1.16.0 — 2026-09-17

- **Resuming reopens the conversation instead of describing it.** The owner's
  point, and it is the better design: a recap is a paraphrase, the chat thread
  *is* the memory. Gemini puts it in the URL, so the tab is pointed back at
  `/app/<id>` and the model has the real history — including everything a
  twelve-turn summary would have dropped. The recap survives only as the
  fallback for a session that never reached a thread, or a browser that could
  not open one, and the extension reports which happened.
- **A tab you opened is never navigated away.** `openThread` moves the lane's
  own tab or opens a new one; taking over someone's own conversation is the bug
  the ownership rules exist to prevent.
- **`+` and `↺` in the header** — a new chat, and past conversations. Neither
  is destructive: `+` files the conversation it replaces and `↺` is where it
  went, which is what makes a one-click button reasonable.

### 1.15.0 — 2026-09-17

- **Past conversations, from the panel** (`☰`). The storage and the
  `--sessions` flag landed before there was any way to reach them from here,
  which is the same as not having them. A drawer rather than a column: the
  panel is narrow and a permanent list would cost the conversation half its
  width.
- **Each row says what resuming would actually do.** "The tab still holds this"
  or "needs a recap" — different promises, and the reason the browser thread id
  is recorded at all. The model's memory is the chat thread, not our
  transcript.
- **Resuming into a moved-on tab carries a recap.** Restoring a transcript
  gives the model nothing, so it would answer confidently about work it never
  did. One turn only, bounded, tool traffic left out, and framed as background
  rather than as something it remembers doing.

### 1.14.0 — 2026-09-17

- **`/new` works from the panel.** It lived in the CLI's slash-command hook, so
  the panel sending it was told "No such command" — the same shape as `/name`
  answering that while fully implemented. The substance moved to the shared
  handler; each front-end still clears its own view, which is the only part
  that genuinely differs. It **files** the old conversation rather than
  destroying it, and takes the artifacts with it, so a finished checklist does
  not survive into the next task.
- **`/new` and `/clear` replace what the panel is showing.** They left the old
  transcript on screen, which reads as though nothing happened — and the panel
  would then restore that dead conversation the next time it opened.

### 1.13.0 — 2026-09-17

- **Reopening the panel no longer looks like losing the chat.** It never was
  lost: `SessionStore` writes every turn to disk twice, on every turn. But the
  panel is a browser page with no filesystem, so it started from an empty DOM
  and nothing had ever offered it the record — the same shape as the task list.
  The server hands over the last 40 conversational turns on connect, says how
  many it held back, and leaves tool calls on disk: they are most of the bytes
  and a restored view of them is a wall of JSON where a conversation should be.

### 1.12.0 — 2026-09-17

- **An orphaned window says so instead of blaming the agent.** Reloading the
  extension orphans every page already open from it: the page keeps running,
  `chrome.runtime.id` disappears, and every call throws. Nothing repairs it —
  not polling, not reconnecting — because what is gone is the link, not the
  socket. A **floating window** survives the reloads that close and reopen the
  docked panel, so it is the surface most likely to be orphaned, and it had
  been reporting "Disconnected" — sending the reader after a problem with the
  agent when the window simply needed reopening. The content scripts have
  detected this by the same test for a while; the panel had not.

### 1.11.0 — 2026-09-17

- **The checklist belongs to its turn, not to the input box.** Pinning it above
  the prompt was wrong in the way that matters: a finished list stayed under
  the box while you typed the next, unrelated request, so the most prominent
  thing on screen was a plan that no longer applied. It renders in the
  transcript now, like the review, and scrolls away with the turn that made it.
- **A finished checklist tells the model it is finished.** `task.md` is one
  file reused for every task, so a completed list kept arriving on every later
  prompt including the first of something unrelated. Given ticked boxes and no
  framing, the model cannot tell "you already did this" from "this is the plan
  for what you are being asked now" — and both natural mistakes are bad. The
  block now carries `state="complete"` and says to write a new list if the
  request is a different one.
- The model's own bookkeeping (`<!-- id: 10 -->`) is stripped from item text.

### 1.10.0 — 2026-09-17

- **The checklist, above the input.** The terminal draws the agent's plan
  because it reads `.agent/artifacts/task.md` off disk; a browser page cannot,
  so the panel was the one surface where that plan was invisible. The server
  pushes it at turn boundaries. One row collapsed — `2/4` and the next
  unfinished item — with the full list a click away, and it is **replaced**
  each turn rather than appended, because a checklist is current state and a
  transcript of sixteen versions of it is the mistake the connection rows
  already made once.
- **The handover review folds.** Every pro-tier reply now ends with a fixed
  `## Review` block; it is the most important four lines of a turn and the
  least interesting to re-read, so it collapses to its first fact. Matched on
  shape rather than wording, so rephrasing the prompt cannot silently stop it.
- **The send button lights up when there is something to send.** Muted-until-
  useful was half the idea — without the other half the button looked equally
  dead whether the box was empty or full.

### 1.9.0 — 2026-09-17

- **Block statuses are left-aligned.** `.message-status` is centred, which is
  right for the pill it was built for ("history cleared") and wrong for
  everything else arriving on the same channel. `/effort` is a ladder written
  for a monospace terminal, with its own leading indentation — centring it
  re-ragged every line and threw that indentation away, so the ladder read as a
  column of loose text. The pill stays centred; anything long enough to be a
  block is prose and is set left, with `pre-wrap` keeping the terminal's own
  alignment intact.

### 1.8.0 — 2026-09-17

- **The panel stopped narrating its own connection.** Every retry tick appended
  "🔴 Disconnected from agent server" to the transcript, and the retry ladder
  fires repeatedly by design while the agent is not running — a screenshot
  showed sixteen identical rows and no conversation left on screen. The dot in
  the status bar had been saying the same thing all along, in one row. It is
  said **once, at the point of use**: try to send while disconnected and the
  panel explains, naming both causes it cannot tell apart — no agent running, or
  an agent running behind a stale bridge (hard-refresh the tab, or reload at
  `chrome://extensions`). Identical consecutive statuses also collapse now, so
  nothing can fill the panel with one repeated sentence again.

### 1.7.0 — 2026-09-17

- **The connection dot polls instead of guessing once.** `connection_status` is
  broadcast only when the socket *transitions*, so a panel opened while it was
  already up received nothing and had a single sample to go on — `get_status` at
  load. One sample is wrong by construction here: MV3 recycles the service
  worker constantly, and a worker woken *by that very message* has no socket
  yet. The visible result was a floating window reading "Disconnected" over a
  working bridge while the docked panel two inches away read "Connected". It
  re-reads every four seconds, and on focus, since a floating window can sit
  behind the browser where Chrome throttles timers. Only the first check asks
  the worker to connect — repeating that would restart the retry ladder every
  few seconds and pin the backoff at its first rung.
- **Tool arguments read as something.** `questions: [object Object],[object
  Object]` was an array interpolated into a template. Arrays are counted, objects
  fall back to the field a reader recognises, long strings are cut.

### 1.6.0 — 2026-09-17

- **Attribute injection in the panel, fixed.** `escapeHtml` was
  `textContent` → `innerHTML`, the usual idiom, which escapes `<` `>` `&` and
  **not quotes**. Every template here also interpolates into attributes
  (`data-value="…"`), so an option label of `" onmouseover="…` closed the
  attribute and the rest parsed as markup — jsdom built a real event handler
  from it. That text is scraped off gemini.google.com, so it is third-party
  input, and the panel is an extension page with `chrome.*` in scope.
- **Questions render like the terminal's.** `ask_question` args are parsed out
  of model prose and nothing in them is guaranteed — options arrive as a bare
  string, as objects, or missing. The server normalises now
  (`core/question.js`), so both front-ends get one clean shape instead of the
  panel needing its own copy of the rules. The question's header is shown.
- **A question can only be answered once**, guarded by a flag rather than by
  the disabled attribute — a real browser will not click a disabled button, but
  that is the DOM enforcing a protocol invariant.

### 1.5.0 — 2026-09-16

- **The agent never types into a Gemini tab you opened.** It used to fall back
  to the newest matching tab, which its own comment described as adopting "the
  tab the user opened themselves". Combined with MV3 that was the *ordinary*
  path, not a rare one: the lane map is module state, so every service-worker
  recycle — and the reconnect cadence has a 30-second floor — made the
  extension forget its own tab and take whichever was newest. Your personal
  conversation would get the system prompt typed into it and be scraped back.
  Ownership is explicit now and kept in `chrome.storage.session`, which lasts
  exactly as long as a tab id does.
- **Pick a workspace with the real macOS chooser** (`⌂`). An extension page
  cannot open a native dialog — `<input webkitdirectory>` hands back a copy of
  the directory's *contents*, never its path — but the agent is on the same
  machine, so it opens the same dialog the CLI uses and the panel gets the
  result. Typing a path is the fallback where no chooser exists.

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

- **Per-tab lanes** (`main:<model>` / `sub:<requestId>`), so a subagent review
  and your own prompt genuinely overlap instead of racing for one tab.
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
