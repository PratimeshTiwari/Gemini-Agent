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

const WS_URL = 'ws://localhost:7777';
const RESPONSE_IDLE_TIMEOUT = 4000; // Increased to 4s to prevent truncating long streams
const RECONNECT_BASE = 1000;

// ── DOM Selectors ────────────────────────────────────────────────────
// Centralized selectors — update these when Google changes the UI
const SELECTORS = {
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
    'button[aria-label*="Send"]',
    'button[aria-label*="submit"]',
    'button.send-button',
    'mat-icon[data-mat-icon-name="send"]',
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

  // Individual response message (the latest one)
  responseMessage: [
    'model-response:last-of-type .model-response-text',
    'model-response:last-of-type message-content',
    '.response-container:last-child .model-response-text',
    'message-content:last-of-type',
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
 * Inject a prompt into Gemini's input field and send it.
 */
async function injectPrompt(text) {
  if (isInjecting) {
    console.warn('[Gemini Bridge] Already injecting a prompt');
    return false;
  }

  isInjecting = true;

  try {
    const input = findElement(SELECTORS.inputField);
    if (!input) {
      throw new Error('Could not find Gemini input field');
    }

    // Record how many responses exist BEFORE we send
    initialResponseCount = getResponseCount();

    input.focus();

    // Safely clear content
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);

    // Paste event
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('text/plain', text);
    const pasteEvent = new ClipboardEvent('paste', {
      clipboardData: dataTransfer,
      bubbles: true,
      cancelable: true
    });

    const pasteHandled = !input.dispatchEvent(pasteEvent);
    if (!pasteHandled) {
      document.execCommand('insertText', false, text);
    }

    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));

    // Wait for UI to sync
    await new Promise(r => setTimeout(r, 800));

    // Click send
    const sendBtn = findElement(SELECTORS.sendButton);
    if (sendBtn) {
      sendBtn.click();
    } else {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
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

// ── Response Extraction ─────────────────────────────────────────────

/**
 * Start observing for Gemini's response.
 */
function startResponseObserver() {
  stopResponseObserver();
  lastResponseText = '';

  responseObserver = new MutationObserver((mutations) => {
    // Only process if a NEW response element has appeared
    const currentCount = getResponseCount();
    if (currentCount <= initialResponseCount) {
      return; // Still waiting for Gemini to start replying
    }

    const currentResponse = extractLatestResponse();

    if (currentResponse && currentResponse !== lastResponseText) {
      lastResponseText = currentResponse;

      clearTimeout(responseIdleTimer);
      responseIdleTimer = setTimeout(() => {
        onResponseComplete(currentResponse);
      }, RESPONSE_IDLE_TIMEOUT);
    }
  });

  responseObserver.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  setTimeout(() => {
    if (responseObserver) {
      stopResponseObserver();
      chrome.runtime.sendMessage({
        type: 'gemini_response',
        payload: {
          content: lastResponseText || '[No response received after 60s timeout]',
          complete: false,
          timedOut: true,
        },
      });
    }
  }, 60000);
}

function stopResponseObserver() {
  if (responseObserver) {
    responseObserver.disconnect();
    responseObserver = null;
  }
  clearTimeout(responseIdleTimer);
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

  // Preserve newlines for paragraphs and breaks
  clone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
  clone.querySelectorAll('p, div').forEach(p => p.append('\n\n'));
  
  // Preserve list items
  clone.querySelectorAll('li').forEach(li => {
    li.prepend('- ');
    li.append('\n');
  });

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
    },
  });
}

// ── Message Handler ─────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, payload } = message;

  switch (type) {
    case 'inject_prompt':
      injectPrompt(payload.prompt).then(success => {
        sendResponse({ success });
      });
      return true; // Async response

    case 'new_chat':
      // Navigate to new chat
      window.location.href = 'https://gemini.google.com/app';
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
console.log('[Gemini Agent] Content script loaded on:', window.location.href);

// Notify service worker that we're ready
chrome.runtime.sendMessage({
  type: 'content_script_ready',
  payload: {
    url: window.location.href,
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
