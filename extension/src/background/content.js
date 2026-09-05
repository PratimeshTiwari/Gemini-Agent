import { broadcastToSidePanel, sendToServer } from './messaging.js';
import { ws } from './socket.js';

const MODEL_URLS = {
  'gemini': 'https://gemini.google.com/*',
  'chatgpt': 'https://chatgpt.com/*',
  'claude': 'https://claude.ai/*'
};

const MODEL_SCRIPTS = {
  'gemini': 'content-scripts/gemini-bridge.js',
  'chatgpt': 'content-scripts/chatgpt-bridge.js',
  'claude': 'content-scripts/claude-bridge.js',
};

export async function broadcastTabStatus() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  
  const connectedModels = [];
  for (const [model, targetUrl] of Object.entries(MODEL_URLS)) {
    try {
      const tabs = await chrome.tabs.query({ url: targetUrl });
      if (tabs.length > 0) connectedModels.push(model);
    } catch (err) {
      console.warn(`Failed to query tabs for ${model}:`, err);
    }
  }

  sendToServer({
    type: 'tab_status',
    payload: { connectedModels },
  });
}

async function trySendToTab(tab, message, targetModel) {
  let originalActiveTabId = null;
  try {
    const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTabs.length > 0) originalActiveTabId = activeTabs[0].id;
    
    // Tab Wakeup Protocol: Briefly activate the target tab to bypass throttling
    if (tab.id !== originalActiveTabId) {
      await chrome.tabs.update(tab.id, { active: true });
      await new Promise(r => setTimeout(r, 250)); // Wait for Chrome to wake up the DOM
    }
  } catch (e) {
    console.warn('Failed to execute Tab Wakeup:', e);
  }

  let success = false;
  try {
    const response = await chrome.tabs.sendMessage(tab.id, message);
    if (response && response.success === false) throw new Error(response.error || 'Content script reported failure');
    success = true;
  } catch (firstErr) {
    console.warn(`[Service Worker] First attempt failed for ${targetModel} tab ${tab.id}:`, firstErr.message);
    
    const scriptPath = MODEL_SCRIPTS[targetModel];
    if (scriptPath) {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [scriptPath] });
        await new Promise(r => setTimeout(r, 1000));
        const response = await chrome.tabs.sendMessage(tab.id, message);
        if (response && response.success === false) throw new Error(response.error || 'Content script reported failure');
        success = true;
      } catch (secondErr) {
        console.warn(`[Service Worker] Second attempt failed for ${targetModel} tab ${tab.id}:`, secondErr.message);
      }
    }
  }

  // Keep the target model tab active to prevent Chrome from throttling background DOM operations

  return success;
}

export async function ensureModelTab(targetModel = 'gemini') {
  const targetUrl = MODEL_URLS[targetModel];
  if (!targetUrl) return null;

  const tabs = await chrome.tabs.query({ url: targetUrl });
  if (tabs.length > 0) {
    return tabs[tabs.length - 1];
  }

  // No tab found: automatically reopen in a new tab
  console.log(`[Gemini Agent] No ${targetModel} tab found. Auto-reopening in a new tab...`);
  const openUrl = targetModel === 'gemini' 
    ? 'https://gemini.google.com/app' 
    : (targetModel === 'chatgpt' ? 'https://chatgpt.com' : (targetModel === 'claude' ? 'https://claude.ai' : targetUrl.replace('/*', '')));

  const newTab = await chrome.tabs.create({ url: openUrl, active: true });

  // Wait for the new tab to complete loading
  await new Promise((resolve) => {
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }, 8000);

    function listener(tabId, changeInfo) {
      if (tabId === newTab.id && changeInfo.status === 'complete') {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });

  // Brief pause for the content script bridge to mount into the DOM
  await new Promise(r => setTimeout(r, 1500));
  broadcastTabStatus();
  return newTab;
}

export async function injectPromptIntoModel(payload) {
  const targetModel = payload.targetModel || 'gemini';
  const targetUrl = MODEL_URLS[targetModel];

  if (!targetUrl) {
    const errorMsg = { type: 'error', payload: { message: `❌ Unsupported model: ${targetModel}` } };
    broadcastToSidePanel(errorMsg);
    sendToServer(errorMsg);
    return;
  }

  const message = { type: 'inject_prompt', payload };
  let success = false;

  if (payload.isSubagent) {
    // Tab Pooling: Create a fresh isolated tab for this subagent
    const newTab = await chrome.tabs.create({ url: targetUrl.replace('/*', ''), active: false });
    // Wait for initial load
    await new Promise(r => setTimeout(r, 4000));
    success = await trySendToTab(newTab, message, targetModel);
  } else {
    // Primary Agent: Find existing tab or auto-reopen if none is found
    let tabs = await chrome.tabs.query({ url: targetUrl });
    if (tabs.length === 0) {
      console.log(`[Gemini Agent] No active ${targetModel} tab found. Auto-reopening...`);
      sendToServer({
        type: 'status',
        payload: { message: `🌐 Reopening ${targetModel} in a new tab...` }
      });
      const newTab = await ensureModelTab(targetModel);
      if (newTab) {
        tabs = [newTab];
      }
    }

    if (tabs.length === 0) {
      const errorMsg = {
        type: 'error',
        payload: { message: `❌ Failed to open ${targetModel} tab automatically. Please open https://gemini.google.com/app manually.` },
      };
      broadcastToSidePanel(errorMsg);
      sendToServer(errorMsg);
      return;
    }

    for (let i = tabs.length - 1; i >= 0; i--) {
      success = await trySendToTab(tabs[i], message, targetModel);
      if (success) break;
    }
  }

  if (!success) {
    const errorMsg = {
      type: 'error',
      payload: { message: `Failed to communicate with ${targetModel} tab after multiple retries. Please hard-refresh the tab (Cmd+Shift+R) and try again!` },
    };
    broadcastToSidePanel(errorMsg);
    sendToServer(errorMsg);
  }
}

export async function triggerNewChatInModel(payload) {
  const targetModel = payload.targetModel || 'gemini';
  const targetUrl = MODEL_URLS[targetModel];
  if (!targetUrl) return;

  let tabs = await chrome.tabs.query({ url: targetUrl });
  if (tabs.length === 0) {
    const newTab = await ensureModelTab(targetModel);
    if (newTab) tabs = [newTab];
  }
  if (tabs.length === 0) return;

  for (let i = tabs.length - 1; i >= 0; i--) {
    try {
      await chrome.tabs.sendMessage(tabs[i].id, { type: 'new_chat', payload });
      break;
    } catch (err) {
      console.warn(`[Gemini Agent] Failed to send new_chat to ${targetModel} tab ${tabs[i].id}:`, err);
    }
  }
}
