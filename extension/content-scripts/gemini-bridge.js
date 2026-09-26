/**
 * Wrapped in an IIFE so this file can be injected twice.
 *
 * Every `const` below used to be at the top level of the content-script world,
 * and that world **survives** the script that created it. So re-injecting into
 * a tab that already had a copy threw
 * `Uncaught SyntaxError: Identifier 'RESPONSE_IDLE_TIMEOUT' has already been
 * declared` on line one, and the fresh copy never evaluated at all.
 *
 * Which quietly disabled the repair that needed it most. `sendWithRepairs`'s
 * `reinject` stage exists for exactly one case — a content script orphaned by
 * an extension reload, "the commonest cause by far" — and that is precisely
 * the case where a copy is already there to collide with. The stage did
 * nothing, `waitForBridge` then burned its 3s budget waiting for a script that
 * had failed to load, and the only sign was an entry on
 * `chrome://extensions`. Seen twice.
 *
 * Function scope fixes the collision. The handover beside `invalidate()` fixes
 * the other half: skipping is not enough, because the goal is to *replace* an
 * orphan, and an orphan still owns live MutationObservers and timers in this
 * page. It already knows how to stop — `onInvalidated` — it was just never
 * told, because nothing tells it until its next `safeSend` notices.
 */
(() => {

/**
 * Gemini Bridge — Content Script
 *
 * Injected into gemini.google.com pages. Handles:
 * - Injecting prompts into Gemini's input field
 * - Extracting Gemini's responses from the DOM
 * - Detecting when Gemini finishes responding
 * - Creating new chat sessions
 */

// ── Constants & State ───────────────────────────────────────────────

const RESPONSE_IDLE_TIMEOUT = 15000; // 15s of no new text = response complete
const RESPONSE_MAX_TIMEOUT = 300000; // 5 min absolute max (safety net)
// Every completion path below needs `lastResponseText` to be non-empty, so a
// scrape that matches nothing used to sit here for the full 5 minutes with no
// signal at all. Give up much sooner when there is still nothing to report.
const NO_RESPONSE_TIMEOUT = 45000;

// ── Keeping a background tab awake ───────────────────────────────────
//
// There were two mechanisms for this and nobody had chosen between them.
//
// The one that lived here looped a silent WAV to stop Chrome throttling a
// background tab. It never worked in the case it existed for: Chrome's autoplay
// policy blocks playback without a user gesture or a high media-engagement
// score, and the fallback bound `click` and `keydown` with `{ once: true }` —
// events a **backgrounded** tab never receives. So it played in tabs that did
// not need it and stayed silent in the ones that did, while its own catch block
// logged the reason to a console nobody had open.
//
// (Both `EXTENSION-PLAN.md` and `HANDOFF.md` recorded the cause as the `<audio>`
// element never being appended to the document. That is true and it is not the
// bug — a detached `<audio>` plays fine in Chrome; that is what `new Audio()`
// is. The autoplay policy is the reason.)
//
// The Tab Wakeup Protocol in `src/background/content.js` is the one that works:
// it activates the tab before sending, which is a real user-visible cost paid
// deliberately, and hands focus back when the turn ends.

// ── DOM Selectors ────────────────────────────────────────────────────
// Centralized selectors — update these when Google changes the UI
/**
 * How long to let a paste settle before deciding it never landed.
 *
 * Quill inserts on a later tick, so the check has to poll rather than read
 * once. 600ms total: long enough that a normal paste is never second-guessed,
 * short enough that the failure path does not eat the send budget.
 */
const PASTE_SETTLE_MS = 50;
const PASTE_SETTLE_TRIES = 12;

const SELECTORS = {
  // The control that opens the picker. Ordered by what actually matched on
  // gemini.google.com, not by what sounded likely: the first two guesses here
  // were `aria-label*="switch model"` and `aria-label*="model"`, and both find
  // nothing. Gemini calls it a **mode** picker, and labels it
  // "Open mode picker, currently Flash" — the model name is in the label, so
  // matching the whole label would break on every switch.
  modelTrigger: [
    '[data-test-id="bard-mode-menu-button"]',
    'bard-mode-switcher button',
    'button[aria-label*="mode picker" i]',
  ],

  // The options, once the picker is open. They are `<gem-menu-item>` elements
  // with role=menuitem — not menuitemradio, and not inside a mat-menu, both of
  // which were guessed here first and match nothing.
  modelMenuItem: [
    '[role="menu"] [role="menuitem"]',
    'gem-menu-item',
  ],

  // The main prompt input textarea
  inputField: [
    'div.ql-editor[contenteditable="true"]',
    'rich-textarea div[contenteditable="true"]',
    '.text-input-field textarea',
    'textarea[aria-label*="prompt"]',
    'div[role="textbox"]',
  ],

  // The send/submit button
  sendButton: [
    'button[aria-label*="send" i]',
    'button[aria-label*="submit" i]',
    'button.send-button',
    'mat-icon[data-mat-icon-name="send" i]',
    'button[data-test-id="send-button"]',
  ],

  // Container for response messages
  responseContainer: [
    'message-content',
    '.model-response-text',
    '.response-content',
    'model-response',
    '.conversation-container',
  ],

  // Individual response message
  responseMessage: [
    'model-response .model-response-text',
    'model-response message-content',
    '.response-container .model-response-text',
    'message-content',
  ],

  // New chat button
  newChatButton: [
    'button[aria-label*="New chat"]',
    'a[href="/app"]',
    '.new-chat-button',
  ],

  // Loading/streaming indicator
  streamingIndicator: [
    '.loading-indicator',
    '.streaming-indicator',
    'mat-progress-bar',
    '.response-loading',
  ],
};

// ── State ────────────────────────────────────────────────────────────
let isInjecting = false;

/**
 * A picker read that arrived while a prompt was going in.
 *
 * Set by the `discover_models` handler when it declines, drained when the
 * inject finishes. It is a boolean rather than a queue because the answer is
 * the picker's current state — two deferred reads want the same one reply.
 */
let pendingDiscover = false;

/**
 * The opening of the prompt we last typed, so "did it actually go?" can be
 * **observed** rather than inferred.
 *
 * Proposed by the owner: *"are we checking whether the prompt we typed was
 * sent? We can simply check whether Gemini's input box still has our pasted
 * text — if the text is there it was not sent, so retry."* That is strictly
 * better evidence than what the timeout path had. `neverSubmitted` was
 * `!isGenerating && !sawGenerating`, which is an **inference**: it is equally
 * true when generation started and a changed selector stopped us seeing it,
 * and a resend there asks a thread that already holds the answer.
 *
 * Gemini clears the composer when it accepts a prompt. So text still sitting
 * there is proof the submit did not happen, and an empty composer is proof the
 * text went somewhere — which is the half that prevents a double-send, not
 * just the half that enables a retry.
 *
 * A prefix, because the editor normalises what it holds: it splits pasted text
 * into paragraphs, so the whole string rarely compares equal while the opening
 * survives intact.
 */
let lastTypedPrefix = '';
const TYPED_PREFIX_CHARS = 120;

/** Is the composer still holding the prompt we typed? null when unknowable. */
function composerStillHoldsPrompt() {
  if (!lastTypedPrefix) return null;
  const input = findInputResilient();
  if (!input) return null;
  const text = (input.innerText || input.textContent || '').replace(/\s+/g, ' ').trim();
  if (!text) return false;
  return text.includes(lastTypedPrefix);
}
let responseObserver = null;
let lastResponseText = '';
let responseIdleTimer = null;
let initialResponseCount = 0;
let responseStartTime = 0;

/**
 * How long this turn spent in each stage of the browser.
 *
 * The extension has never recorded a *successful* turn's timings — only its
 * failures — so "the connection is slower than it used to be" could not be
 * answered from inside the product. Marks are taken as the turn passes them and
 * sent once, on completion; nothing here waits on anything.
 */
let turnTrace = null;
const traceStart = () => { turnTrace = { t0: Date.now(), last: Date.now(), stages: {} }; };
const traceMark = (stage) => {
  if (!turnTrace) return;
  const now = Date.now();
  turnTrace.stages[stage] = now - turnTrace.last;
  turnTrace.last = now;
};
let lastActivityTime = 0;
/**
 * How long the reply must stop growing before it counts as settled, and how
 * many consecutive checks must agree. See `quietStreak` for what went wrong
 * with one check and one second.
 */
const RESPONSE_SETTLE_MS = 1500;
const RESPONSE_SETTLE_CHECKS = 2;
/**
 * How many times a reply that ends mid-construct may hold the turn open.
 *
 * Bounded so a reply that genuinely ends on an unclosed backtick is still
 * delivered rather than waiting out the five-minute cap. At the confirming
 * cadence this is a few seconds, which is the length of a code-block render and
 * far short of the model actually stopping.
 */
const UNFINISHED_GRACE_CHECKS = 6;

let activityCheckTimer = null;
/** The in-flight turn's completion check, or null between turns. */
let completionCheck = null;
/** Whether the in-flight turn is one observation short of settled. */
let quietPending = () => false;
let currentRequestData = null;
let sawGenerating = false;

/**
 * Talking to the extension, when the extension may no longer be there.
 *
 * Reloading the extension orphans every content script already running in a
 * page: the page keeps executing this code, but its link to the extension is
 * severed and **`chrome.runtime.sendMessage` throws synchronously** —
 * `Uncaught Error: Extension context invalidated.` A `.catch()` does not catch
 * it, because nothing was ever returned to reject.
 *
 * That is how a reload silently broke a live turn: Gemini answered, the scrape
 * worked, `onResponseComplete` called `sendMessage`, it threw, and the agent
 * sat on "Thinking…" until the five-minute watchdog. Nothing said why.
 *
 * So every call goes through here. When the context is gone we stop the timers
 * and observers this page owns rather than throwing once per tick forever — and
 * the service worker re-injects a fresh copy on startup, which is what actually
 * repairs the tab.
 */
let bridgeInvalidated = false;
const onInvalidated = [];

/** The id disappears the moment this context is orphaned. */
function bridgeAlive() {
  try {
    return !bridgeInvalidated && Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

function invalidate() {
  if (bridgeInvalidated) return;
  bridgeInvalidated = true;
  // `console.info`, not `console.warn`, and the level is the whole point.
  //
  // Chrome's extension **Errors** panel collects `warn` and `error` from content
  // scripts, so warning here put a routine, expected, self-repairing event in a
  // list labelled Errors — one entry per open model tab, persisting until
  // someone clears it. It was reported twice as "is this a problem?", which is
  // the answer: the message was fine and the level was making it look like a
  // fault.
  //
  // Expected, because reloading the extension orphans every content script by
  // definition. Self-repairing, because `reinjectModelTabs()` runs on every
  // service-worker start and injects a fresh copy. Once, because
  // `bridgeInvalidated` guards it and the nudge timer is cleared below.
  //
  // Still logged, because "why did the agent go quiet?" is a real question and
  // this is its answer — it just belongs in the console for whoever is looking,
  // not in an alarm list for everyone who ever pressed Reload.
  console.info('[Agent CLI] Extension was reloaded; this content script is orphaned. '
    + 'A fresh one is injected on the extension\'s next start, or reload this tab.');
  for (const stop of onInvalidated) {
    try { stop(); } catch {}
  }
}

/*
 * Take over from a copy already in this page.
 *
 * The isolated world persists across injections, so a previous bridge may
 * still be observing the DOM and running timers. Its `chrome.runtime.id` is
 * already gone — `bridgeAlive()` knows — but nothing had told it to stop, so
 * it kept ticking until something happened to call `safeSend`.
 *
 * Calling the previous `invalidate` here runs its `onInvalidated` hooks
 * immediately: observers disconnected, timers cleared. Then we register ours
 * for whoever replaces us. Order matters — stop the old one before overwriting
 * the handle, or it can never be reached again.
 */
try { window.__agentBridgeStop?.(); } catch { /* an orphan that cannot stop is still stopped */ }
window.__agentBridgeStop = invalidate;

/** Send, or quietly give up. Never throws, never rejects. */
function safeSend(message) {
  if (!bridgeAlive()) { invalidate(); return Promise.resolve(undefined); }
  try {
    const p = chrome.runtime.sendMessage(message);
    return p && typeof p.catch === 'function' ? p.catch(() => undefined) : Promise.resolve(undefined);
  } catch (err) {
    if (/context invalidated/i.test(err?.message || '')) invalidate();
    return Promise.resolve(undefined);
  }
}

// ── DOM Helpers ─────────────────────────────────────────────────────

/**
 * Try multiple selectors and return the first match.
 */
function findElement(selectorList) {
  for (const selector of selectorList) {
    let el = document.querySelector(selector);
    if (el) return el;
  }
  return null;
}

/**
 * Finding the page's furniture when the selectors stop matching.
 *
 * 22 selectors in 6 ladders, against a page Google redesigns without warning.
 * When a ladder misses, `describeScrapeFailure` writes a good error and the turn
 * is lost — and every turn stays lost until someone notices and ships a new
 * selector. The element is usually still there and still findable by *what it
 * is*, which is slower than a selector and far better than a dead turn.
 *
 * The rule learned building the mode picker's fallback: **a fallback that cannot
 * fire is worse than none**, because the ladder looks like it has a safety net.
 * Each of these was checked against gemini.google.com with the real ladder
 * disabled, and each is reported when it fires — a recovery is still news, and
 * `/logs extension` is where you would find out that the DOM moved.
 */

/** Visible, and big enough to be the thing rather than a decoration. */
function isVisible(el) {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return false;
  const style = window.getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
}

const area = (el) => {
  const r = el.getBoundingClientRect();
  return r.width * r.height;
};

/**
 * The prompt box: the largest visible editable region on the page.
 *
 * Gemini's is a Quill editor, so it is a `contenteditable` div rather than a
 * textarea, and any rename of its classes leaves that unchanged. Size is what
 * separates it from the small editable bits a chat page collects — a rename
 * box, an inline edit on a previous turn.
 */
function findInputStructurally() {
  const candidates = [...document.querySelectorAll('[contenteditable="true"], textarea')]
    .filter(isVisible);
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => area(b) - area(a))[0];
}

/**
 * Send: the control that appears when there is something to send.
 *
 * Neither position nor `type` identifies it. Measured on gemini.google.com with
 * the composer focused and text in it, the nearest enabled buttons to the prompt
 * box are the **mode picker** (37px) and **Dictate** (122px) before send ever
 * shows at 163px — and `type` reads `submit` on Dictate, Upload & tools,
 * Temporary chat, Settings and Close sidebar alike. A first attempt at this
 * selected the microphone, because the exclusion list said `mic|voice|record`
 * and the label is "Dictate".
 *
 * What does identify it is behaviour rather than appearance: **send is the
 * button that was not available before the prompt had text and is after.**
 * Measured, with the box emptied and then one character inserted: ten enabled
 * buttons became eleven, and the one that appeared was "Send message". Nothing
 * else on the page reacts to the composer having content.
 *
 * That survives a rename, a reskin and a move, which is the whole point — and
 * it degrades to *nothing* rather than to the wrong button, because if no
 * button appeared there is no candidate to pick.
 */
function enabledButtons() {
  return new Set([...document.querySelectorAll('button')].filter((b) => {
    if (b.disabled || b.getAttribute('aria-disabled') === 'true') return false;
    const rect = b.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = window.getComputedStyle(b);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }));
}

/**
 * @param {Set<Element>} before  enabled buttons as they were before typing
 * @param {Element} input        the prompt box, for the tie-break
 */
function findSendButtonStructurally(before, input) {
  if (!before) return null;
  const appeared = [...enabledButtons()].filter((b) => !before.has(b));
  if (appeared.length === 0) return null;
  if (appeared.length === 1) return appeared[0];

  // More than one reacted to the text. Proximity is a poor signal on its own but
  // an acceptable tie-break between buttons that all passed the real test.
  if (!input) return null;
  const from = input.getBoundingClientRect();
  return appeared
    .map((b) => {
      const r = b.getBoundingClientRect();
      return { b, d: Math.hypot(r.left - from.right, r.top - from.bottom) };
    })
    .sort((a, b) => a.d - b.d)[0].b;
}

/**
 * Tell the server the ladder missed but the page was still usable.
 *
 * Not silent: a selector that has drifted is a bug with a deadline, and the only
 * warning is that a fallback had to do the work. The bridge lifts `[stage]` out
 * of the message into `op`, so this reads as `selector_drift` in
 * `/logs extension` rather than as noise.
 */
function reportDrift(what, found) {
  const describe = (el) => {
    if (!el) return 'nothing';
    const label = el.getAttribute('aria-label');
    return `<${el.tagName.toLowerCase()}${label ? ` aria-label="${label}"` : ''}${el.className && typeof el.className === 'string' ? ` class="${el.className.split(' ').slice(0, 2).join(' ')}"` : ''}>`;
  };
  safeSend({
    type: 'error',
    payload: {
      op: 'selector_drift',
      message: `[selector_drift] SELECTORS.${what} matched nothing; found ${describe(found)} by shape instead. `
        + 'The turn continued — update the selector before it stops working.',
    },
  });
}

/** The ladder, then the shape, then give up — and say which happened. */
function findInputResilient() {
  const byLadder = findElement(SELECTORS.inputField);
  if (byLadder) return byLadder;
  const byShape = findInputStructurally();
  if (byShape) reportDrift('inputField', byShape);
  return byShape;
}


/**
 * Get the current number of response blocks in the DOM.
 */
function getResponseCount() {
  for (const selector of SELECTORS.responseMessage) {
    const els = document.querySelectorAll(selector);
    if (els.length > 0) return els.length;
  }
  return 0;
}

// ── Prompt Injection ────────────────────────────────────────────────

/**
 * Inject a prompt into Gemini's input field and send it.
 */
async function injectPrompt(text) {
  if (isInjecting) {
    console.warn('[Gemini Bridge] Already injecting a prompt');
    return false;
  }

  isInjecting = true;
  traceStart();
  lastTypedPrefix = String(text || '').replace(/\s+/g, ' ').trim().slice(0, TYPED_PREFIX_CHARS);

  // What was clickable before the prompt had anything in it. Send is whatever is
  // clickable afterwards and was not — see findSendButtonStructurally.
  const buttonsBeforeText = enabledButtons();

  try {
    // The ladder first, then the shape — a redesigned class name should
    // cost a log line, not the turn.
    const input = findInputResilient();
    if (!input) {
      throw new Error('[find_input] Could not find the Gemini input field — the editor selector has probably changed');
    }
    traceMark('find_input');

    // Record how many responses exist BEFORE we send
    initialResponseCount = getResponseCount();

    input.focus();

    // Safely clear content
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);

    // Paste event
    const dataTransfer = new DataTransfer();

    // Intercept image data if present
    const imgRegex = /<image_data>\n(data:image\/[^;]+;base64,[^\n]+)\n<\/image_data>/;
    const imgMatch = text.match(imgRegex);
    let hasImage = false;
    
    if (imgMatch) {
      const dataUrl = imgMatch[1];
      text = text.replace(imgRegex, '').trim(); // Remove raw base64 from the text
      
      try {
        const res = await fetch(dataUrl);
        const blob = await res.blob();
        const ext = blob.type.split('/')[1] || 'png';
        const file = new File([blob], `image.${ext}`, { type: blob.type });
        dataTransfer.items.add(file);
        hasImage = true;
        console.log(`[Gemini Bridge] Attached image file: image.${ext} (${Math.round(blob.size/1024)}KB)`);
      } catch (err) {
        console.error('[Gemini Bridge] Failed to convert image data URL to Blob', err);
      }
    }

    if (text) {
      dataTransfer.setData('text/plain', text);
    }

    // Dispatch a single paste event for both image and text
    const pasteEvent = new ClipboardEvent('paste', {
      clipboardData: dataTransfer,
      bubbles: true,
      cancelable: true
    });
    
    // Focus before pasting
    input.focus();
    input.dispatchEvent(pasteEvent);

    // If we pasted an image, wait for it to process
    if (hasImage) {
      await new Promise(r => setTimeout(r, 500));
    }

    /*
     * `preventDefault()` is not evidence that the text arrived.
     *
     * This was `const pasteHandled = !input.dispatchEvent(pasteEvent)` — true
     * whenever *somebody* called `preventDefault`. Gemini's editor always does:
     * it takes the paste and inserts the text itself, on a later tick. So the
     * flag meant "a handler ran", and the `insertText` fallback was skipped on
     * exactly the runs where that handler ran and then lost the text — a
     * composer re-mounted mid-paste, a paste landing during navigation. The
     * editor stayed empty and nothing tried again.
     *
     * Reported from use: *"the prompt is pasted on the searchbar but the send
     * is not clicked, I manually click"*.
     *
     * Measured against the live page, 2026-09-24: Gemini renders
     * `button[aria-label="Send message"]` **only once the composer has
     * content** — 0 matches on an empty composer, 1 with text. So
     * `send button found: false` in `resend_unsubmitted` was never a stale
     * selector. It was this: an empty composer, correctly reporting that there
     * is no send button, after a paste that was "handled" and dropped. The
     * turn then spent `waitForSendButton`'s full 30s budget waiting for a
     * control that cannot exist until the text does.
     *
     * The composer's own contents answer it directly, and are the same thing
     * the button is keyed on. Polled rather than read once, because Quill
     * inserts asynchronously and reading immediately would see empty and paste
     * a second copy — which is the opposite failure and a worse one, since a
     * doubled system prompt is what trips Gemini's repetition filters.
     *
     * `!text` counts as landed so the image-only path is untouched: there the
     * composer legitimately holds nothing and the button is enabled by the
     * attachment.
     */
    const composerText = () => String(input.value ?? input.innerText ?? input.textContent ?? '').trim();
    let landed = !text;
    for (let i = 0; i < PASTE_SETTLE_TRIES && !landed; i += 1) {
      if (composerText()) landed = true;
      else await new Promise(r => setTimeout(r, PASTE_SETTLE_MS));
    }

    if (!landed && text) {
      console.warn('[Gemini Bridge] [type] paste left the composer empty; inserting directly');
      input.focus(); // Re-focus to prevent selection loss
      document.execCommand('insertText', false, text);
    }

    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));

    // Wait for the send button to become enabled (Gemini validates input and uploads images)
    // Extra wait for image upload to complete if we pasted an image
    if (hasImage) {
      console.log('[Gemini Bridge] Waiting extra time for image upload to complete...');
      await new Promise(r => setTimeout(r, 1500));
    }

    // Wait for the send button to become enabled (Gemini validates input and uploads images)
    traceMark('type');

    const sendBtn = await waitForSendButton(input, 30000, buttonsBeforeText);

    if (sendBtn === 'submitted') {
      console.log('[Gemini Bridge] Proceeding since prompt was manually submitted.');
    } else if (sendBtn) {
      sendBtn.click();
      traceMark('send');
      console.log('[Gemini Bridge] Send button clicked');
    } else {
      // Fallback 1: Try submitting the closest form
      const form = input.closest('form');
      if (form) {
        try { form.requestSubmit(); console.log('[Gemini Bridge] Form submitted via fallback'); }
        catch { /* requestSubmit not supported */ }
      }

      // Fallback 2: Dispatch Enter key
      console.warn('[Gemini Bridge] Send button not found or still disabled, pressing Enter as last resort');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      
      // Wait a moment to see if the fallbacks worked by checking if input cleared
      await new Promise(r => setTimeout(r, 1000));
      if (input.textContent.trim().length > 0) {
        throw new Error("[send_button] Send button never became active — an image upload may be stuck, or the button selector has changed");
      }
    }

    // Start watching for the response
    startResponseObserver();

    return true;
  } catch (err) {
    console.error('[Gemini Bridge] Injection failed:', err);
    return false;
  } finally {
    isInjecting = false;
    // The composer is free again, so a read that was turned away can run.
    if (pendingDiscover) {
      pendingDiscover = false;
      readModelOptions()
        .then((models) => safeSend({ type: 'model_options', payload: { models } }))
        .catch((err) => safeSend({
          type: 'error',
          payload: { op: 'discover_models', message: err.message },
        }));
    }
  }
}

