# The Chrome extension — plan

Written 2026-09-12. A plan, not a change — nothing here is built.

`CLAUDE.md` → *Raised, not yet planned* has carried "**The extension.** Chrome
throttling of background tabs, the retry behaviour around it, and whatever else
the bridge is papering over — to be planned rather than patched" since
2026-09-11. This is that.

It comes before the GitHub restructure on purpose: **the GitHub plan's critical
path already runs through here.** Its phase 0 is a throttling question, phase 4
is tab identity, phase 5 is the lane change, and 6–8 depend on those. Doing the
extension first is not a detour from that plan, it *is* those phases, done as
their own work instead of as sub-steps of someone else's refactor.

The stronger argument: **3,125 lines, zero tests, and every turn in the product
goes through them.** A fault here presents as "the agent randomly stopped
working", which is the worst failure class there is — and is why
`drift-detector.js`, the five-minute timeouts and the whole retry ladder exist.

---

## The one idea

**The bridge apologises for failures it could prevent, and guesses at problems
it could measure.**

Three retry ladders, two competing anti-throttling mechanisms, a 5-minute
watchdog, a `describeScrapeFailure` helper and a reconnect backoff — all
downstream of a connection that dials the wrong address, selectors that cannot
adapt, and a log nobody can read. The fixes are upstream of every one of those
mechanisms, and most are small.

---

## Connectivity

### The address is wrong, and it has been since P0

**Measured, not inferred.** Against the real server binding:

```
ws://localhost:7908   -> OPEN after 7ms        (Node falls back to IPv4)
ws://127.0.0.1:7908   -> OPEN after 2ms
ws://[::1]:7908       -> FAILED (ECONNREFUSED) after 0ms
```

and on this machine:

```
dns.lookup('localhost', {all:true})
  -> [ { address: '::1', family: 6 }, { address: '127.0.0.1', family: 4 } ]
```

`::1` comes **first**. P0 changed the server from `new WS({ port })` — which
binds `::`, every interface including `::1` — to `host: '127.0.0.1'`, IPv4 only.
That fix is correct and stays. But the extension still dials
`ws://localhost:7777`, so **every connection attempt now begins with a refused
IPv6 connection that did not happen before P0.**

Node falls back in 7ms. Chrome is not Node, and whether it falls back inside a
single WebSocket attempt or surfaces a close event is the difference between
"instant" and "thirty seconds" — see the next item for why. The fix is one word,
in a file where the same constant already appears twice.

### The reconnect backoff computes a number that can never matter

`socket.js`:

```js
const RECONNECT_BASE = 1000;
const RECONNECT_MAX  = 30000;
const delay = Math.min(RECONNECT_BASE * 2 ** (attempts - 1), RECONNECT_MAX);
await chrome.alarms.create('reconnect', { delayInMinutes: delay / 60000 });
```

`chrome.alarms` clamps to a **30-second floor**. `RECONNECT_MAX` is 30,000ms —
*exactly* that floor. So the ladder 1s → 2s → 4s → 8s → 16s → 30s collapses to a
constant: **every reconnect waits 30 seconds**, and the exponential arithmetic
above it is decorative.

That is the amplifier. Any failed attempt — including a refused `::1` — costs
thirty seconds instead of one.

The fix is to stop using alarms for short retries. The service worker is kept
alive by the content script's `keepAlive` port, so `setTimeout` works for the
first several attempts; alarms are the right tool only for the long gaps after
the worker has been allowed to die.

### Nothing tells the extension that a server appeared

`connectWebSocket()` runs at module top level, on `onInstalled`, on `onStartup`
and on the reconnect alarm. Starting the CLI fires none of those. So the
best case for "I just started the agent" is the next alarm — thirty seconds.

### The port is hardcoded, in two places, one of which is dead

