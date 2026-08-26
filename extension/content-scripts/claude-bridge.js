/**
 * Claude Bridge — Content Script
 *
 * Injected into claude.ai pages. Handles:
 * - Injecting prompts into Claude's ProseMirror input field
 * - Extracting Claude's responses from the DOM
 * - Detecting when Claude finishes responding
 * - Creating new chat sessions
 */

// ── Constants & State ───────────────────────────────────────────────

const RESPONSE_IDLE_TIMEOUT = 4000; // 15s of no new text = response complete
const RESPONSE_ACTIVITY_TIMEOUT = 60000; // 60s of no new text during streaming = consider done
const RESPONSE_MAX_TIMEOUT = 300000; // 5 min absolute max (safety net)

// ── DOM Selectors ────────────────────────────────────────────────────
// Centralized selectors — update these when Anthropic changes the UI
const SELECTORS = {
  // The main prompt input (ProseMirror)
  inputField: [
    'div[contenteditable="true"].ProseMirror',
    'div[contenteditable="true"][data-placeholder]',
    'fieldset div[contenteditable="true"]',
  ],

  // The send/submit button
  sendButton: [
    'button[aria-label="Send Message"]',
    'button[aria-label*="Send"]',
    'fieldset button[type="button"]:not([aria-label*="Attach"])',
  ],

  // Container for response messages (stable class)
  responseContainer: [
    '.font-claude-message',
    '[data-testid="chat-message-content"]',
  ],

  // Individual response message — use ONLY stable selectors for counting
  responseMessage: [
    '.font-claude-message',
  ],

  // New chat button
  newChatButton: [
    'a[href="/new"]',
    'button[aria-label="New chat"]',
  ],

  // Streaming indicator
  streamingIndicator: [
    'div[data-is-streaming="true"]',
    '.stop-button',
    'button[aria-label="Stop Response"]',
  ],

  // Stop generation
  stopGeneratingButton: [
    'button[aria-label="Stop Response"]',
    'button[aria-label*="Stop"]',
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
 * Uses ONLY stable container selectors (not data-is-streaming which flips).
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
 * Inject a prompt into Claude's ProseMirror input field and send it.
 */
async function injectPrompt(text) {
  if (isInjecting) {
    console.warn('[Claude Bridge] Already injecting a prompt');
    return false;
  }

  isInjecting = true;

  try {
    const input = findElement(SELECTORS.inputField);
    if (!input) {
      throw new Error('Could not find Claude input field');
    }

    // Record how many responses exist BEFORE we send
    initialResponseCount = getResponseCount();

    input.focus();

    // Clear existing content
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);

    // Strip image data (Claude web doesn't support programmatic image injection the same way)
    const imgRegex = /<image_data>\n(data:image\/[^;]+;base64,[^\n]+)\n<\/image_data>/;
    text = text.replace(imgRegex, '').trim();

    // ProseMirror-specific injection:
    // 1. Try clipboard paste first (most reliable for ProseMirror)
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('text/plain', text);
    const pasteEvent = new ClipboardEvent('paste', {
      clipboardData: dataTransfer,
      bubbles: true,
      cancelable: true,
    });

    const pasteHandled = !input.dispatchEvent(pasteEvent);

    if (!pasteHandled) {
      // 2. Fallback: Use InputEvent with insertText (ProseMirror respects this)
      const inputEvent = new InputEvent('beforeinput', {
        inputType: 'insertText',
        data: text,
        bubbles: true,
        cancelable: true,
        composed: true,
      });
      input.dispatchEvent(inputEvent);

      // 3. Last resort: execCommand
      if (input.textContent.trim().length === 0) {
        document.execCommand('insertText', false, text);
      }
    }

    input.dispatchEvent(new Event('input', { bubbles: true }));

    // Wait for the send button to become enabled
    const sendBtn = await waitForSendButton(input, 30000);

    if (sendBtn === 'submitted') {
      console.log('[Claude Bridge] Proceeding since prompt was manually submitted.');
    } else if (sendBtn) {
      sendBtn.click();
      console.log('[Claude Bridge] Send button clicked');
    } else {
      // Fallback: Dispatch Enter key
      console.warn('[Claude Bridge] Send button not found, pressing Enter as last resort');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));

      // Wait to see if submission worked
      await new Promise(r => setTimeout(r, 1000));
      if (input.textContent.trim().length > 0) {
        throw new Error("Failed to submit prompt: Send button never became active.");
      }
    }

    // Start watching for the response
    startResponseObserver();

    return true;
  } catch (err) {
    console.error('[Claude Bridge] Injection failed:', err);
    return false;
  } finally {
    isInjecting = false;
  }
}