/**
 * Wait for the send button to appear and become enabled.
 * Polls every 200ms up to maxWait ms.
 */
function waitForSendButton(input, maxWait = 30000, buttonsBeforeText = null) {
  return new Promise((resolve) => {
    const startTime = Date.now();

    /*
     * Has the composer ever actually held our text?
     *
     * The empty-composer test below means "the user pressed send themselves",
     * and that reading is only valid once the text has been seen there. Before
     * it, an empty composer means the paste has not been processed yet — which
     * is the race the old unconditional 500ms delay was there to avoid, at the
     * cost of 500ms on **every round of every turn**.
     *
     * Tracking it is the readiness check that sleep was standing in for, and it
     * is strictly safer: the sleep was a guess that 500ms is enough, and this
     * cannot be wrong in either direction.
     */
    let sawText = false;

    function check() {
      const empty = !input || input.textContent.trim().length === 0;
      if (!empty) sawText = true;
      // If the user manually clicked send, the input clears! We can stop waiting.
      if (sawText && empty) {
        console.log('[Gemini Bridge] Detected manual submission (input cleared).');
        resolve('submitted');
        return;
      }

      const btn = findElement(SELECTORS.sendButton);

      // The ladder found nothing. Ask which control the text brought with it.
      if (!btn && buttonsBeforeText) {
        const byShape = findSendButtonStructurally(buttonsBeforeText, input);
        if (byShape) {
          reportDrift('sendButton', byShape);
          resolve(byShape);
          return;
        }
      }

      if (btn) {
        // Check if button is visually enabled (not disabled, not aria-disabled)
        const isDisabled = btn.disabled || btn.getAttribute('aria-disabled') === 'true';
        if (!isDisabled) {
          resolve(btn);
          return;
        }
      }

      if (Date.now() - startTime >= maxWait) {
        console.warn(`[Gemini Bridge] Timed out waiting for send button after ${maxWait}ms`);
        // Time's up — return null because the button is still disabled
        resolve(null);
        return;
      }

      setTimeout(check, 60);
    }

    /*
     * Start immediately, and poll fast.
     *
     * This was `setTimeout(check, 500)` with a 200ms poll — a fixed 500ms on
     * every round of every turn, spent waiting for a button that is usually
     * already there. Measured over 237 recorded turns, the `send` stage was
     * 698ms median and 1,383ms p90, and roughly 500ms of that was this line.
     *
     * The delay was guarding the empty-composer race, which `sawText` now
     * answers directly; nothing else needed it. The button either exists and is
     * enabled or it does not, and asking costs a DOM query.
     */
    check();
  });
}