`--port` is a documented server flag. `socket.js:5` and
`gemini-bridge.js:13` both hardcode `ws://localhost:7777`. Run on any other port
and the bridge silently never connects — and **`gemini-bridge.js`'s copy is dead
code**: content scripts talk over `chrome.runtime`, never a WebSocket. A
misleading constant at the top of the most-read file in the extension.

---

## Code quality

### The two bridges are one file and two selector tables

Every function in `gemini-bridge.js` (701 lines) also exists in
`chatgpt-bridge.js` (547):

```
findElement  getResponseCount  injectPrompt  waitForSendButton
startResponseObserver  stopResponseObserver  extractLatestResponse
extractTextContent  onResponseComplete  connectToServiceWorker
```

Ten for ten. 1,248 lines that are one implementation plus two `SELECTORS`
objects and a couple of site quirks (Gemini's synthetic `ClipboardEvent` paste,
ChatGPT's image `File` rebuild). Every fix has to be made twice, and the P2 note
in `CLAUDE.md` records one that was not: the ChatGPT bridge **deleted** attached
images for months while the Gemini one sent them.

### Dead declarations

In `gemini-bridge.js`, declared and never read:

| name | why it misleads |
| --- | --- |
| `RESPONSE_ACTIVITY_TIMEOUT = 60000` | reads as the streaming timeout; governs nothing |
| `RECONNECT_BASE = 1000` | reads as retry policy; there is no socket here |
| `WS_URL` | reads as the server address; content scripts never dial it |
| `responseIdleTimer` | reads as the idle-detection handle |

Four of the first twenty lines of the file describe a design that is not there.

### Zero tests, 3,125 lines

| area | lines | tests |
| --- | --- | --- |
| `content-scripts/` | 1,544 | none |
| `src/background/` | 504 | none |
| `side-panel/` | 1,077 | none |

DOM scraping genuinely needs a browser. **`src/background/` does not** — socket
state, reconnect policy, message routing and tab selection are ordinary
JavaScript, and they are where the connectivity bugs live.

### `service-worker.js` is a committed build artifact

Verified in sync today (`npm run build --workspace=extension` produced no diff).
It stays a trap: Chrome loads the bundle, not `src/background/`.

---

## Scraping

### The code-block scrape is wrong, and it is visible in the CLI

`extractTextContent`:

```js
clone.querySelectorAll('pre code, code-block').forEach(codeBlock => {
  const lang = codeBlock.getAttribute('data-language')
            || codeBlock.className.match(/language-(\w+)/)?.[1] || '';
  const code = codeBlock.textContent;
  codeBlock.parentElement.replaceWith(document.createTextNode(
    `\n\`\`\`${lang}\n${code}\n\`\`\`\n`));
});
```

Gemini renders a code block as a `<code-block>` wrapping **a header chip (the
language name and a copy button) and then the `<pre><code>`**. The selector
matches `code-block` *and* the inner `pre code`, and `querySelectorAll` returns
document order, so the ancestor is processed first. Then:

- `codeBlock.textContent` on `<code-block>` is **the header chip plus the code**,
  which is why the terminal shows `JavaScript// 1. Using async/await…` — the
  language label welded to the first line of code.
- `lang` comes out **empty**, because the attribute and class are on the inner
  `<code>`, not the wrapper. So the fence carries no language and the CLI's
  highlighter has to guess.
- `codeBlock.parentElement.replaceWith(...)` replaces the **parent** of the
  block, not the block. Whatever else that parent contained goes with it.

### Selectors cannot adapt, and that is fixable

22 selectors in 6 ladders. When a ladder misses, `describeScrapeFailure` writes a
good error and the turn is lost. **The owner's suggestion is the right one:
discover the element structurally when the ladder fails** — the visible
`[contenteditable=true]` with the largest area is the prompt box; the enabled
button nearest it is send; the subtree that mutated during the reply is the
response. Slower than a selector and far better than a dead turn, and a
discovered hit should be *reported back to the server* so `/logs extension`
records that Gemini's DOM moved, with what was found in its place.

