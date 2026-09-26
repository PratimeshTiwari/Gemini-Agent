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

## Current version: **1.35.0**

**Since 1.26.0 the CLI checks this for you.** The extension reports
`chrome.runtime.getManifest().version` — read out of the bundle Chrome actually
loaded — on the `identify` handshake, and the server compares it with the
manifest in this checkout. If they disagree you get one row at connect time
saying so, and `/settings → Status → Extension build` answers it any time after.

That check exists because the version on `chrome://extensions` is not evidence.
On 2026-09-24 it read **1.25.0** while the loaded copy still had
`github.com/*` site access — a permission removed from this manifest on
2026-09-19. Six `model_options_unanswered` failures were investigated as a
broken picker selector; the selectors were fine, and the build was three weeks
stale. A number in a manifest is something a person typed. `getManifest()` is
what Chrome is running.

**An extension older than 1.26.0 reports no version at all**, so silence is
itself the answer, and the CLI says so in as many words.

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
manifest.json              MV3, side panel, one content script
service-worker.js          committed build artifact — do not edit by hand
src/background/            the sources it is built from
  main.js                  message router: panel ⇄ worker ⇄ server
  socket.js                the WebSocket, reconnect, server-message dispatch
  messaging.js             sendToServer / broadcastToSidePanel
  content.js               tab lanes, batch sessions, focus restoring
  state.js  policy.js
content-scripts/
  gemini-bridge.js         type into Gemini, scrape the reply