// ── Response Extraction ─────────────────────────────────────────────

/**
 * Start observing for Gemini's response.
 */
function startResponseObserver() {
  stopResponseObserver();
  lastResponseText = '';
  responseStartTime = Date.now();
  lastActivityTime = Date.now();
  sawGenerating = false;

  let lastStreamedText = '';
  let streamingUpdateTimer = null;
  /**
   * Consecutive checks that saw no Stop button.
   *
   * One sample was enough to end the turn, and that was only safe while the
   * check was being throttled to roughly once a minute in a hidden tab — a
   * transient gap was almost never *sampled*. Now the service worker drives
   * this on a reliable 2s cadence, so those gaps get caught, and a reply was
   * truncated mid-token ("output a single `") while Gemini was still writing.
   *
   * Gemini pauses longer than a second between sections, and the Stop button
   * is absent for a moment while the composer re-renders. Either alone looks
   * exactly like "finished". Requiring the condition to hold across two
   * consecutive checks costs a couple of seconds at the end of a turn and
   * makes both transients unrepresentable.
   */
  let quietStreak = 0;
  let unfinishedHolds = 0;
  // Read by the `tick_completion` reply so the worker can come back quickly
  // for the confirming observation instead of waiting out a whole interval.
  quietPending = () => quietStreak > 0 && quietStreak < RESPONSE_SETTLE_CHECKS;

  responseObserver = new MutationObserver((mutations) => {
    // Only process if a NEW response element has appeared
    const currentCount = getResponseCount();
    if (currentCount <= initialResponseCount) {
      return; // Still waiting for Gemini to start replying
    }

    const currentResponse = extractLatestResponse();

    if (currentResponse && currentResponse !== lastResponseText) {
      /**
       * The first text Gemini actually produced.
       *
       * This was marked in `startResponseObserver`, one line after the send —
       * so it measured the gap between two adjacent statements and read 0ms
       * or 1ms on all 74 recorded turns. The number it was named for, and the
       * only one that separates *Gemini thinking* from *our overhead*, was
       * never captured: everything went into `complete`.
       */
      if (!lastResponseText) traceMark('first_token');
      lastResponseText = currentResponse;
      lastActivityTime = Date.now(); // Reset activity timer

      // We rely on the activityCheckTimer to determine completion based on the Stop button
      // No need for a blind 15-second idle timer here.

      // Send streaming update every 2 seconds so CLI can show partial text
      if (!streamingUpdateTimer) {
        streamingUpdateTimer = setInterval(() => {
          if (lastResponseText && lastResponseText !== lastStreamedText) {
            lastStreamedText = lastResponseText;
            safeSend({
              type: 'gemini_response_stream',
              payload: {
                content: lastResponseText,
                complete: false,
                streaming: true,
              },
            }).catch(() => {}); // Side panel may not be open
          }
        }, 2000);
      }
    }
  });

  responseObserver.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  // Activity checker: runs every 2s to dynamically detect completion
  // We add an initial delay of 3 seconds before checking for the stop button,
  // because the stop button takes a moment to appear after clicking send.
/**
 * The completion check, callable by whoever still has a working clock.
 *
 * Measured in a genuinely hidden tab (example.com, 30s window, Chrome 152):
 * a page `setInterval(100ms)` delivered **0.98/s**, and by 90s hidden it was
 * down to **0.03/s** — roughly one tick per half-minute. Over the same window
 * a `MutationObserver` delivered **9.97/s** and `getBoundingClientRect()`
 * returned a real box 296 times out of 296.
 *
 * So the evidence is fine and the predicate is fine. The *clock* is the only
 * thing Chrome throttles, and it is the whole reason this bridge activates
 * the model tab and holds your focus for the length of a turn.
 *
 * The service worker is not a tab and is not throttled, so it drives this at
 * full rate over `tick_completion`. The local interval stays as a backstop
 * for the case the worker has been evicted mid-turn — throttled to uselessness
 * while hidden, correct when the tab is in front, and free either way.
 */
  const runCompletionCheck = () => {
    const now = Date.now();
    const totalElapsed = now - responseStartTime;
    const silenceDuration = now - lastActivityTime;

    // Do not check for completion in the first 3 seconds to allow the DOM to update
    if (totalElapsed < 3000) return;

    // Gemini's A/B modal blocks the turn until something is chosen.
    if (dismissChoiceDialog()) {
      lastActivityTime = Date.now(); // reset timeout to allow extraction
    }

    // Check if the "Stop Generating" button exists in the DOM and is visible
    const stopBtn = findElement([
      'button[aria-label*="stop" i]',
      'button.stop-generating-button',
    ]);
    let isGenerating = false;
    if (stopBtn) {
      const rect = stopBtn.getBoundingClientRect();
      const style = window.getComputedStyle(stopBtn);
      isGenerating = rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }
    /*
     * The two moments the Stop button marks, recorded rather than only reasoned
     * about.
     *
     * `sawGenerating` has always gated the resend decision — generation
     * started means the model *has* an answer, so a resend asks twice — but it
     * was never written down. So `response_timeout` could not say which of
     * three things happened: our send failed, Gemini never started, or it
     * started and we lost the scrape. Each wants a different repair and the
     * log could not tell them apart.
     *
     * Both are marked once. `generating_start` is the first sighting of the
     * Stop button, which is the honest "first token" — the existing
     * `first_token` mark fires on the first *scraped text*, one observer tick
     * later. `generating_end` is the first sighting of it gone after it was
     * there, so a timeout that recorded a start and no end is a scrape that
     * lost a reply still being written.
     */
    if (isGenerating && !sawGenerating) traceMark('generating_start');
    if (!isGenerating && sawGenerating && !turnTrace?.stages?.generating_end) {
      traceMark('generating_end');
    }
    if (isGenerating) sawGenerating = true;

    // Finished means: no Stop button, the text has stopped growing, and both
    // were still true on the next check. `silenceDuration` is time since the
    // observer last saw the response change, so it is already "the text
    // stopped growing" — it was just far too short on its own.
    quietStreak = nextQuietStreak(quietStreak, {
      isGenerating,
      hasText: Boolean(lastResponseText),
      silenceMs: silenceDuration,
    });

    /*
     * A reply that stops mid-construct is a pause, not an ending — but only
     * for so long. `UNFINISHED_GRACE_CHECKS` bounds it, because a reply that
     * genuinely ends on an unclosed backtick must still be delivered rather
     * than waiting out the five-minute cap. Past the grace it is accepted as
     * it stands, which is what happened before this existed.
     */
    if (quietStreak >= RESPONSE_SETTLE_CHECKS && looksUnfinished(lastResponseText)) {
      unfinishedHolds += 1;
      if (unfinishedHolds <= UNFINISHED_GRACE_CHECKS) {
        console.log(`[Gemini Bridge] Quiet, but the reply ends mid-construct — waiting (${unfinishedHolds}/${UNFINISHED_GRACE_CHECKS})`);
        quietStreak = 0;
      }
    }

    if (quietStreak >= RESPONSE_SETTLE_CHECKS) {
      console.log(`[Gemini Bridge] Generation finished (quiet for ${quietStreak} checks)`);
      clearInterval(streamingUpdateTimer);
      onResponseComplete(lastResponseText);
      return;
    }

    // Nothing scraped at all. Waiting out the 5-minute cap tells the user
    // nothing they can act on, so report what actually broke instead.
    if (!lastResponseText && totalElapsed >= NO_RESPONSE_TIMEOUT) {
      const diagnosis = describeScrapeFailure(isGenerating);
      console.warn(`[Gemini Bridge] ${diagnosis}`);
      clearInterval(streamingUpdateTimer);
      stopResponseObserver();
      // Whatever was measured before it stalled — this is the case the
      // generating marks exist to explain.
      sendTurnTrace('timeout');
      safeSend({
        type: 'gemini_response',
        payload: {
          content: diagnosis,
          complete: false,
          timedOut: true,
          /**
           * Did the model ever see this turn?
           *
           * `sawGenerating` was the honest answer while it was the only one
           * available, and it decides whether the agent may retry. Generation
           * started and we failed to read it -> the model HAS an answer, and
           * resending would ask it twice into a thread that already holds the
           * first reply. Generation never started and nothing was scraped ->
           * the submit did not happen, so sending again is the first attempt
           * landing, not a repeat.
           *
           * **But it is an inference, and the composer is a fact.** Gemini
           * clears the composer when it accepts a prompt, so our text still
           * sitting in it proves the submit did not happen, and an empty
           * composer proves the text went somewhere. The second half is the
           * one that matters most: it stops a resend in the case
           * `sawGenerating` gets wrong — generation started and a changed
           * selector hid it — which is the case that asks twice.
           *
           * So the observation wins where there is one, and the inference is
           * the fallback for a composer we cannot find or a turn where nothing
           * was recorded as typed.
           */
          neverSubmitted: composerStillHoldsPrompt() ?? (!isGenerating && !sawGenerating),
          composerStillHolds: composerStillHoldsPrompt(),
        },
      });
      return;
    }

    // Absolute max timeout (5 minutes)
    if (totalElapsed >= RESPONSE_MAX_TIMEOUT) {
      console.warn('[Gemini Bridge] Absolute max timeout reached (5 min)');
      clearInterval(streamingUpdateTimer);
      stopResponseObserver();
      // Whatever was measured before it stalled — this is the case the
      // generating marks exist to explain.
      sendTurnTrace('timeout');
      safeSend({
        type: 'gemini_response',
        payload: {
          content: lastResponseText || '[No response received — max timeout reached]',
          complete: false,
          timedOut: true,
        },
      });
      return;
    }

    // Fallback: If for some reason the Stop button check fails but it has been silent for 15s
    if (lastResponseText && silenceDuration >= RESPONSE_IDLE_TIMEOUT) {
      console.warn('[Gemini Bridge] Fallback idle timeout reached (15s silence)');
      clearInterval(streamingUpdateTimer);
      onResponseComplete(lastResponseText);
    }
  };

  completionCheck = runCompletionCheck;
  activityCheckTimer = setInterval(runCompletionCheck, 2000);
}