/**
 * Wait for the send button to appear and become enabled.
 * Polls every 200ms up to maxWait ms.
 */
function waitForSendButton(input, maxWait = 30000) {
  return new Promise((resolve) => {
    const startTime = Date.now();

    function check() {
      // If the user manually clicked send, the input clears
      if (input && input.textContent.trim().length === 0) {
        console.log('[Claude Bridge] Detected manual submission (input cleared).');
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
        console.warn(`[Claude Bridge] Timed out waiting for send button after ${maxWait}ms`);
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
 * Start observing for Claude's response.
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
      return; // Still waiting for Claude to start replying
    }

    const currentResponse = extractLatestResponse();

    if (currentResponse && currentResponse !== lastResponseText) {
      lastResponseText = currentResponse;
      lastActivityTime = Date.now(); // Reset activity timer

      // Reset the idle timer (response is still coming)
      clearTimeout(responseIdleTimer);
      responseIdleTimer = setTimeout(() => {
        onResponseComplete(currentResponse);
      }, RESPONSE_IDLE_TIMEOUT);

      // Send streaming update every 2 seconds so CLI can show partial text
      if (!streamingUpdateTimer) {
        streamingUpdateTimer = setInterval(() => {
          if (lastResponseText && lastResponseText !== lastStreamedText) {
            lastStreamedText = lastResponseText;
            chrome.runtime.sendMessage({
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

  // Activity checker: runs every 5s to detect if Claude has gone silent
  activityCheckTimer = setInterval(() => {
    const now = Date.now();
    const totalElapsed = now - responseStartTime;
    const silenceDuration = now - lastActivityTime;

    // Absolute max timeout (5 minutes)
    if (totalElapsed >= RESPONSE_MAX_TIMEOUT) {
      console.warn('[Claude Bridge] Absolute max timeout reached (5 min)');
      clearInterval(streamingUpdateTimer);
      stopResponseObserver();
      chrome.runtime.sendMessage({
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

    // Also check if Claude's streaming indicator has disappeared (response done)
    const isStillStreaming = !!findElement(SELECTORS.streamingIndicator);
    if (lastResponseText && !isStillStreaming && silenceDuration >= 3000) {
      console.log('[Claude Bridge] Streaming indicator gone + 3s silence → response complete');
      clearInterval(streamingUpdateTimer);
      onResponseComplete(lastResponseText);
      return;
    }

    // If Claude has been silent for 60s after producing some text, consider it done
    if (lastResponseText && silenceDuration >= RESPONSE_ACTIVITY_TIMEOUT) {
      console.warn('[Claude Bridge] Response activity timeout (60s silence)');
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
  // Try the stable response container selector
  const elements = document.querySelectorAll('.font-claude-message');
  if (elements.length > 0) {
    const lastEl = elements[elements.length - 1];
    return extractTextContent(lastEl);
  }

  // Fallback: try data-is-streaming containers
  const streamingEls = document.querySelectorAll('div[data-is-streaming]');
  if (streamingEls.length > 0) {
    const lastEl = streamingEls[streamingEls.length - 1];
    return extractTextContent(lastEl);
  }

  return null;
}

/**
 * Extract clean text content from an element, preserving code blocks and basic formatting.
 */
function extractTextContent(element) {
  if (!element) return '';

  // Clone the element to avoid modifying the DOM
  const clone = element.cloneNode(true);

  // Replace code blocks with fenced blocks
  clone.querySelectorAll('pre code, code-block').forEach(codeBlock => {
    const lang = codeBlock.getAttribute('data-language') ||
                 codeBlock.className.match(/language-(\w+)/)?.[1] || '';
    const code = codeBlock.textContent;
    const replacement = document.createTextNode(`\n\`\`\`${lang}\n${code}\n\`\`\`\n`);
    codeBlock.parentElement.replaceWith(replacement);
  });

  // Replace inline code
  clone.querySelectorAll('code').forEach(code => {
    const replacement = document.createTextNode(`\`${code.textContent}\``);
    code.replaceWith(replacement);
  });

  // Convert Bold
  clone.querySelectorAll('strong, b').forEach(el => {
    el.replaceWith(document.createTextNode(`**${el.textContent}**`));
  });

  // Convert Italic
  clone.querySelectorAll('em, i').forEach(el => {
    el.replaceWith(document.createTextNode(`*${el.textContent}*`));
  });

  // Convert Links
  clone.querySelectorAll('a').forEach(el => {
    const href = el.getAttribute('href') || '';
    el.replaceWith(document.createTextNode(`[${el.textContent}](${href})`));
  });

  // Convert Headers
  clone.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(el => {
    const level = parseInt(el.tagName.substring(1), 10);
    const hashes = '#'.repeat(level);
    el.replaceWith(document.createTextNode(`\n${hashes} ${el.textContent}\n`));
  });

  // Preserve newlines for block elements
  clone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
  clone.querySelectorAll('p').forEach(p => p.append('\n\n'));
  
  // For divs, only append a newline if they directly contain text
  clone.querySelectorAll('div').forEach(div => {
    let hasDirectText = false;
    for (const child of div.childNodes) {
      if (child.nodeType === Node.TEXT_NODE && child.textContent.trim().length > 0) {
        hasDirectText = true;
        break;
      }
    }
    if (hasDirectText) {
      div.append('\n');
    }
  });

  // Preserve list items
  clone.querySelectorAll('li').forEach(li => {
    li.prepend('- ');
    li.append('\n');
  });

  // Replace multiple consecutive newlines (3 or more) with just 2 newlines
  return clone.textContent.trim().replace(/\n{3,}/g, '\n\n');
}

/**
 * Called when the response appears to be complete.
 */
function onResponseComplete(responseText) {
  stopResponseObserver();

  // Send to service worker
  chrome.runtime.sendMessage({
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
        console.error('[Claude Bridge] injectPrompt threw:', err);
        sendResponse({ success: false, error: err.message });
      });
      return true; // Async response

    case 'stop_generation':
      const stopBtn = findElement(SELECTORS.stopGeneratingButton);
      
      if (stopBtn) {
        stopBtn.click();
        console.log('[Claude Bridge] Stop button clicked.');
      }
      stopResponseObserver();
      sendResponse({ success: true });
      break;

    case 'new_chat':
      // Navigate to Claude's new chat page
      window.location.href = 'https://claude.ai/new';
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
console.log('[Claude Bridge] Content script loaded on:', window.location.href);

// Notify service worker that we're ready
chrome.runtime.sendMessage({
  type: 'content_script_ready',
  payload: {
    url: window.location.href,
    model: 'claude',
    timestamp: Date.now(),
  },
}).catch(() => {
  // Service worker may not be ready yet
});

// Keep the service worker alive by holding a persistent port connection open
let keepAlivePort = null;
function connectToServiceWorker() {
  try {
    keepAlivePort = chrome.runtime.connect({ name: 'keepAlive' });
    keepAlivePort.onDisconnect.addListener(() => {
      // Reconnect after a short delay if the port drops
      setTimeout(connectToServiceWorker, 1000);
    });
  } catch (err) {
    // Context invalidated
  }
}
connectToServiceWorker();
