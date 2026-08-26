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
const RESPONSE_IDLE_TIMEOUT = 15000; // 15s of no new text = response complete
const RESPONSE_ACTIVITY_TIMEOUT = 60000; // 60s of no new text during streaming = consider done
const RESPONSE_MAX_TIMEOUT = 300000; // 5 min absolute max (safety net)
const RECONNECT_BASE = 1000;

// ── Anti-Throttling Hack ─────────────────────────────────────────────
// Chrome drastically throttles setTimeout and requestAnimationFrame in background tabs.
// Playing a silent looping audio element forces Chrome to keep the tab fully active.
function enableAntiThrottling() {
  if (window._antiThrottlingEnabled) return;
  window._antiThrottlingEnabled = true;

  const audio = document.createElement('audio');
  // 1-second silent WAV base64
  audio.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
  audio.loop = true;
  audio.volume = 0.01;
  
  const playAudio = () => {
    audio.play().catch(err => console.log('Anti-throttling audio play blocked by autoplay policy.', err));
  };

  // Attempt to play on any user interaction, just in case
  document.addEventListener('click', playAudio, { once: true });
  document.addEventListener('keydown', playAudio, { once: true });
  
  // Attempt to play immediately (sometimes works if tab has high engagement index)
  playAudio();
}
enableAntiThrottling();

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
    const sendBtn = await waitForSendButton(input, 30000);

    if (sendBtn === 'submitted') {
      console.log('[Gemini Bridge] Proceeding since prompt was manually submitted.');
    } else if (sendBtn) {
      sendBtn.click();
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
        throw new Error("Failed to submit prompt: Send button never became active (Image upload might be stuck).");
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
function waitForSendButton(input, maxWait = 30000) {
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
  lastActivityTime = Date.now();

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

  // Activity checker: runs every 2s to dynamically detect completion
  // We add an initial delay of 3 seconds before checking for the stop button,
  // because the stop button takes a moment to appear after clicking send.
  activityCheckTimer = setInterval(() => {
    const now = Date.now();
    const totalElapsed = now - responseStartTime;
    const silenceDuration = now - lastActivityTime;

    // Do not check for completion in the first 3 seconds to allow the DOM to update
    if (totalElapsed < 3000) return;

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

    // If Gemini has stopped generating (no stop button) AND we have some text, it's done!
    // We add a tiny 1-second silence buffer to ensure the DOM is fully settled.
    if (!isGenerating && lastResponseText && silenceDuration >= 1000) {
      console.log('[Gemini Bridge] Generation finished (Stop button disappeared + 1s settled)');
      clearInterval(streamingUpdateTimer);
      onResponseComplete(lastResponseText);
      return;
    }

    // Absolute max timeout (5 minutes)
    if (totalElapsed >= RESPONSE_MAX_TIMEOUT) {
      console.warn('[Gemini Bridge] Absolute max timeout reached (5 min)');
      clearInterval(streamingUpdateTimer);
      stopResponseObserver();
      chrome.runtime.sendMessage({
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

  // Preserve newlines for block elements (only direct leaf blocks to avoid nested multiplication)
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

  // Replace multiple consecutive newlines (3 or more) with just 2 newlines to avoid huge gaps
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