/**
 * How many consecutive checks have now seen a finished reply.
 *
 * Pulled out as a function because it is the whole of the fix and the
 * regression is invisible in review: setting `RESPONSE_SETTLE_CHECKS` back to
 * 1 reads like a harmless tightening and silently restores truncated replies.
 *
 * @param {number} streak  the count so far
 * @param {{isGenerating: boolean, hasText: boolean, silenceMs: number}} now
 * @returns {number} the new count; 0 means "still going"
 */
function nextQuietStreak(streak, now) {
  const settled = !now.isGenerating && now.hasText && now.silenceMs >= RESPONSE_SETTLE_MS;
  return settled ? streak + 1 : 0;
}

/**
 * Does this reply stop in the middle of something?
 *
 * The quiet rule watches the *page*: no Stop button, and text that has not
 * changed for 1.5s, twice over. A code block starting to render looks exactly
 * like that — the Stop button flickers while the composer re-renders and the
 * text pauses while the fence is built. Observed three times in one turn, each
 * reply ending at a backtick, each followed by the model carrying on into a
 * `stale_response`.
 *
 * So the *content* gets a veto the page cannot give: an odd number of code
 * fences, or a trailing unclosed inline backtick, means Gemini was mid-construct
 * and the silence was a pause rather than an ending.
 *
 * Deliberately narrow. Prose that merely stops abruptly is not detectable and
 * is not claimed to be — this only catches the case where the markup itself
 * says the text is incomplete, which is the case that was happening.
 */
