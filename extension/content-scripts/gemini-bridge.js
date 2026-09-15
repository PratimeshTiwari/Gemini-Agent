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
const RESPONSE_ACTIVITY_TIMEOUT = 60000; // 60s of no new text during streaming = consider done
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
let activityCheckTimer = null;
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
    const pasteHandled = !input.dispatchEvent(pasteEvent);

    // If we pasted an image, wait for it to process
    if (hasImage) {
      await new Promise(r => setTimeout(r, 500));
    }

    // Fallback: If paste wasn't handled natively by Gemini, use insertText
    if (!pasteHandled && text) {
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
  }
}

/**
 * Wait for the send button to appear and become enabled.
 * Polls every 200ms up to maxWait ms.
 */
function waitForSendButton(input, maxWait = 30000, buttonsBeforeText = null) {
  return new Promise((resolve) => {
    const startTime = Date.now();

    function check() {
      // If the user manually clicked send, the input clears! We can stop waiting.
      if (input && input.textContent.trim().length === 0) {
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

      setTimeout(check, 200);
    }

    // Initial delay to let the UI register the pasted text
    setTimeout(check, 500);
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
  traceMark('first_token');
  lastActivityTime = Date.now();
  sawGenerating = false;

  let lastStreamedText = '';
  let streamingUpdateTimer = null;

  responseObserver = new MutationObserver((mutations) => {
    // Only process if a NEW response element has appeared
    const currentCount = getResponseCount();
    if (currentCount <= initialResponseCount) {
      return; // Still waiting for Gemini to start replying
    }

    const currentResponse = extractLatestResponse();

    if (currentResponse && currentResponse !== lastResponseText) {
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
  activityCheckTimer = setInterval(() => {
    const now = Date.now();
    const totalElapsed = now - responseStartTime;
    const silenceDuration = now - lastActivityTime;

    // Do not check for completion in the first 3 seconds to allow the DOM to update
    if (totalElapsed < 3000) return;

    // Detect and dismiss Gemini A/B test dialog ("Which response is more helpful?")
    // These dialogs block the UI and prevent completion
    const abTestTitle = document.querySelector('h2, .title');
    if (abTestTitle && abTestTitle.textContent.toLowerCase().includes('which response is more helpful')) {
      // `:has-text()` is Playwright syntax, not CSS. querySelector threw a
      // SyntaxError on it, which aborted this whole block before the text search
      // below could run — so the dialog was never actually dismissed.
      let btnToClick = document.querySelector('.choice-a, [aria-label*="Choice A" i], [aria-label*="Choice 1" i]');
      if (!btnToClick) {
        const buttons = Array.from(document.querySelectorAll('button'));
        btnToClick = buttons.find(b => b.textContent.includes('Choice A') || b.textContent.includes('Choice 1'));
      }

      if (btnToClick) {
        console.warn('[Gemini Bridge] Detected A/B test dialog! Auto-selecting Choice A to dismiss it.');
        btnToClick.click();
        lastActivityTime = Date.now(); // reset timeout to allow extraction
      }
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
    if (isGenerating) sawGenerating = true;

    // If Gemini has stopped generating (no stop button) AND we have some text, it's done!
    // We add a tiny 1-second silence buffer to ensure the DOM is fully settled.
    if (!isGenerating && lastResponseText && silenceDuration >= 1000) {
      console.log('[Gemini Bridge] Generation finished (Stop button disappeared + 1s settled)');
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
      safeSend({
        type: 'gemini_response',
        payload: { content: diagnosis, complete: false, timedOut: true },
      });
      return;
    }

    // Absolute max timeout (5 minutes)
    if (totalElapsed >= RESPONSE_MAX_TIMEOUT) {
      console.warn('[Gemini Bridge] Absolute max timeout reached (5 min)');
      clearInterval(streamingUpdateTimer);
      stopResponseObserver();
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
  }, 2000);
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
 */
const MENU_ITEM_POLL_MS = 50;
const MENU_ITEM_POLL_TRIES = 20;

function modelMenuItems() {
  for (const selector of SELECTORS.modelMenuItem) {
    const found = [...document.querySelectorAll(selector)];
    if (found.length > 1) return found;
  }
  return [];
}

async function openModelMenu(trigger) {
  if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click();
  for (let i = 0; i < MENU_ITEM_POLL_TRIES; i++) {
    const items = modelMenuItems();
    if (items.length > 1) return items;
    await new Promise((r) => setTimeout(r, MENU_ITEM_POLL_MS));
  }
  return [];
}

async function closeModelMenu(trigger) {
  if (trigger.getAttribute('aria-expanded') !== 'true') return;
  trigger.click();
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, MENU_ITEM_POLL_MS));
    if (trigger.getAttribute('aria-expanded') !== 'true') return;
  }
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
    return items.map(describeModelOption).filter((m) => m.label);
  } finally {
    // Always: a menu left open swallows the next click, and the turn after that
    // looks like a dead tab — a failure surfacing nowhere near its cause.
    await closeModelMenu(trigger);
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
  const hit = items.find((el) => describeModelOption(el).label.trim().toLowerCase() === wanted);

  if (!hit) {
    await closeModelMenu(trigger);
    throw new Error(`[switch_model] the picker has no option called "${label}"`);
  }

  // Clicking an option closes the menu itself — no close needed, and calling
  // one would re-open it.
  hit.click();
  await new Promise((r) => setTimeout(r, 300));
  return true;
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
 * Called when the response appears to be complete.
 */
function onResponseComplete(responseText) {
  stopResponseObserver();

  traceMark('complete');
  if (turnTrace) {
    // Sent separately from the reply, so a trace can never delay or break one.
    safeSend({ type: 'turn_trace', payload: { model: 'gemini', stages: turnTrace.stages } });
    turnTrace = null;
  }

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
      readModelOptions()
        .then((models) => safeSend({ type: 'model_options', payload: { models } }))
        .catch((err) => safeSend({
          type: 'error',
          payload: { op: 'discover_models', message: err.message },
        }));
      sendResponse({ success: true });
      return true;

    case 'switch_model':
      selectModelByLabel(payload?.label)
        .then(() => readModelOptions())
        .then((models) => safeSend({
          type: 'model_options',
          payload: { models, switchedTo: payload?.label },
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

const nudgeTimer = setInterval(() => {
  safeSend({ type: 'connect' });
}, CONNECT_NUDGE_MS);
onInvalidated.push(() => clearInterval(nudgeTimer));
