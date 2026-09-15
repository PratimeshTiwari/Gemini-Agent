/**
 * ChatGPT Bridge — Content Script
 *
 * Injected into chatgpt.com pages. Handles:
 * - Injecting prompts into ChatGPT's input field
 * - Extracting ChatGPT's responses from the DOM
 * - Detecting when ChatGPT finishes responding
 * - Creating new chat sessions
 */

// ── Constants & State ───────────────────────────────────────────────

const RESPONSE_IDLE_TIMEOUT = 4000; // 15s of no new text = response complete
const RESPONSE_ACTIVITY_TIMEOUT = 60000; // 60s of no new text during streaming = consider done
const RESPONSE_MAX_TIMEOUT = 300000; // 5 min absolute max (safety net)

// ── DOM Selectors ────────────────────────────────────────────────────
const SELECTORS = {
  // The main prompt input textarea
  inputField: [
    'textarea#prompt-textarea',
    '#prompt-textarea',
    'textarea[data-id="root"]',
    'div[contenteditable="true"]#prompt-textarea',
  ],

  // The send/submit button
  sendButton: [
    'button[data-testid="send-button"]',
    'button[aria-label="Send message"]',
    'button[aria-label="Send prompt"]',
  ],

  // Container for response messages
  responseContainer: [
    'div[data-message-author-role="assistant"] .markdown',
    '.agent-turn',
  ],

  // Button to stop generation
  stopGeneratingButton: [
    'button[data-testid="stop-button"]',
    'button[aria-label="Stop generating"]',
    'button[aria-label="Stop streaming"]',
  ],

  // Individual response message (stable selectors only)
  responseMessage: [
    'div[data-message-author-role="assistant"]',
  ],

  // New chat button
  newChatButton: [
    'a[href="/"]',
    'button[aria-label="New chat"]',
  ],

  // Streaming indicator
  streamingIndicator: [
    'button[data-testid="stop-button"]',
    'button[aria-label="Stop generating"]',
    '.result-streaming',
  ],
};

// ── State ────────────────────────────────────────────────────────────
let isInjecting = false;
let responseObserver = null;
let lastResponseText = '';
let responseIdleTimer = null;
let initialResponseCount = 0;
let responseStartTime = 0;
let lastActivityTime = 0;
let activityCheckTimer = null;
let currentRequestData = null;

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
 * Inject a prompt into ChatGPT's input field and send it.
 */
async function injectPrompt(text) {
  if (isInjecting) {
    console.warn('[ChatGPT Bridge] Already injecting a prompt');
    return false;
  }

  isInjecting = true;

  try {
    const input = findElement(SELECTORS.inputField);
    if (!input) {
      throw new Error('[find_input] Could not find the ChatGPT input field — the editor selector has probably changed');
    }

    // Record how many responses exist BEFORE we send
    initialResponseCount = getResponseCount();

    input.focus();

    // Safely clear content
    if (input.tagName === 'TEXTAREA') {
      // Native textarea
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value'
      ).set;
      nativeSetter.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      // ContentEditable
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);

      const dataTransfer = new DataTransfer();

      // Attach the image, rather than deleting it. This used to strip the
      // <image_data> block and paste the remaining text, so `/image` against
      // ChatGPT silently sent a prompt that talked about a screenshot nobody
      // had been given. Same technique as the Gemini bridge: rebuild the data
      // URL into a real File and let one paste event carry both.
      const imgRegex = /<image_data>\n(data:image\/[^;]+;base64,[^\n]+)\n<\/image_data>/;
      const imgMatch = text.match(imgRegex);
      let hasImage = false;

      if (imgMatch) {
        text = text.replace(imgRegex, '').trim();
        try {
          const res = await fetch(imgMatch[1]);
          const blob = await res.blob();
          const ext = (blob.type.split('/')[1] || 'png');
          dataTransfer.items.add(new File([blob], `image.${ext}`, { type: blob.type }));
          hasImage = true;
          console.log(`[ChatGPT Bridge] Attached image file: image.${ext} (${Math.round(blob.size / 1024)}KB)`);
        } catch (err) {
          // The prompt still goes; the model is told the image did not.
          console.error('[ChatGPT Bridge] Failed to convert image data URL to Blob', err);
          text = `${text}\n\n(An image was attached but could not be delivered to this tab.)`;
        }
      }

      if (text) {
        dataTransfer.setData('text/plain', text);
      }

      const pasteEvent = new ClipboardEvent('paste', {
        clipboardData: dataTransfer,
        bubbles: true,
        cancelable: true,
      });

      input.focus();
      const pasteHandled = !input.dispatchEvent(pasteEvent);

      // The upload is asynchronous; sending before it lands drops the file.
      if (hasImage) {
        await new Promise((r) => setTimeout(r, 500));
      }

      if (!pasteHandled && text) {
        input.focus();
        document.execCommand('insertText', false, text);
      }

      input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // Wait for the send button to become enabled
    const sendBtn = await waitForSendButton(input, 30000);

    if (sendBtn === 'submitted') {
      console.log('[ChatGPT Bridge] Proceeding since prompt was manually submitted.');
    } else if (sendBtn) {
      sendBtn.click();
      console.log('[ChatGPT Bridge] Send button clicked');
    } else {
      // Fallback: Dispatch Enter key
      console.warn('[ChatGPT Bridge] Send button not found, pressing Enter as last resort');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));

      await new Promise(r => setTimeout(r, 1000));
      const currentText = input.tagName === 'TEXTAREA' ? input.value : input.textContent;
      if (currentText.trim().length > 0) {
        throw new Error("[send_button] Send button never became active — the button selector has probably changed");
      }
    }

    // Start watching for the response
    startResponseObserver();

    return true;
  } catch (err) {
    console.error('[ChatGPT Bridge] Injection failed:', err);
    return false;
  } finally {
    isInjecting = false;
  }
}