function looksUnfinished(text) {
  const t = String(text || '');
  if (!t) return false;
  if ((t.match(/```/g) || []).length % 2 === 1) return true;
  /*
   * A lone *inline* backtick on the final line — and the fences have to come
   * out first.
   *
   * `extractTextContent` ends with `.trim()`, so a reply that ends in a code
   * block ends on its closing fence. Three backticks is an odd count, so this
   * rule vetoed **every reply that ended in a code block** — which is every
   * tool call, and therefore every round of the agent loop. Each veto reset
   * `quietStreak`, and six grace holds at the confirming cadence is roughly
   * twenty seconds added to a turn that had already finished. Reported from
   * use as "a considerable delay between Gemini sending the JSON block and us
   * sending back the tool result", at 28s on a `list_directory` call.
   *
   * The old test missed it by ending its fixture `\n\`\`\`\nDone.` — the
   * block followed by prose, so the last line was never the fence. Real
   * replies end on it.
   */
  const outside = t.replace(/```[\s\S]*?```/g, '');
  const lastLine = outside.slice(outside.lastIndexOf('\n') + 1);
  return (lastLine.match(/`/g) || []).length % 2 === 1;
}

/**
 * Gemini's "Which response is more helpful?" modal, answered so the turn ends.
 *
 * The modal holds two complete replies and will not resolve to one until a
 * button is pressed, so a turn that meets it simply never finishes. It shows
 * up most on large prompts — which is why `PromptBuilder` tiers them at all.
 *
 * **Choosing beats retrying.** Re-sending the prompt costs a whole turn, can
 * raise the same modal again, and leaves two half-answers in the thread. One
 * click resolves it to a single reply that the existing scrape then reads
 * normally — and "one answer per turn" is a standing product decision, so
 * surfacing both to the user was never an option either.
 *
 * It takes the **first** choice, deliberately: there is no signal available
 * here that would make a quality judgement anything but a coin toss dressed
 * up as one, and a deterministic pick is at least reproducible.
 *
 * Two faults this had, both of which meant it never fired:
 *
 *  - `document.querySelector('h2, .title')` returns the FIRST such node in the
 *    document, not the dialog's. Any other heading above it and the check was
 *    answered by the wrong element.
 *  - It hunted for a button reading `Choice A`. The real control is labelled
 *    **"This response is more helpful"**, with the text down in a nested
 *    `<span>`. No selector matched, so nothing was ever clicked.
 *
 * The earlier repair here fixed a `:has-text()` SyntaxError and stopped there,
 * because the actual DOM had not been seen. It has now.
 *
 * @returns {boolean} whether a choice was made
 */
function dismissChoiceDialog() {
  const asks = (el) => (el.textContent || '').toLowerCase().includes('which response is more helpful');
  const heading = Array.from(document.querySelectorAll('h1, h2, h3, [role="heading"], .title'))
    .find(asks);
  if (!heading) return false;

  const buttons = Array.from(document.querySelectorAll('button'));
  const labelled = (b) => (b.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();

  // DOM order is left-to-right, so the first match is Choice A.
  let pick = buttons.find((b) => labelled(b).includes('this response is more helpful'));

  // Older or differently-bucketed variants, kept as fallbacks rather than
  // removed: this modal is an experiment and its markup has changed before.
  if (!pick) {
    pick = buttons.find((b) => {
      const aria = (b.getAttribute('aria-label') || '').toLowerCase();
      return aria.includes('choice a') || aria.includes('choice 1');
    });
  }
  if (!pick) pick = document.querySelector('.choice-a');
  if (!pick) return false;

  console.warn('[Gemini Bridge] A/B modal — taking the first choice to unblock the turn.');
  pick.click();
  return true;
}

/**
 * Say which half of the bridge broke, so the failure names its own cause
 * instead of arriving as a blank timeout. Gemini's DOM changes regularly and
 * the selector tables above are the first thing to go stale.
 */
function describeScrapeFailure(isGenerating) {
  if (isGenerating) {
    return (
      '[Gemini is still generating but no response text could be read. ' +
      'SELECTORS.responseMessage in gemini-bridge.js no longer matches the page.]'
    );
  }

  if (sawGenerating) {
    const counts = SELECTORS.responseMessage
      .map((sel) => `${sel} -> ${document.querySelectorAll(sel).length}`)
      .join(', ');
    return (
      '[Gemini finished replying but no response text could be read. ' +
      `SELECTORS.responseMessage matched nothing: ${counts}]`
    );
  }

  const hasInput = !!findElement(SELECTORS.inputField);
  const hasSendButton = !!findElement(SELECTORS.sendButton);
  return (
    '[Gemini never started replying — the prompt probably was not submitted. ' +
    `input field found: ${hasInput}, send button found: ${hasSendButton}.]`
  );
}

function stopResponseObserver() {
  if (responseObserver) {
    responseObserver.disconnect();
    responseObserver = null;
  }
  clearInterval(activityCheckTimer);
  activityCheckTimer = null;
  completionCheck = null;
  quietPending = () => false;
}

/**
 * Extract the latest response text from the DOM.
 */
function extractLatestResponse() {
  // Try each selector
  for (const selector of SELECTORS.responseMessage) {
    const elements = document.querySelectorAll(selector);
    if (elements.length > 0) {
      const lastEl = elements[elements.length - 1];
      return extractTextContent(lastEl);
    }
  }

  // Fallback: get all model-response or message-content elements
  const responses = document.querySelectorAll('model-response, .model-response-text, message-content');
  if (responses.length > 0) {
    const lastResponse = responses[responses.length - 1];
    return extractTextContent(lastResponse);
  }

  return null;
}

/**
 * Opening and closing the mode picker, which is fussier than it looks.
 *
 * Both of these were learned by running against gemini.google.com rather than
 * reasoned about, and both corrections matter:
 *
 * - **The trigger toggles.** Clicking it while the menu is open closes it. So a
 *   blind click is only right half the time; `aria-expanded` says which half
 *   you are in, and is checked first.
 * - **Escape must not be used.** Dispatching it on `document.body` removes the
 *   menu items but leaves `aria-expanded="true"` on the trigger — the component
 *   ends up desynchronised, and the *next* open then reads as "already open",
 *   does not click, finds nothing and fails. The first version of this closed
 *   in a `finally` with Escape and broke every discovery after the first.
 *   Clicking the trigger closes it cleanly, in under 60ms, with the attribute
 *   and the DOM agreeing.
 *
 * **And neither may wait on a page timer.** This is the same fault CLAUDE.md
 * records for completion detection, one level down and never fixed with it.
 * Both of these polled with a chained `setTimeout`, and a chained timeout in a
 * hidden tab is clamped to 1/second — 1/minute once Chrome's intensive
 * throttling starts. The picker is *always* read in a hidden tab: discovery is
 * a message to the tab, not a turn, so nothing brings it to the front first.
 *
 * So the 20 × 50ms open budget was really ≥20 seconds, and the 8 × 50ms
 * close-confirmation — which the answer waits behind, in a `finally` — another
 * ≥8. Against a server watchdog of 8 seconds. Measured in the errors log:
 * 36 × `model_options_unanswered`, of which only 13 were "no tab to ask";
 * the other 23 reached a tab and the reply arrived too late to count.
 *
 * `waitForDom` replaces the clock with the evidence. A `MutationObserver`
 * delivers at full rate in a hidden tab (9.97/s measured, in the table above),
 * the menu opening *is* a mutation, and `performance.now()` is a clock read
 * rather than a timer, so the deadline is honest too. The `setTimeout` backstop
 * is the one throttled thing left and it only ever makes a *failure* late.
 */
/*
 * **The old budget was never the number it said.** `20 × 50ms` reads as one
 * second and, chained through a hidden tab's clamped timers, actually waited
 * twenty-plus. Replacing it with a *real* one-second deadline was a 20×
 * shortening nobody asked for — the throttling had been paying for a budget
 * the code never declared. Three seconds is the honest version: an order of
 * magnitude over a normal render, and still comfortably inside the server's
 * 8s watchdog, so a picker that genuinely will not open still fails while
 * someone is waiting rather than after they have given up.
 */
const MENU_OPEN_BUDGET_MS = 3000;
const MENU_CLOSE_BUDGET_MS = 3000;
const MODEL_SETTLE_BUDGET_MS = 2000;

/**
 * Wait for the page to satisfy `predicate`, on mutations rather than on a timer.
 *
 * @param {() => any} predicate returns a truthy value to resolve with, else falsy
 * @param {number} budgetMs ceiling, enforced on each mutation and by a backstop
 * @returns {Promise<any|null>} what the predicate returned, or null on timeout
 */
function waitForDom(predicate, budgetMs) {
  return new Promise((resolve) => {
    const first = predicate();
    if (first) { resolve(first); return; }

    const deadline = performance.now() + budgetMs;
    let settled = false;
    let observer = null;
    let backstop = null;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      observer?.disconnect();
      clearTimeout(backstop);
      resolve(value || null);
    };

    const test = () => {
      const hit = predicate();
      if (hit) finish(hit);
      else if (performance.now() >= deadline) finish(null);
    };

    observer = new MutationObserver(test);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    // A page that goes completely still never fires the observer again, so the
    // promise still needs one timer to settle it. Throttled, and that is fine:
    // it is only reached when the answer is "no".
    backstop = setTimeout(() => finish(predicate()), budgetMs);
  });
}

/**
 * Which entries are models, and which are modes — asked of the DOM, not of a
 * word list.
 *
 * The picker separates the two with a rule, and that rule is a real element:
 *
 *     3.5 Flash-Lite
 *     3.8 Flash
 *     3.1 Pro
 *     ──────────────   <mat-divider>
 *     Extended thinking
 *
 * Verified against the live menu, walking it in DOM order. It agrees exactly
 * with what Gemini's own `⌘⇧M` shortcut does: that cycles the three entries
 * above the line — `Flash-Lite → Flash → Pro → Flash-Lite` — and never lands on
 * Extended thinking. Two independent views of the same boundary.
 *
 * This is what lets the server stop knowing any product names. It had to veto
 * `extended` and `complex` by hand in every rung's `avoid` list, which is a
 * guess about English that breaks the moment Google ships a fourth mode or
 * renames this one. The divider cannot be renamed, because it says nothing.
 *
 * `isMode` is reported rather than filtered out here: the server decides what a
 * rung means, and throwing information away at the edge is how a consumer ends
 * up guessing it back.
 */
function describeMenu(items) {
  const menu = items[0]?.closest('[role="menu"]') || document.querySelector('[role="menu"]');
  const isSeparator = (el) => el.getAttribute?.('role') === 'separator'
    || /(^|\s)mat-divider(\s|$)/.test(el.className || '')
    || el.tagName?.toLowerCase() === 'mat-divider';

  // Walk in DOM order so "after the rule" is positional rather than inferred.
  const order = [];
  const visit = (el) => {
    for (const child of el.children || []) {
      if (child.getAttribute('role') === 'menuitem' || items.includes(child)) order.push(child);
      else if (isSeparator(child)) order.push('rule');
      else visit(child);
    }
  };
  if (menu) visit(menu);

  let seenRule = false;
  const modeOf = new Map();
  for (const entry of order) {
    if (entry === 'rule') { seenRule = true; continue; }
    modeOf.set(entry, seenRule);
  }

  return items.map((el) => ({
    ...describeModelOption(el),
    // No rule found at all — an older layout, or a plan with no modes. Then
    // nothing is a mode, and the server's word veto is still there behind this.
    isMode: modeOf.get(el) === true,
  }));
}

function modelMenuItems() {
  for (const selector of SELECTORS.modelMenuItem) {
    const found = [...document.querySelectorAll(selector)];
    if (found.length > 1) return found;
  }
  return [];
}

async function openModelMenu(trigger) {
  if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click();
  const items = await waitForDom(() => {
    const found = modelMenuItems();
    return found.length > 1 ? found : null;
  }, MENU_OPEN_BUDGET_MS);
  return items || [];
}

/**
 * Close it — including when it opens *after* we stopped waiting for it.
 *
 * The old confirmation loop never retried and never reported: it polled until
 * the attribute flipped and then returned either way, so every tick was spent
 * on a value nobody read, inside the `finally` the model list returns through.
 * That part is gone and stays gone; the answer is not held behind cleanup.
 *
 * **But "click only if it is open right now" is a trap, and it is the one this
 * file's own comment describes.** The open budget can expire before the
 * component has set `aria-expanded`, and then the menu renders a moment later
 * with nobody left to close it. A menu left open swallows the next click — so
 * the *following* turn types its prompt into the composer and the send lands
 * on the menu's backdrop instead. That looks exactly like a dead tab, two
 * turns away from the discovery that caused it.
 *
 * So this is asynchronous and deliberately **not awaited**: it waits for the
 * menu to be open, then closes it, and gives up quietly if it never opens.
 * Nothing reads the result, which is why it must not be able to throw.
 */
async function closeModelMenu(trigger) {
  try {
    const open = await waitForDom(
      () => trigger.getAttribute('aria-expanded') === 'true' || null,
      MENU_CLOSE_BUDGET_MS,
    );
    if (open) trigger.click();
  } catch { /* cleanup, and nobody is waiting on it */ }
}

/**
 * Read the mode picker, without deciding anything.
 *
 * What Gemini offers depends on the subscription: the version numbers move, and
 * a plan can be missing a tier entirely. So the list is read from the page and
 * sent to the server, which matches it against the effort rung
 * (`core/model-match.js`). Nothing here knows what "deep" means.
 */
async function readModelOptions() {
  const trigger = findElement(SELECTORS.modelTrigger) || findModelTriggerStructurally();
  if (!trigger) throw new Error('[find_model_trigger] no control that opens the mode picker');

  try {
    const items = await openModelMenu(trigger);
    if (items.length === 0) throw new Error('[open_model_menu] the picker did not open, or has no options');
    return describeMenu(items).filter((m) => m.label);
  } finally {
    // Always: a menu left open swallows the next click, and the turn after that
    // looks like a dead tab — a failure surfacing nowhere near its cause.
    closeModelMenu(trigger);
  }
}

/**
 * The trigger, found by shape when no selector matches.
 *
 * EXTENSION-PLAN phase 7's argument: a ladder that misses loses the turn, and
 * the element is usually still findable by what it *is*.
 *
 * The first version of this looked for short-labelled buttons inside "the
 * composer", taken as the input's great-grandparent. Run against the real page
 * it returned nothing at all — that ancestor does not contain the picker, which
 * sits six levels up. Recorded because a fallback that cannot fire is worse than
 * none: it makes the ladder look like it has a safety net.
 *
 * What does hold is `aria-haspopup`. The picker is the popup-button nearest the
 * prompt box that is not one of the composer's own controls, so this walks up
 * from the input until an ancestor contains one. Verified to select the mode
 * picker and nothing else.
 */
function findModelTriggerStructurally() {
  const input = findInputResilient();
  if (!input) return null;

  // Everything else in the composer that opens a menu — attachments, canvas,
  // the mic — by the words their labels use.
  const NOT_THE_PICKER = /send|submit|attach|upload|mic|voice|image|canvas|research/i;

  let node = input;
  for (let level = 0; node && level < 8; level++) {
    const buttons = [...node.querySelectorAll('button[aria-haspopup="true"], button[aria-haspopup="menu"]')]
      .filter((b) => !NOT_THE_PICKER.test(`${b.getAttribute('aria-label') || ''} ${b.textContent || ''}`));
    if (buttons.length > 0) return buttons[0];
    node = node.parentElement;
  }
  return null;
}

/**
 * Which model the picker says is selected, without opening it.
 *
 * The trigger's own label carries it — "Open mode picker, currently Pro" —
 * measured against the live page on 2026-09-24. That makes it readable with a
 * single DOM query and no menu interaction, which is what lets the worker
 * *confirm* a switch instead of sleeping and hoping.
 *
 * Deliberately not `readModelOptions()`: that opens the menu, and opening the
 * menu over a composer is the bug `switch_model` was just laned to avoid.
 */
function currentModelLabel() {
  const trigger = findElement(SELECTORS.modelTrigger) || findModelTriggerStructurally();
  const label = trigger?.getAttribute('aria-label') || '';
  const m = label.match(/currently\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/** One option's label, its own description, and whether it is the current one. */
function describeModelOption(el) {
  const lines = (el.innerText || el.textContent || '')
    .split('\n').map((l) => l.trim()).filter(Boolean);

  return {
    label: lines[0] || '',
    // Gemini writes a one-line purpose under each name — "Fastest answers",
    // "Advanced reasoning". That is what the server matches on, so it survives
    // the names changing.
    description: lines[1] || '',
    // On the real page the current option is marked by a `selected` class and
    // nothing else — `aria-checked` and `aria-selected` are both absent, so the
    // aria checks are future-proofing rather than what fires today.
    //
    // `active` is NOT selection. It is on whichever item the menu opened
    // focused, which is the first one, so reading it would report the top of
    // the list as current every time.
    selected: el.classList.contains('selected')
      || el.getAttribute('aria-checked') === 'true'
      || el.getAttribute('aria-selected') === 'true',
  };
}

/**
 * Switch to a named option, by the label the server saw.
 *
 * Matched on the label rather than an index: the menu can reorder, and picking
 * position N of a list that moved is how you end up on a model nobody chose.
 */
async function selectModelByLabel(label) {
  const wanted = String(label || '').trim().toLowerCase();
  if (!wanted) throw new Error('[switch_model] no model named');

  const trigger = findElement(SELECTORS.modelTrigger) || findModelTriggerStructurally();
  if (!trigger) throw new Error('[find_model_trigger] no control that opens the mode picker');

  const items = await openModelMenu(trigger);

  /*
   * Describe them *now*, while the menu we already opened is on screen.
   *
   * The caller needs the option list to report the switch, and it used to get
   * it by calling `readModelOptions()` afterwards — a **second** open of the
   * same menu, moments after this one closed. `currentModelLabel`'s comment,
   * twenty lines up, already says why that is wrong: opening the menu over a
   * composer is the bug `switch_model` was given its own lane to avoid.
   *
   * Reported with two screenshots on 2026-09-25 — the picker open over a
   * composer holding an unsent prompt, and `3.1 Pro` correctly ticked behind
   * it. The switch had *worked*; the second open is what swallowed the send.
   */
  const described = describeMenu(items).filter((m) => m.label);
  const hit = items.find((el) => describeModelOption(el).label.trim().toLowerCase() === wanted);

  if (!hit) {
    closeModelMenu(trigger);
    throw new Error(`[switch_model] the picker has no option called "${label}"`);
  }

  // What the trigger said before, so "has it settled" can be asked without
  // knowing any product names — see the wait below.
  const labelBefore = currentModelLabel();

  // Clicking an option closes the menu itself — no close needed, and calling
  // one would re-open it.
  hit.click();

  /*
   * Wait for the trigger to change, not for 300ms and not for a name.
   *
   * The sleep it replaced was a guess at how long the component takes, and in
   * a hidden tab it is not 300ms — chained page timers are clamped to a second
   * or worse.
   *
   * It then compared the new label against the one we asked for, which needed
   * a loose name match because the picker says "3.1 Pro" where the server said
   * "Pro". That comparison is gone: `markSelected` below answers *which* option
   * is selected, authoritatively and by position, so all this needs is to know
   * the component has finished moving. "Different from before" says that
   * without knowing a single product name, which is the same footing
   * everything else here now stands on.
   *
   * A timeout is not a failure — the trigger is read either way, so what goes
   * back is what the picker says rather than what we asked for.
   */
  await waitForDom(
    () => {
      const now = currentModelLabel();
      return now && now !== labelBefore ? now : null;
    },
    MODEL_SETTLE_BUDGET_MS,
  );

  /*
   * The selection, re-derived from the trigger rather than from a second menu.
   *
   * `describeModelOption` read `selected` off the menu items *before* the
   * click, so that flag is one state stale. The trigger's own `aria-label` —
   * "Open mode picker, currently Pro" — carries the answer with a single DOM
   * query and no interaction, which is the entire reason `currentModelLabel`
   * exists. Verified against the live page: the label updates with the click.
   */
  return markSelected(described, currentModelLabel());
}

/** Lower-cased and trimmed, the only normalisation any of this needs. */
const norm = (s) => String(s || '').trim().toLowerCase();

/**
 * Which option is the trigger's label naming — exactly one, or none.
 *
 * **Substring alone is ambiguous here and gets it wrong.** The trigger says
 * `Flash`; the menu offers `3.8 Flash` *and* `3.5 Flash-Lite`, and both
 * contain it. `find` would then return whichever is first in the DOM, which is
 * `3.5 Flash-Lite` — so switching to Flash would confirm the lite model, on a
 * path whose entire purpose is to report the truth rather than the request.
 *
 * The version prefix is what makes this decidable: dropping the leading
 * `3.1`-style token turns `3.1 Pro` into `Pro` and `3.5 Flash-Lite` into
 * `Flash-Lite`, and then an exact comparison separates them. Substring is kept
 * as a fallback for a vocabulary that does not look like today's, and there it
 * follows `pickModelFor`'s rule for pins: **one hit is an answer, several are
 * not**. Nothing selected is an honest outcome — the CLI already has a row for
 * "still on X, asked for Y".
 */
function markSelected(described, triggerLabel) {
  const wanted = norm(triggerLabel);
  const stripVersion = (s) => norm(s).replace(/^\d+(\.\d+)*\s+/, '');

  let index = described.findIndex((m) => stripVersion(m.label) === wanted);
  if (index === -1) {
    const hits = described
      .map((m, i) => i)
      .filter((i) => wanted && norm(described[i].label).includes(wanted));
    index = hits.length === 1 ? hits[0] : -1;
  }
  return described.map((m, i) => ({ ...m, selected: i === index }));
}

/**
 * Turn the reply's DOM into markdown.
 *
 * **Why this is a walker and not a list of fixes.** It used to be a series of
 * `querySelectorAll` passes — one for code, one for bold, one for lists — over
 * a clone, finishing with `clone.textContent`. That works for the tags someone
 * thought of and silently mangles everything else, because `textContent`
 * concatenates with no separator. Measured on the old version:
 *
 * ```
 * <blockquote>      the quote marker vanished
 * <hr>              vanished entirely
 * <del>wrong</del>  read as ordinary text — the meaning inverted
 * <img>             vanished
 * <details>         "MoreHidden detail"
 * <dl><dt><dd>      "TermDefinition.After."
 * <table>           "FactorNative API AgentsCostMetered token costs..."
 * ```
 *
 * The reported table bug was not a special case; it was the default. So the
 * question worth answering is not "which tags are missing" but "what happens to
 * a tag nobody listed", and the answer here is: block elements get separated,
 * inline elements do not. A tag this does not know still comes out readable,
 * which is the property the old version could not have.
 *
 * Nothing is dropped silently. Anything with no markdown equivalent falls
 * through to its own text, in the right place.
 */

function extractTextContent(element) {
  if (!element) return '';

  // Declared inside, not at module scope. `test/load-content-script.js` lifts
  // one function out of this file by brace matching — deliberately, so the
  // tests run the shipped source with nothing mocked — which means anything
  // this closes over at module scope is invisible to it. A helper the tests
  // cannot reach is a helper the tests do not cover.
  /** Elements that end the line they are on. Everything else flows inline. */
  const BLOCK_TAGS = new Set([
    'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DETAILS', 'DIALOG', 'DIV',
    'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2',
    'H3', 'H4', 'H5', 'H6', 'HEADER', 'HGROUP', 'HR', 'LI', 'MAIN', 'NAV', 'OL',
    'P', 'PRE', 'SECTION', 'TABLE', 'UL',
  ]);

  /** Never part of a reply, whatever it contains. */
  const DROP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'BUTTON']);

  /** The language of a code block, wherever this site happens to keep it. */
  function codeLanguage(el) {
    if (!el) return '';
    const attr = el.getAttribute && el.getAttribute('data-language');
    if (attr) return attr;
    const cls = el.className && typeof el.className === 'string' ? el.className : '';
    return (cls.match(/language-(\w+)/) || [])[1] || '';
  }

  /** One table, as markdown pipe rows. */
  function tableToMarkdown(table, render) {
    const rows = [...table.querySelectorAll('tr')];
    if (rows.length === 0) return '';

    const cellsOf = (tr) => [...tr.children]
      .filter((c) => c.tagName === 'TD' || c.tagName === 'TH')
      // Flattened to one line: a newline inside a pipe row ends the row, so a
      // cell containing a list would silently truncate the table.
      .map((c) => render(c).replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim());

    const body = rows.map(cellsOf).filter((cells) => cells.length > 0);
    if (body.length === 0) return '';

    const width = Math.max(...body.map((cells) => cells.length));
    const line = (cells) => {
      const out = cells.slice(0, width);
      while (out.length < width) out.push('');
      return `| ${out.join(' | ')} |`;
    };

    // A table with no <th> still needs a header row, or it is not markdown.
    const lines = [line(body[0]), `|${' --- |'.repeat(width)}`];
    for (const cells of body.slice(1)) lines.push(line(cells));
    return `\n\n${lines.join('\n')}\n\n`;
  }

  /**
   * @param {Node} node
   * @param {{pre: boolean}} ctx
   */
  const render = (node, ctx = { pre: false }) => {
    if (!node) return '';

    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || '';
      // Source indentation is not content. Inside <pre> it is.
      return ctx.pre ? text : text.replace(/\s+/g, ' ');
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const tag = node.tagName;
    if (DROP_TAGS.has(tag)) return '';

    const children = (over = {}) => [...node.childNodes]
      .map((child) => render(child, { ...ctx, ...over })).join('');

    switch (tag) {
      case 'CODE-BLOCK':
      case 'PRE': {
        const pre = tag === 'PRE' ? node : node.querySelector('pre');
        const code = (pre || node).querySelector('code');
        const source = code || pre || node;
        const lang = codeLanguage(code) || codeLanguage(pre) || codeLanguage(node);
        // `textContent` of the source, not of the wrapper: Gemini's wrapper
        // holds a header chip whose label and copy button would otherwise be
        // welded onto the first line of code.
        return `\n\n\`\`\`${lang}\n${source.textContent.replace(/\n+$/, '')}\n\`\`\`\n\n`;
      }

      // Inline code, but only when it is not the body of a block handled above.
      case 'CODE':
        return `\`${node.textContent}\``;

      case 'STRONG':
      case 'B':
        return `**${children()}**`;
      case 'EM':
      case 'I':
        return `*${children()}*`;
      case 'DEL':
      case 'S':
      case 'STRIKE':
        // Not cosmetic: without it, struck-through text reads as an assertion.
        return `~~${children()}~~`;

      case 'BR':
        return '\n';
      case 'HR':
        return '\n\n---\n\n';

      case 'A': {
        const href = node.getAttribute('href') || '';
        const text = children();
        return href ? `[${text}](${href})` : text;
      }
      case 'IMG': {
        const alt = node.getAttribute('alt') || '';
        const src = node.getAttribute('src') || '';
        return src ? `![${alt}](${src})` : '';
      }

      case 'H1': case 'H2': case 'H3':
      case 'H4': case 'H5': case 'H6':
        return `\n\n${'#'.repeat(Number(tag[1]))} ${children().trim()}\n\n`;

      case 'BLOCKQUOTE': {
        const body = children().trim();
        if (!body) return '';
        return `\n\n${body.split('\n').map((l) => `> ${l}`.trimEnd()).join('\n')}\n\n`;
      }

      case 'TABLE':
        return tableToMarkdown(node, (cell) => render(cell, ctx));

      case 'UL':
      case 'OL':
        // The items add their own leading newlines; the list closes itself so
        // whatever follows is not swallowed by the last item.
        return `${children()}\n`;

      case 'LI': {
        const parent = node.parentElement;
        const ordered = parent && parent.tagName === 'OL';
        const index = ordered
          ? [...parent.children].filter((c) => c.tagName === 'LI').indexOf(node) + 1
          : 0;
        const marker = ordered ? `${index}. ` : '- ';

        // A checkbox in an item is a task list, and the state is the point.
        const box = node.querySelector('input[type="checkbox"]');
        const tick = box ? (box.checked || box.hasAttribute('checked') ? '[x] ' : '[ ] ') : '';

        // Leading newlines go too, not just spaces. A *loose* item holds block
        // children (`<li><p>text</p><pre>…</pre></li>`), and those open with a
        // newline — which lands straight after the marker, leaving an empty
        // item and orphaning its own content as a sibling of the list.
        const body = children().replace(/^\s+/, '').trimEnd();

        // Continuation lines are indented to *this item's* content column, not
        // by a constant. `- ` is two columns, `1. ` is three, `10. ` is four,
        // and a task box adds four more. Two spaces under a `1. ` parent is
        // below the content column, so the nested list closed the parent and
        // reopened as a sibling: every list nested under a numbered item came
        // out flat. Blank lines stay blank rather than becoming trailing space.
        const pad = ' '.repeat(marker.length + tick.length);
        return `\n${marker}${tick}${body.replace(/\n(?=[^\n])/g, `\n${pad}`)}`;
      }

      case 'DT':
        return `\n\n**${children().trim()}**`;
      case 'DD':
        return `\n: ${children().trim()}`;

      case 'SUMMARY':
        return `\n\n**${children().trim()}**\n`;

      default:
        // The whole point: a tag nobody listed still comes out readable.
        // Block elements are separated, inline ones flow.
        return BLOCK_TAGS.has(tag) ? `\n${children()}\n` : children();
    }
  };

  return render(element)
    // Trailing spaces left by collapsed whitespace at a line end.
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Send the turn's timings, whatever the outcome.
 *
 * This used to be inline in `onResponseComplete`, which meant **a turn that
 * timed out recorded nothing at all** — and the timeout is the one case the
 * timings were wanted for. `response_timeout` could not say whether our send
 * failed, Gemini never started, or it started and the scrape was lost; the
 * marks that answer that were being taken and then thrown away.
 *
 * `outcome` is what makes the two comparable: a `complete` trace is the
 * baseline a `timeout` trace is read against.
 */
function sendTurnTrace(outcome) {
  if (!turnTrace) return;
  // Sent separately from the reply, so a trace can never delay or break one.
  safeSend({ type: 'turn_trace', payload: { model: 'gemini', outcome, stages: turnTrace.stages } });
  turnTrace = null;
}

/**
 * Called when the response appears to be complete.
 */
function onResponseComplete(responseText) {
  stopResponseObserver();

  traceMark('complete');
  sendTurnTrace('complete');

  // Send to service worker
  safeSend({
    type: 'gemini_response',
    payload: {
      content: responseText,
      complete: true,
      timedOut: false,
      requestId: currentRequestData?.requestId,
      isSubagent: currentRequestData?.isSubagent,
    },
  });
}

// ── Message Handler ─────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, payload } = message;

  switch (type) {
    /**
     * Readiness probe. The service worker polls this instead of sleeping a
     * fixed number of milliseconds after opening or re-injecting into a tab.
     *
     * Two answers, because they fail differently. `ready` means this script is
     * listening and not orphaned. `canType` means the composer is actually in
     * the DOM — which is the real precondition for an inject, and the reason
     * the old waits were seconds long rather than milliseconds.
     */
    /**
     * The service worker driving the completion check on its own clock.
     *
     * `watching` tells it whether a turn is still in flight, so it can stop
     * ticking the moment there is nothing to check rather than on a timer of
     * its own. Message delivery is an event, not a timer, so this arrives at
     * full rate in a hidden tab — which a `setInterval` in this page does not.
     */
    case 'tick_completion':
      if (completionCheck) completionCheck();
      sendResponse({
        watching: !!completionCheck,
        /**
         * "I am one observation away from done — come back sooner."
         *
         * Measured over 74 real turns: every `complete` lands on a ~2000ms
         * boundary (6004, 8966, 10001, 16002, 30064…), because the answer is
         * only noticed on the next tick. A reply that truly finished at 4.2s
         * is delivered at 6s, and the debounce that stopped replies being
         * truncated added a second whole tick on top.
         *
         * The debounce is not the problem — two independent observations is
         * the right rule. Waiting a *slow* interval for the second one is.
         */
        confirmSoon: quietPending(),
      });
      break;

    case 'ping':
      sendResponse({
        ready: bridgeAlive(),
        canType: bridgeAlive() && !!findElement(SELECTORS.inputField),
      });
      break;

    case 'inject_prompt':
      currentRequestData = {
        requestId: payload.requestId,
        isSubagent: payload.isSubagent,
      };
      injectPrompt(payload.prompt).then(success => {
        sendResponse({ success });
      }).catch(err => {
        console.error('[Gemini Bridge] injectPrompt threw:', err);
        sendResponse({ success: false, error: err.message });
      });
      return true; // Async response

    case 'stop_generation':
      // Try to find the stop generating button
      const stopBtn = findElement([
        'button[aria-label*="Stop"]',
        'button[aria-label*="stop"]',
        'button.stop-generating-button',
        'button[mattooltip*="Stop"]'
      ]);
      
      if (stopBtn) {
        stopBtn.click();
        console.log('[Gemini Bridge] Stop button clicked.');
      }
      stopResponseObserver();
      sendResponse({ success: true });
      break;

    case 'new_chat':
      // Navigate to new chat
      window.location.href = 'https://gemini.google.com/app';
      sendResponse({ success: true });
      break;

    case 'discover_models':
      /*
       * Never over a live composer.
       *
       * Reading the picker means opening a menu, and an open menu swallows the
       * next click — including the send. That is the failure this file's own
       * header describes and the reason `switch_model` was given its own lane.
       * Discovery now also fires the moment a tab is created, which is closer
       * to an inject than it has ever been, so the cheap guard is worth having:
       * `isInjecting` is already the flag for "a prompt is going in right now".
       *
       * Declining is free. The end-of-turn poll asks again a few seconds later,
       * when the composer is no longer in use.
       */
      /*
       * Deferred, never dropped.
       *
       * The first cut of this guard answered `{success: false}` to the *worker*
       * and sent nothing to the server — so the server, which is waiting on a
       * `model_options` message, waited out its entire budget and reported that
       * the browser never answered. CLAUDE.md names this exactly: dropping a
       * notification costs a line, dropping a **request** deadlocks whoever is
       * waiting on the answer. I added a request that could be silently
       * declined, which is the thing that rule exists to prevent.
       *
       * Declining is still right — a menu over a live composer swallows the
       * send — but the ask has to survive it. `pendingDiscover` runs the read
       * the moment the inject finishes, which is a second or two later and is
       * the answer the caller actually wanted.
       */
      if (isInjecting) {
        pendingDiscover = true;
        sendResponse({ success: true, deferred: true });
        return false;
      }
      readModelOptions()
        .then((models) => safeSend({ type: 'model_options', payload: { models } }))
        .catch((err) => safeSend({
          type: 'error',
          payload: { op: 'discover_models', message: err.message },
        }));
      sendResponse({ success: true });
      return true;

    case 'switch_model':
      /*
       * Report what the picker *reads*, not what we asked it to read.
       *
       * `switchedTo` used to echo `payload.label` straight back, so the CLI
       * said "Browser mode switched to X" whenever the click did not throw —
       * which is a claim, not an observation.
       *
       * **And it used to buy that observation with a second menu open.** This
       * chained `.then(() => readModelOptions())`, re-opening the picker
       * moments after the click closed it, purely to read `selected` off the
       * items. `selectModelByLabel` already had them in hand from the open it
       * performed itself, and the trigger's `aria-label` carries the current
       * model with no interaction at all — which is what `currentModelLabel`
       * was written for, and what its comment says to use *instead of* this.
       *
       * The cost of ignoring that was a menu left open across the composer
       * while the first prompt of the session was being typed into it, so the
       * send landed on the backdrop. Reported with two screenshots: the picker
       * open over an unsent prompt, with `3.1 Pro` correctly ticked behind it.
       * The switch had worked; the confirmation is what broke the turn.
       */
      selectModelByLabel(payload?.label)
        .then((models) => safeSend({
          type: 'model_options',
          payload: {
            models,
            switchedTo: (models.find((m) => m.selected) || {}).label || null,
            requested: payload?.label ?? null,
          },
        }))
        .catch((err) => safeSend({
          type: 'error',
          payload: { op: 'switch_model', message: err.message },
        }));
      sendResponse({ success: true });
      return true;

    case 'get_page_status':
      sendResponse({
        success: true,
        url: window.location.href,
        hasInput: !!findElement(SELECTORS.inputField),
        hasSendButton: !!findElement(SELECTORS.sendButton),
        // So a caller can confirm a switch landed. `switch_model` answers
        // `{success:true}` the moment it is *dispatched* — the click and the
        // menu animation are still ahead of it — so the ack cannot be the
        // confirmation, and this is what the worker polls instead.
        model: currentModelLabel(),
      });
      break;

    default:
      sendResponse({ success: false, error: 'Unknown message type' });
  }

  return false;
});

