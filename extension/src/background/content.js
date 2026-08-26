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
  try {
    const response = await chrome.tabs.sendMessage(tab.id, message);
    if (response && response.success === false) throw new Error(response.error || 'Content script reported failure');
    return true;
  } catch (firstErr) {
    console.warn(`[Service Worker] First attempt failed for ${targetModel} tab ${tab.id}:`, firstErr.message);
  }

  try {
    await chrome.tabs.update(tab.id, { active: true });
    await new Promise(r => setTimeout(r, 800));
    const response = await chrome.tabs.sendMessage(tab.id, message);
    if (response && response.success === false) throw new Error(response.error || 'Content script reported failure');
    return true;
  } catch (secondErr) {
    console.warn(`[Service Worker] Second attempt failed for ${targetModel} tab ${tab.id}:`, secondErr.message);
  }

  const scriptPath = MODEL_SCRIPTS[targetModel];
  if (scriptPath) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [scriptPath] });
      await new Promise(r => setTimeout(r, 1000));
      const response = await chrome.tabs.sendMessage(tab.id, message);
      if (response && response.success === false) throw new Error(response.error || 'Content script reported failure');
      return true;
    } catch (thirdErr) {
      console.warn(`[Service Worker] Third attempt failed for ${targetModel} tab ${tab.id}:`, thirdErr.message);
    }
  }

  return false;
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

  const tabs = await chrome.tabs.query({ url: targetUrl });

  if (tabs.length === 0) {
    const errorMsg = {
      type: 'error',
      payload: { message: `❌ No ${targetUrl.replace('https://', '').replace('/*', '')} tab found. Please open one and try again.` },
    };
    broadcastToSidePanel(errorMsg);
    sendToServer(errorMsg);
    return;
  }

  let success = false;
  const message = { type: 'inject_prompt', payload };

  for (let i = tabs.length - 1; i >= 0; i--) {
    success = await trySendToTab(tabs[i], message, targetModel);
    if (success) break;
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

  const tabs = await chrome.tabs.query({ url: targetUrl });
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
