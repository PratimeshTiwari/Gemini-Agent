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
      throw new Error('Could not find ChatGPT input field');
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

      // Strip image data
      const imgRegex = /<image_data>\n(data:image\/[^;]+;base64,[^\n]+)\n<\/image_data>/;
      text = text.replace(imgRegex, '').trim();

      dataTransfer.setData('text/plain', text);
      const pasteEvent = new ClipboardEvent('paste', {
        clipboardData: dataTransfer,
        bubbles: true,
        cancelable: true,
      });

      const pasteHandled = !input.dispatchEvent(pasteEvent);
      if (!pasteHandled && text) {
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
        throw new Error("Failed to submit prompt: Send button never became active.");
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
            chrome.runtime.sendMessage({
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
 * Extract clean text content from an element, preserving code blocks and basic formatting.
 */
function extractTextContent(element) {
  if (!element) return '';

  const clone = element.cloneNode(true);

  // Replace code blocks with fenced blocks
  clone.querySelectorAll('pre code, code-block').forEach(codeBlock => {
    const lang = codeBlock.getAttribute('data-language') ||
                 codeBlock.className.match(/language-(\w+)/)?.[1] || '';
    const code = codeBlock.textContent;
    const replacement = document.createTextNode(`\n\`\`\`${lang}\n${code}\n\`\`\`\n`);
    codeBlock.parentElement.replaceWith(replacement);
  });

  clone.querySelectorAll('code').forEach(code => {
    const replacement = document.createTextNode(`\`${code.textContent}\``);
    code.replaceWith(replacement);
  });

  clone.querySelectorAll('strong, b').forEach(el => {
    el.replaceWith(document.createTextNode(`**${el.textContent}**`));
  });

  clone.querySelectorAll('em, i').forEach(el => {
    el.replaceWith(document.createTextNode(`*${el.textContent}*`));
  });

  clone.querySelectorAll('a').forEach(el => {
    const href = el.getAttribute('href') || '';
    el.replaceWith(document.createTextNode(`[${el.textContent}](${href})`));
  });

  clone.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(el => {
    const level = parseInt(el.tagName.substring(1), 10);
    const hashes = '#'.repeat(level);
    el.replaceWith(document.createTextNode(`\n${hashes} ${el.textContent}\n`));
  });

  clone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
  clone.querySelectorAll('p').forEach(p => p.append('\n\n'));
  
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
chrome.runtime.sendMessage({
  type: 'content_script_ready',
  payload: {
    url: window.location.href,
    model: 'chatgpt',
    timestamp: Date.now(),
  },
}).catch(() => {
  // Service worker may not be ready yet
});

// Keep the service worker alive
let keepAlivePort = null;
function connectToServiceWorker() {
  try {
    keepAlivePort = chrome.runtime.connect({ name: 'keepAlive' });
    keepAlivePort.onDisconnect.addListener(() => {
      setTimeout(connectToServiceWorker, 1000);
    });
  } catch (err) {
    // Context invalidated
  }
}
connectToServiceWorker();