// ── Initialization ──────────────────────────────────────────────────
console.log('[Agent CLI] Content script loaded on:', window.location.href);

// Notify service worker that we're ready
safeSend({
  type: 'content_script_ready',
  payload: {
    url: window.location.href,
    timestamp: Date.now(),
  },
});

/**
 * Keep the bridge connected, from the one place that is allowed to persist.
 *
 * The service worker cannot do this for itself. Measured in Chrome 152 against
 * the real extension, refusing every handshake so each attempt is visible: the
 * server sees exactly **two attempts in 75 seconds, 30.0s apart** — and the same
 * 30.0s whether the worker schedules `setTimeout` retries, pings
 * `chrome.runtime.getPlatformInfo()` every five seconds, or holds this port
 * open. Chrome terminates the idle worker regardless, its timers die with it,
 * and `chrome.alarms` clamps to a 30-second floor. That floor was the entire
 * reconnect cadence.
 *
 * A content script is not a service worker. It lives as long as its page, so it
 * can hold the clock. `chrome.runtime.sendMessage` *wakes* the worker, which is
 * the part a port does not do — so this nudges rather than waits.
 *
 * It is well targeted: this only runs in a model tab, and without a model tab
 * there is nothing for the bridge to connect *for*. The worker returns early
 * when the socket is already open, so the steady-state cost is one no-op
 * message every few seconds.
 */
