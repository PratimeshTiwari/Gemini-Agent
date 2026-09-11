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

### The address theory was wrong — measured and discarded

The first draft of this plan blamed `ws://localhost`: `localhost` resolves `::1`
first on this machine, and P0 moved the server from binding `::` (every
interface) to `127.0.0.1` (IPv4 only), so every attempt now begins with a refused
IPv6 connection.

**That is all true and it does not matter.** Measured in Chrome 152, headless,
against an IPv4-only server, three runs each:

```
ws://localhost -> open 33ms | open 10ms | open 11ms
ws://127.0.0.1 -> open 11ms | open 11ms | open 14ms
ws://[::1]     -> error 2ms | error 10ms | error 10ms
```

Chrome falls back from `::1` in about ten milliseconds. Node does the same in
seven. The refused IPv6 attempt is real and costs nothing.

`127.0.0.1` is still the right address to dial — it says what it means and does
not depend on the hosts file — but it is a tidy-up, **not** the fix. Recorded
because a plan that keeps a disproved cause in it will have someone re-derive it.

### The reconnect is the whole problem — measured

`socket.js`:

```js
const RECONNECT_BASE = 1000;
const RECONNECT_MAX  = 30000;
const delay = Math.min(RECONNECT_BASE * 2 ** (attempts - 1), RECONNECT_MAX);
await chrome.alarms.create('reconnect', { delayInMinutes: delay / 60000 });
```

`chrome.alarms` clamps to a **30-second floor**, and `RECONNECT_MAX` is 30,000ms
— *exactly* that floor. The ladder 1s → 2s → 4s → 8s → 16s → 30s collapses to a
constant: **every retry is 30 seconds**, and the arithmetic above it is
decorative.

**Measured with the real extension loaded into headless Chrome**, timing from the
server's `listening` to the extension's `identify`:

| case | time to connect | handshakes seen by the server |
| --- | --- | --- |
| Chrome already running 20s, then the agent starts | **13.6s** | **1** |
| agent already listening, then Chrome starts | **25.6s** | 1 |

**One handshake.** The extension is not retrying and failing — it is not
*trying*. And the 13.6s reconstructs exactly: the worker's first attempt is at
~3.6s after Chrome starts, it fails (no server yet), it schedules an alarm, the
alarm fires 30s later at ~33.6s; the server began listening at 20s; 33.6 − 20 =
13.6.

Two things have to change together, because in MV3 they are the same problem:

- **Retry on `setTimeout` while the worker is alive** — 250ms, 500ms, 1s, 2s…
  Alarms are for long gaps, not for the first ten seconds.
- **Keep the worker alive while disconnected.** A pending `setTimeout` does *not*
  stop Chrome terminating an idle MV3 worker, and a timer in a dead worker never
  fires. So while there is no socket, the worker needs a periodic call to stay
  resident — and the alarm stays as the backstop for when it is killed anyway.

Nothing can push at the worker from outside: the server cannot wake it, so the
extension has to be the one still looking.

### What was tried, and what is still unproven

Built and measured, in order. **None of it moved the number in headless Chrome.**

| attempt | result |
| --- | --- |
| `setTimeout` ladder (250ms → 8s) instead of alarms | 30.0s gaps |
| `chrome.runtime.getPlatformInfo()` every 5s to stay resident | 30.0s gaps |
| ditto, with a model tab open | 30.0s gaps |
| content script nudging `{type:'connect'}` every 3s | 30.0s gaps |

Four runs, every gap exactly 30.0s. Chrome terminates the idle worker, its
timers die with it, and the alarm floor is the only cadence left.

**But the harness could not test the last two.** A check for the content script
came back `NOT-INJECTED`, for two reasons found afterwards: Chrome **match
patterns cannot contain a port**, so the test's `http://127.0.0.1:7933/*` entry
was invalid — and the detector was wrong anyway, because
`enableAntiThrottling` **creates the `<audio>` element and never appends it to
the document**, so it was never findable. (That is its own finding: a detached
element is what the throttling defence has always been.)

So the honest position: **the root cause is proven, the fix is not.** Headless
Chrome has no user activity and no real profile, and is known to reclaim workers
harder than a browser someone is using. The changes made are each defensible on
their own — `127.0.0.1`, a configurable port, dead constants gone, a ladder that
works whenever the worker *is* alive, a nudge from the one context that persists
— but the improvement has not been demonstrated.

**Measure it in a real browser instead.** `describeSettings` now carries an
`Extension` row on the Status tab — "connected in 420ms" — recorded on the first
`identify` against the moment the socket started listening. Restart the agent
with Chrome open and read it. That turns this from an argument into a number.

**If it is still ~30s there, the answer is an offscreen document.** That is the
documented MV3 pattern for a connection that has to outlive the worker: a real
document owns the WebSocket and Chrome does not reclaim it on an idle timer. It
is a bigger change — the worker becomes a relay — which is why it is recorded
here rather than attempted blind.


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
| 1 | Fast retry while the worker lives + keep it resident while disconnected; alarms demoted to a backstop | **the measured cause: 13.6s → expected sub-second** | **low** |
| 2 | `127.0.0.1` not `localhost`; port overridable; delete the dead `WS_URL` | tidy-ups, not the fix — see above | low |
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