/**
 * Wait for the send button to appear and become enabled.
 */
function waitForSendButton(input, maxWait = 30000) {
  return new Promise((resolve) => {
    const startTime = Date.now();

    function check() {
      // If the user manually clicked send, the input clears
      const currentText = input.tagName === 'TEXTAREA' ? input.value : input.textContent;
      if (input && currentText.trim().length === 0) {
        console.log('[ChatGPT Bridge] Detected manual submission (input cleared).');
        resolve('submitted');
        return;
      }

      const btn = findElement(SELECTORS.sendButton);
      
      if (btn) {
        const isDisabled = btn.disabled || btn.getAttribute('aria-disabled') === 'true';
        if (!isDisabled) {
          resolve(btn);
          return;
        }
      }

      if (Date.now() - startTime >= maxWait) {
        console.warn(`[ChatGPT Bridge] Timed out waiting for send button after ${maxWait}ms`);
        resolve(null);
        return;
      }

      setTimeout(check, 200);
    }

    setTimeout(check, 500);
  });
}

// ── Response Extraction ─────────────────────────────────────────────

/**
 * Start observing for ChatGPT's response.
 */
function startResponseObserver() {
  stopResponseObserver();
  lastResponseText = '';
  responseStartTime = Date.now();
  lastActivityTime = Date.now();

  let lastStreamedText = '';
  let streamingUpdateTimer = null;

  responseObserver = new MutationObserver((mutations) => {
    // Only process if a NEW response element has appeared
    const currentCount = getResponseCount();
    if (currentCount <= initialResponseCount) {
      return;
    }

    const currentResponse = extractLatestResponse();

    if (currentResponse && currentResponse !== lastResponseText) {
      lastResponseText = currentResponse;
      lastActivityTime = Date.now();

      clearTimeout(responseIdleTimer);
      responseIdleTimer = setTimeout(() => {
        onResponseComplete(currentResponse);
      }, RESPONSE_IDLE_TIMEOUT);

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
            }).catch(() => {});
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

  // Activity checker
  activityCheckTimer = setInterval(() => {
    const now = Date.now();
    const totalElapsed = now - responseStartTime;
    const silenceDuration = now - lastActivityTime;

    if (totalElapsed >= RESPONSE_MAX_TIMEOUT) {
      console.warn('[ChatGPT Bridge] Absolute max timeout reached (5 min)');
      clearInterval(streamingUpdateTimer);
      stopResponseObserver();
      safeSend({
        type: 'gemini_response',
        payload: {
          content: lastResponseText || '[No response received — max timeout reached]',
          complete: false,
          timedOut: true,
          requestId: currentRequestData?.requestId,
          isSubagent: currentRequestData?.isSubagent,
        },
      });
      return;
    }

    // Check if stop button has disappeared (response finished)
    const isStillStreaming = !!findElement(SELECTORS.streamingIndicator);
    if (lastResponseText && !isStillStreaming && silenceDuration >= 3000) {
      console.log('[ChatGPT Bridge] Streaming indicator gone + 3s silence → response complete');
      clearInterval(streamingUpdateTimer);
      onResponseComplete(lastResponseText);
      return;
    }

    if (lastResponseText && silenceDuration >= RESPONSE_ACTIVITY_TIMEOUT) {
      console.warn('[ChatGPT Bridge] Response activity timeout (60s silence)');
      clearInterval(streamingUpdateTimer);
      onResponseComplete(lastResponseText);
    }
  }, 5000);
}

function stopResponseObserver() {
  if (responseObserver) {
    responseObserver.disconnect();
    responseObserver = null;
  }
  clearTimeout(responseIdleTimer);
  clearInterval(activityCheckTimer);
  activityCheckTimer = null;
}

/**
 * Extract the latest response text from the DOM.
 */
function extractLatestResponse() {
  // Try assistant message containers
  const assistantMsgs = document.querySelectorAll('div[data-message-author-role="assistant"]');
  if (assistantMsgs.length > 0) {
    const lastMsg = assistantMsgs[assistantMsgs.length - 1];
    // Get the .markdown child within the assistant message
    const markdownEl = lastMsg.querySelector('.markdown');
    if (markdownEl) return extractTextContent(markdownEl);
    return extractTextContent(lastMsg);
  }

  return null;
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
   * @param {{listDepth: number, pre: boolean}} ctx
   */
  const render = (node, ctx = { listDepth: 0, pre: false }) => {
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
        return `${children({ listDepth: ctx.listDepth + 1 })}\n`;

      case 'LI': {
        const depth = Math.max(0, ctx.listDepth - 1);
        const parent = node.parentElement;
        const ordered = parent && parent.tagName === 'OL';
        const index = ordered
          ? [...parent.children].filter((c) => c.tagName === 'LI').indexOf(node) + 1
          : 0;
        const marker = ordered ? `${index}. ` : '- ';

        // A checkbox in an item is a task list, and the state is the point.
        const box = node.querySelector('input[type="checkbox"]');
        const tick = box ? (box.checked || box.hasAttribute('checked') ? '[x] ' : '[ ] ') : '';

        // Trimmed at the front only: a nested list inside this item has already
        // produced its own newlines and they have to survive.
        const body = children().replace(/^[ \t]+/, '').trimEnd();
        return `\n${'  '.repeat(depth)}${marker}${tick}${body}`;
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
        console.error('[ChatGPT Bridge] injectPrompt threw:', err);
        sendResponse({ success: false, error: err.message });
      });
      return true; // Async response

    case 'stop_generation':
      const stopBtn = findElement(SELECTORS.stopGeneratingButton);
      
      if (stopBtn) {
        stopBtn.click();
        console.log('[ChatGPT Bridge] Stop button clicked.');
      }
      stopResponseObserver();
      sendResponse({ success: true });
      break;

    case 'new_chat':
      // Navigate to ChatGPT's new chat page
      window.location.href = 'https://chatgpt.com/';
      sendResponse({ success: true });
      break;

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
console.log('[ChatGPT Bridge] Content script loaded on:', window.location.href);

// Notify service worker that we're ready
safeSend({
  type: 'content_script_ready',
  payload: {
    url: window.location.href,
    model: 'chatgpt',
    timestamp: Date.now(),
  },
});

/**
 * Keep the bridge connected — see the long note in `gemini-bridge.js`. In short:
 * Chrome terminates the idle service worker and its timers die with it, so the
 * only reconnect cadence was `chrome.alarms`' 30-second floor. A content script
 * lives as long as its page, and `sendMessage` wakes the worker.
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