---

## Throttling

Two mechanisms for one problem, and nobody chose between them.

**The audio hack probably does not work in the case it exists for.**
`enableAntiThrottling` loops a silent WAV to keep a background tab awake. Chrome's
autoplay policy blocks playback without a user gesture or a high media-engagement
score, and the fallback binds `click` and `keydown` with `{ once: true }` — which
a **backgrounded** tab never receives. So it plays in tabs that did not need it.

**The Tab Wakeup Protocol works and has a cost nobody signed up for.**
`trySendToTab` activates the target tab, waits 250ms, sends — and captures
`originalActiveTabId` only to decide *whether* to switch. **It never switches
back.** Every send yanks the browser to a Gemini tab and leaves it there.

**Tabs leak on failure.** `chrome.tabs.remove` runs only for a `complete`
response (`main.js:32`). A timeout or an error leaks the tab, and
`runHeadlessTask` runs up to ten turns.

---

## Logging

The extension's own logging is `console.log` in two contexts nobody has open: the
service worker's inspector and the page's. P2 added `op`/`stage`/`targetModel` to
*errors*, which is why `/logs extension` can say `find_input` rather than
"failed" — but there is no record of a **successful** turn's timings, so "the
connection is slower than it used to be" is unmeasurable from inside the product.

What is missing is a trace, not more errors: per injection, how long to find the
input, to type, to click send, to first token, to complete — sent to the server
and written where `/logs` can group it. Then a regression is a number.

---

## Phases

| # | phase | why here | risk |
| --- | --- | --- | --- |
| 1 | `127.0.0.1` not `localhost`; port from the server; delete the dead `WS_URL` | one-word fixes to the measured cause | **low** |
| 2 | Real backoff: `setTimeout` while the worker lives, alarms only for long gaps | removes the 30s floor that amplifies every failure | low |
| 3 | Tests for `src/background/` — socket state, reconnect policy, routing, tab choice | the connectivity bugs live here and it needs no browser | low, slow |
| 4 | Fix the code-block scrape; add the language; stop replacing the parent | user-visible, and the CLI half is in `UI-REDESIGN.md` round two | low |
| 5 | Structured trace events → server → `/logs extension` | makes "it got slower" a number instead of a feeling | medium |
| 6 | Pick one throttling mechanism; restore focus after a send; close tabs on failure | ends two competing hacks; fixes the focus theft | medium |
| 7 | Selector discovery fallback, reported when it fires | survives a Gemini redesign instead of losing the turn | medium |
| 8 | Collapse the two bridges to one implementation + two selector tables | ~600 lines, and it is why the image bug lived so long | **high** |
| 9 | Tab identity: lane → tabId map | this is GitHub phase 4, unblocking that plan | medium |

Phase 8 is last because it is the one that can break both bridges at once, and
phases 3 and 5 are what make it safe to attempt.

**Every phase that touches `src/background/` ships a build artifact.**
`npm run build --workspace=extension`, or Chrome runs the old code.

---

## How to verify

There is no pty harness for a browser. What exists:

1. **Connection timing is measurable from the server side.** Log the gap between
   `listening` and the extension's `identify`. Phase 1 should move it from tens
   of seconds to under one, and that is a number to put in the commit.
2. **The two-tab test** from `GITHUB-AGENT-PLAN.md` → phase 0 covers throttling,
   including once with both tabs backgrounded, which is the state that matters.
3. **Reconnect timing**: restart the agent, time the reconnect. If it is ~30s
   before phase 2 and ~1s after, the alarms-clamp diagnosis was right.
4. **`src/background/` unit tests** (phase 3) need no browser at all.
5. **The scrape** (phases 4, 7) can be checked against saved HTML fixtures of a
   Gemini response in jsdom — no live page, and the fixture is the regression
   test for the next redesign.