side-panel/                panel.html / panel.js / panel.css
test/                      jsdom tests, run by `npm test` from the repo root
```

**There is one content script, and one bridge.** `github-bridge.js` read PR
comment bodies off github.com and went with the GitHub agent on 2026-09-19;
`chatgpt-bridge.js` went the same day. Both are gone from `manifest.json` too —
and that matters more than it sounds, because emptying an entry's `matches`
rather than deleting the entry makes Chrome refuse **the whole extension**,
which is how a one-line edit took out the bridge, the side panel and the worker
at once. `test/manifest.test.js` exists for that.

This used to say the two bridges were deliberately not merged
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

> **Reading 1.28.1 → 1.34.0.** These seven entries are one bug being chased,
> and four of them fixed the wrong thing. The cause was found in **1.34.0**:
> the service worker had no relay case for `model_options`, so the picker's
> answer was discarded one hop before the socket — while the picker itself had
> been read correctly the whole time.
>
> Everything before that is a theory tested by shipping it, and two of those
> theories *caused* the next entry's bug. They are kept because the reasoning
> that produced them is the reasoning that would produce them again, and
> because two of the measurements taken along the way — the hidden-tab timer
> figures and the live-page picker timings — are load-bearing elsewhere.
>
> The corrections are marked in place. 1.28.1's account of its own fix is
> disproved by a measurement recorded in 1.28.2.

### 1.35.0 — 2026-09-26

Cleanup of what accumulated while the model switch was being chased. No new
behaviour except the first item.

- **The mismatch row is silent while a switch is in flight.** `modelMismatch`
  recomputes on every render from `modelOptions`, and at the instant a switch is
  dispatched that list still holds the *previous* read — so the warning appeared
  directly under the row announcing the switch, contradicting it. Reported with
  a transcript showing exactly that pair. It was true at that instant, which is
  why this suppresses rather than corrects: the row is about a **standing**
  disagreement, and a fresh reading ends the suppression whether it agrees or
  not.
- **`picker_trace` is gone.** It existed to name the failing hop, it did that,
  and leaving it would cost a log row per turn forever. `extension_unreachable`
  and the relay-drift test stay — those are the durable half.
- **Four matching strategies became two: a config pin, then structure.** The
  `\bpro\b` anchor could only help a build that reports no modes *and* still
  calls its top model Pro — narrower than the word lists it sat in front of,
  for a third answer to one question. The word lists went with it: `INTENT`,
  its `prefer`/`avoid` scoring, and the loop over them. Position answers every
  case they answered and several they could not.

  A floor came with it: when the page cannot say which entries are modes, a
  picker offering **one** entry is not enough to infer a ladder from — `Canvas`
  alone would otherwise read as "the only model" and be switched to, and a
  wrong switch is worse than no switch. Counted on what the picker offered, not
  on what survived the mode veto.
- **`sameModelName` is gone, and the settle-wait no longer knows any names.**
  It asked whether the trigger's new label matched what the server requested,
  loosely, because the picker says `3.1 Pro` where the server said `Pro`.
  `markSelected` already answers *which* option is selected, by position and
  authoritatively — so the wait only needs to know the component has stopped
  moving, and "different from before" says that without a product name.

### 1.34.0 — 2026-09-26

**This is the one. The worker was throwing the answer away.**

- **`model_options` had no case in the worker's relay, so it hit `default` and
  was dropped one hop before the socket.** The content script read the picker
  correctly the entire time — measured against the live page at 27.7ms,
  returning every option with `selected` correct — handed the list to
  `safeSend`, and the service worker discarded it. The server then waited out
  every budget it had and reported, accurately, that nothing came back.

  `gemini_response` *is* in that list. That one difference is the whole of
  "prompts work but `/effort` and `ctrl+b` do not": one path was relayed and
  the other was not. `error` and `picker_trace` were being dropped too, which
  is why the content script's own failures never surfaced either — the
  `discover_models` rows that did appear came from the *worker*, by a different
  route.

  Five releases of fixes were aimed at every hop except this one.

- **An unrelayed message now reports itself.** The `default` arm answered the
  *sender* — a content script that ignores the reply — and told the server
  nothing, so a message vanished between two processes with no trace in either.
  It now logs to the server as well as the console, because MV3 evicts this
  worker constantly and takes its console with it. That is why the console read
  empty every time it was checked.

- **`test/background/relay-drift.test.js` makes the class impossible.** It
  derives the list of types the *content script* sends from the content
  script's own source and asserts the worker handles each one — a
  hand-maintained list being exactly what drifted. It caught a second dropped
  message, `content_script_ready`, before it had finished being written; that
  one is worker-local news and is now absorbed rather than relayed.

  CLAUDE.md already stated the rule, about the side panel: *"a surface that
  ignores an unknown message type is not equally harmless for every type.
  Dropping a notification costs a missing line; dropping a request deadlocks
  whatever is waiting on the answer."* The worker is such a surface, and
  nothing was checking it.

### 1.33.0 — 2026-09-26

**Instrumentation, not a fix.** The model switch has now failed five times in a
row, and each attempt was a different theory tested by shipping it. This build
stops that: it makes the path say which hop failed.

- **"Nothing came back" was true of five different faults.** Nothing connected
  to ask; no tab to ask in; a tab whose content script is an orphan; a read that
  threw; a read that was declined. The server could only ever report the last
  effect, and every one of those wants a different fix. `picker_trace` rows now
  mark each hop — sent, reached a tab, read started, options arrived — and land
  in `/logs extension` beside the failures.

  In the service-worker console rather than the log would have been useless:
  MV3 evicts the worker constantly and takes its console with it, which is why
  it reads empty by the time anyone opens it.

- **A message sent to nobody is no longer indistinguishable from a message
  ignored.** `broadcast` has always returned whether it found a client, and
  `_toExtension` threw it away — so `discover_models`, `switch_model`,
  `focus_tab`, `new_chat` and `open_thread` could each be sent into an empty
  room and look exactly like the browser failing to answer. CLAUDE.md records
  the cost of ignoring this same return once before, on `injectPrompt`. It now
  logs `extension_unreachable`, naming the message.

  The CLI's own `sendToPanel` had to start returning that answer too; it
  broadcast and discarded the result.

### 1.32.0 — 2026-09-26

- **A picker read is repaired like an inject, instead of dying quietly.**
  `sendToModelTab` used a bare `chrome.tabs.sendMessage` while the inject path
  has always gone through `sendWithRepairs`. That gap bit hardest in the one
  situation this feature is used in — **right after the extension is reloaded**,
  which is how a new build gets loaded at all.

  A reload orphans the content script already in the page. The orphan's listener
  is still registered, so Chrome delivers to it and `sendMessage` resolves:
  nothing throws, nothing is reported. But the orphan's own `chrome.runtime`
  calls fail, so the reply never leaves the page. The server then waits out its
  whole budget on an ask that was answered by a corpse — silence, with a success
  on the worker's side of it. Now it re-injects the bridge and asks again.

- **A deferred read is no longer a dropped one.** 1.29.0 made
  `discover_models` decline while a prompt was going in — correct, since a menu
  over a live composer swallows the send — but it answered the *worker* and sent
  the *server* nothing, so the server waited out its full 20 seconds and
  reported that the browser never answered. CLAUDE.md names this exactly:
  dropping a notification costs a line, dropping a **request** deadlocks
  whoever is waiting on it. The read now runs the moment the inject finishes.

- **"Was the prompt actually sent?" is observed, not inferred.** Proposed by
  the owner: *"check whether Gemini's input box still has our pasted text — if
  the text is there it was not sent, so retry."*

  `neverSubmitted` was `!isGenerating && !sawGenerating`, which is equally true
  when generation *did* start and a changed selector stopped us seeing it — and
  a resend there asks a thread that already holds the answer. Gemini clears the
  composer when it accepts a prompt, so text still sitting in it is proof the
  submit did not happen, and an empty composer is proof it went.

  **The second half is the valuable one**: it is a brake on the resend, not an
  accelerator. Compared as a whitespace-collapsed prefix, because the editor
  reflows what it holds. A composer that cannot be found reports `null` rather
  than `false`, which hands the decision back to `sawGenerating` instead of
  asserting the prompt was sent.

### 1.31.0 — 2026-09-26

- **The models are read from the page; no product name is hardcoded anywhere.**
  Asked for directly: *"stop hardcoding Pro, Flash and all — read the model name
  straight from the web, so we are always in alignment and there is no
  mismatch."*

  The picker already separates its models from its modes with a rule, and that
  rule is a real element. Walked in DOM order against the live menu:

  ```
  3.5 Flash-Lite
  3.8 Flash
  3.1 Pro
  ──────────────   <mat-divider>
  Extended thinking
  ```

  That boundary agrees exactly with what Gemini's own `⌘⇧M` cycles — the three
  above the line, wrapping, never Extended thinking. Two independent views of
  the same split.

  So the content script reports `isMode` per entry, and the rung maps onto
  **position alone**: lightest first, heaviest last, the middle rung one below
  the heaviest. `lite`, `flash` and `pro` no longer need to appear in any label,
  and neither does `extended` or `complex` — the veto that used to be a guess
  about English, which would have broken on a fourth mode or a rename.

  Proved by matching a picker with every name changed, Pro included:
  `Zephyr / Cirrus / Cumulus / Deep Reasoning` resolves correctly, as does a
  mode called `Agent mode` that contains none of the vetoed words.

  Both older strategies are kept **behind** it, in order: a config pin still
  wins outright, and a build too old to report `isMode` falls back to the Pro
  anchor, then to the word lists.

- Removed `RESPONSE_ACTIVITY_TIMEOUT`, defined and never read.

### 1.30.0 — 2026-09-26

- **The deadline could not outlast the work it was waiting on.** 1.29.0 let a
  user-initiated ask *open* a tab when there was none. `ensureModelTab` budgets
  **8000ms** for the page to load and a further **5000ms** for the bridge to
  answer — thirteen seconds against a watchdog of **eight**. So the watchdog
  fired while the tab was still loading, every time, and reported *"the browser
  never answered"* about an ask that was proceeding normally.

  The fix for the missing tab created a deadline that guaranteed the failure it
  was meant to remove, and from the transcript it looked identical to the
  original bug — which is why it took a fourth pass to see. A user-initiated ask
  now gets a budget derived from `ensureModelTab`'s own worst case; the
  background poll, which opens nothing, keeps the eight seconds.

- **And a throw while opening that tab vanished.** The `await` was unguarded, so
  a rejection propagated out of `handleServerMessage` into `ws.onmessage`'s
  catch — which logs *"unparseable server message"* about a message that parsed
  perfectly — and skipped `sendToModelTab`, so the tab-failure report never
  fired either. The server saw pure silence and blamed its own watchdog.

- **Models are matched by the picker's order, anchored on Pro.** Reported by the
  owner: *"Pro is the main identifier — Flash-Lite and Flash change across
  different Google accounts, only Pro is constant, even the versions change."*
  That undercuts the word lists for two rungs of three: `lite` reaches for
  `fastest`/`lite` and `flash` for `thinking`/`flash`, and neither word is
  promised to anybody.

  The order is stable, and it was verified against the live picker by cycling it
  with Gemini's own `⌘⇧M`, which walks the models and nothing else:
  **Flash-Lite → Flash → Pro → Flash-Lite**. Lightest first, Pro last, and
  Extended thinking is *not in the rotation* — a mode rather than a rung, which
  is what `avoid: ['extended','complex']` always encoded by hand.

  So Pro is found by name (`\bpro\b`) and the rest by position relative to it,
  with modes dropped before positions are counted. Clamped rather than wrapped:
  on a two-entry plan the middle rung collapses onto the lightest, because
  wrapping would send it to Pro — the pairing CLAUDE.md names as the worst
  available. The word lists stay as the fallback for a plan with no Pro in it,
  which is the case they were actually written for.

- **`⌘⇧M` itself cannot be used, and that is a platform boundary.** The shortcut
  works and switches without opening the menu at all, which would have removed
  this entire class of bug. It cannot be driven from an extension: synthetic
  `KeyboardEvent`s carry `isTrusted: false`, and Gemini ignores them. Tested
  across `window`, `document`, `body` and the composer, with `keydown`,
  `keypress` and `keyup`, and both `m` and `M` — nothing moved, while a real
  keypress moved it every time. Only `chrome.debugger` can send trusted input,
  and it shows a permanent "debugging this browser" banner.

### 1.29.1 — 2026-09-25

- **The switch worked; confirming it is what broke the turn.** `switch_model`
  opened the menu **twice** — once in `selectModelByLabel` to click the option,
  and again in `readModelOptions()` to read `selected` back off the items. The
  second open is the one that sat across the composer while the session's first
  prompt was being typed into it, so the send landed on the backdrop.

  Reported with two screenshots, and they show the switch **succeeding**: the
  trigger reads `Pro` and `3.1 Pro` carries the tick. The box around
  `3.5 Flash-Lite` is the `active` class — keyboard focus on the item the menu
  opened on — which is not selection, and is the trap `describeModelOption`
  already warns about in a comment.

  `currentModelLabel` exists for exactly this: the trigger's `aria-label` reads
  `Open mode picker, currently Pro`, one DOM query, no interaction. Its own
  comment says to use it *instead of* `readModelOptions` here, and that advice
  was simply not taken. `selectModelByLabel` now describes the items from the
  open it already performed and re-derives the selection from the trigger, so
  the whole switch is one menu open.

- **"Which one is selected" cannot be a substring test.** The trigger says
  `Flash`; the menu offers `3.8 Flash` *and* `3.5 Flash-Lite`, and both contain
  it — with Flash-Lite first in the DOM. So the obvious implementation confirms
  the *lite* model when you switched to Flash, on the one path whose purpose is
  to report the truth rather than the request. Dropping the leading version
  token makes it decidable (`3.1 Pro` → `Pro`, `3.5 Flash-Lite` →
  `Flash-Lite`); substring survives as a fallback under `pickModelFor`'s rule
  for pins — one hit is an answer, several are not.

- **A failed switch now says what you are running on.** Asked for directly:
  *"if effort fails to select, print the current selected model — continuing
  with model X, change it manually as auto failed"*. The old rows said the
  picker could not be read and left you to go and look, which is the job the
  switch exists to do. Both failure paths — no answer, and a refusal — now name
  the last model seen selected, as **last seen** rather than in the present
  tense, and name nothing at all rather than guess when there has never been a
  reading.

### 1.29.0 — 2026-09-25

- **A picker operation you asked for may open the tab it needs.** This is the
  root of *"the effort never changes"*, and it survived two fixes aimed at the
  wrong layer.

  Every other stage works, measured against the live page in a hidden tab: the
  menu opens in 41.9ms, a full read takes 27.7ms and returns all four options
  with `selected` correct, and the real matcher resolves that list to
  `3.1 Pro` for the pro rung. What none of it could do is **get a tab**.
  `sendToModelTab` uses the lane's *existing* tab, while the inject path has
  always had `ensureModelTab`, which opens one when there is none. So the
  picker could only be read *after* the first prompt had already gone out —
  and `/effort` is typed *before* the first prompt almost every time. It
  printed `asked the browser for Gemini Pro` and nothing ever followed, which
  reads like a status rather than a dead end.

  1.28.2 moved discovery onto tab *creation*, which fixed the connect-time ask
  and not this one: tabs are created by injects, so a session opening with
  `/effort` still had none. Reported again immediately, with a transcript of
  three `/effort` commands in a row on a fresh session.

  `userInitiated` is the whole safety argument, and it is a real distinction
  rather than a flag: a background poll must never make a window appear to
  answer a question nobody asked, and a command you typed and are waiting on is
  the opposite case — the row it prints already says `ctrl+b` shows the tab. A
  session-scoped ask is excluded too, because a subagent's tab is its own and
  opening a main tab for it would read the wrong picker entirely.

### 1.28.2 — 2026-09-25

- **The budget is 3000ms, and the reason first given for that was wrong.**
  1.28.1 claimed the literal `1000` was a 20× cut of an effective ≥20s budget
  and blamed it for the timeouts still being logged. Measured afterwards
  against the live page, in a genuinely hidden tab: the menu renders in
  **41.9ms**, and a full `readModelOptions` — open, scrape four options, read
  `selected`, close — takes **27.7ms**. 1000ms was already 35× more than the
  work needs, so the cut was real arithmetic about the old code and **not** a
  cause of anything. 3000ms is kept as cheap headroom, not as a fix.

  The same session measured the premise underneath 1.28.0, which **does** hold:
  28 chained `setTimeout(…, 50)` — nominal 1.4s — did not complete in **45
  seconds** in that hidden tab, while the `MutationObserver` path did the same
  work in 28ms. Moving off page timers was right; re-explaining a later symptom
  with it was not.
- **A menu that opens after we stop waiting is now closed anyway.** The close
  clicked only when `aria-expanded` was true *at that instant*, so a budget
  that expired a moment before the component set the attribute left the picker
  up with nobody to close it. This README already says what that costs: a menu
  left open swallows the next click, so the *following* turn types its prompt
  into the composer and the send lands on the backdrop. The tab then looks
  dead, two turns away from the discovery that caused it. Reported with a
  screenshot showing exactly that. The close is asynchronous and still not
  awaited, so the model list is not held behind cleanup. Kept as robustness —
  with the menu rendering in 42ms against a 3000ms budget, the window it
  guards is now vanishingly small.
- **The picker is read when a tab is created, which is when one exists to
  read.** Discovery was scheduled on a **connection** — 1.5s after the
  extension identifies — but it depends on a **tab**, and an open socket does
  not imply one. At connect there is usually no owned tab, so the ask reached
  nothing, `modelOptions` stayed empty, `pickModelFor` had no list to resolve a
  rung against, and routing fell back to whatever the tab was already on. That
  is the whole of *"the effort never changes"*: the status bar reads PRO, the
  tab runs Flash, and nothing can compare them. Logged verbatim 13 times as
  `discover_models — no gemini tab this extension owns`, every one at connect.

  `ensureModelTab` now asks the moment it claims a tab, before anything is
  typed into it. `discover_models` also declines while an inject is running,
  because a menu over a live composer swallows the send.

  **Verified end to end against the live page rather than argued:** the scrape
  returns all four options with the right descriptions and `selected` correctly
  on `3.8 Flash` (the `selected` class — note `active` sits on `3.5 Flash-Lite`,
  exactly as the code comment warns), and feeding that list to the real matcher
  resolves `lite → 3.5 Flash-Lite`, `flash → 3.8 Flash` (already there),
  `pro → 3.1 Pro`. Every stage works; only the ask was arriving too early.

### 1.28.0 — 2026-09-25

- **The mode picker is read off the page's clock, which a hidden tab does not
  run.** The picker is *always* read hidden: `discover_models` and
  `switch_model` are messages to the tab rather than turns, so nothing brings it
  to the front first — unlike an inject, which activates the tab to paste. Both
  waited on chained `setTimeout` polls, and Chrome clamps those to one per
  second in a hidden tab and one per *minute* once intensive throttling starts.
  So a nominal `20 × 50ms` to open the menu plus `8 × 50ms` to confirm it closed
  — the second inside the `finally` the answer returns through — was really 28
  seconds or worse, against a server watchdog of 8. Measured in the agent's own
  log: 36 × `model_options_unanswered`, and only 13 of those were "no tab to
  ask". The other 23 reached a tab and the answer came back too late to be
  wanted, which is why `/effort` appeared to change nothing and subagent routing
  always fell back to the default model.

  `waitForDom` waits on a `MutationObserver` instead — measured at full rate in
  a hidden tab — with `performance.now()` for the deadline, because a clock read
  is not a timer. The close-confirmation loop is gone outright: it never retried
  and never reported, so every tick of it was spent on a value nobody read. This
  is the same correction CLAUDE.md records for completion detection, applied one
  level down.
- **A picker that will not open no longer kills the turn.** Both of these are
  asked outside the extension lane, but their failures arrived at the bridge as
  ordinary errors and fell through to `abortExtensionWork()` — so `/effort`
  typed during a turn, or one unreachable tab, abandoned the prompt in flight
  and filed the reason under a different flow.

### 1.27.0 — 2026-09-25

- **The tab a subagent task holds now survives a worker eviction.** `sessionTabs`
  was module state, and MV3 evicts the service worker constantly — so between one
  round and the next the map was often simply gone. That was harmless while every
  round opened its own tab; holding one tab for a whole task made it load-bearing.
  The failure was loud: `session_lost`, a full re-send, and a **new tab per round**
  — reported as *"it opened subagent tab multiple times and just closed, felt like
  a crash."* Persisted to `chrome.storage.session`, which is what `OWNED_KEY`
  already uses for exactly this reason.
- **`ctrl+b` opens the tab again, and the other two say why they cannot.**
  `focusModelTab` and `sendToModelTab` both returned whether they reached a tab and
  both callers discarded it, so ctrl+b, `/effort`'s model switch and
  `discover_models` failed in silence. Focus now adopts any Gemini tab — showing
  you a tab touches nothing. The other two still refuse tabs the extension does not
  own, because one changes the model and the other opens its menu, but they now
  report `no gemini tab this extension owns` instead of nothing.

### 1.26.0 — 2026-09-25

- **The extension says which build it is, and the CLI checks.** `identify` now
  carries `chrome.runtime.getManifest().version`. The server compares it with
  the manifest beside it and shows one row when they differ, logging
  `extension_stale` so `/logs bridge` has it too. No version reported means a
  build older than 1.26.0, which is reported as such rather than guessed at.
  See the note under *Current version* for what this cost before it existed.

### 1.25.0 — 2026-09-20

Two latency bugs, both reported from use and both measured against
`.agent/logs/traces.jsonl` (237 recorded turns).

- **A reply that ends in a code block is finished, not mid-construct.**
  `looksUnfinished` gives the content a veto the page cannot give — an odd
  number of ``` fences, or a trailing unclosed inline backtick, means the
  silence was a pause. The fence half is right. The inline half read the last
  line of the *whole* reply, and `extractTextContent` ends with `.trim()`, so a
  reply ending in a code block ends **on its closing fence** — three backticks,
  an odd count.

  That is every tool call, and therefore every round of the agent loop. Each
  veto reset the quiet streak, six times over. It shows in the traces as
  bimodality rather than a distribution: a fast mode at **3,176ms** (n=70) and a
  slow one at **13,936ms** (n=11), ~10.8s apart — a near-fixed penalty is a
  bug's fingerprint, not model variance.

  Reported as *"a considerable delay between Gemini sending the JSON block and
  us sending back the tool result"*, at 28 seconds on a `list_directory` call.

  The existing test passed against it: its fixture ended ``` ...```\nDone. ``` —
  the block followed by prose, so the last line was never the fence. Real
  replies end on it.

- **`waitForSendButton` no longer sleeps 500ms before looking.** An
  unconditional half second on every round, waiting for a button that is
  usually already enabled — `send` was 698ms median and 1,383ms p90 across 237
  turns, and that line was most of it.

  It was guarding something real: the empty-composer test means "the user
  pressed send themselves", and that reading only holds once our text has been
  *seen* there. `sawText` answers the same question directly and cannot be wrong
  in either direction, which is the trade this bridge already made for tabs when
  fixed sleeps became `waitForBridge`.

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