const CONNECT_NUDGE_MS = 3000;
/** Once connected there is nothing to nudge for; this is only a backstop. */
const CONNECT_NUDGE_IDLE_MS = 30000;
let keepAlivePort = null;

function connectToServiceWorker() {
  if (!bridgeAlive()) return;
  try {
    keepAlivePort = chrome.runtime.connect({ name: 'keepAlive' });
    keepAlivePort.onDisconnect.addListener(() => {
      setTimeout(connectToServiceWorker, 1000);
    });
  } catch (err) {
    // Context invalidated — the extension was reloaded under this page.
  }
}
connectToServiceWorker();

/**
 * Nudge hard while disconnected, barely at all once connected.
 *
 * This was a flat 3-second `setInterval` that ran for the life of the page, so
 * an open Gemini tab woke the service worker twenty times a minute forever —
 * a worker that is never allowed to go idle, to solve a problem that only
 * exists while there is nothing to connect to. The fast cadence is worth
 * paying when the agent has just started and the bridge is down; it buys
 * nothing at all when the socket is already open.
 *
 * So the worker answers `connect` with whether it is connected, and the tab
 * backs off to a slow heartbeat when the answer is yes. A `setTimeout` chain
 * rather than an interval, because the delay changes between ticks.
 */
let nudgeTimer = null;

function scheduleConnectNudge(delay) {
  nudgeTimer = setTimeout(async () => {
    const res = await safeSend({ type: 'connect' });
    // No answer means the worker did not reply — treat that as disconnected
    // and keep the fast cadence, which is the case this exists for.
    scheduleConnectNudge(res?.connected ? CONNECT_NUDGE_IDLE_MS : CONNECT_NUDGE_MS);
  }, delay);
}

scheduleConnectNudge(CONNECT_NUDGE_MS);
onInvalidated.push(() => clearTimeout(nudgeTimer));

})();
