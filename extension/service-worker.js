/**
 * Gemini Agent — Service Worker
 *
 * Background service worker that:
 * - Manages WebSocket connection to local agent server
 * - Routes messages between content script ↔ server ↔ side panel
 * - Auto-reconnects with exponential backoff
 * - Opens side panel on extension icon click
 */

// ── Constants ────────────────────────────────────────────────────────
const WS_URL = 'ws://localhost:7777';
const RECONNECT_BASE = 1000;
const RECONNECT_MAX = 30000;
const HEARTBEAT_INTERVAL = 10000;

// ── State (stored in chrome.storage.session) ─────────────────────────
// We never store state in global variables since SW is ephemeral.

/**
 * Get connection state from storage.
 */
async function getState() {
  const { agentState = {} } = await chrome.storage.session.get('agentState');
  return {
    connected: false,
    reconnectAttempts: 0,
    lastError: null,
    ...agentState,
  };
}

/**
 * Update connection state.
 */
async function setState(updates) {
  const current = await getState();
  await chrome.storage.session.set({
    agentState: { ...current, ...updates },
  });
}

// ── WebSocket Management ────────────────────────────────────────────
let ws = null;
let heartbeatTimer = null;
let reconnectTimer = null;

function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  try {
    ws = new WebSocket(WS_URL);

    ws.onopen = async () => {
      console.log('✅ Connected to agent server');
      await setState({ connected: true, reconnectAttempts: 0, lastError: null });

      // Identify ourselves as the extension
      ws.send(JSON.stringify({
        id: crypto.randomUUID(),
        type: 'identify',
        payload: { clientType: 'extension' },
        timestamp: Date.now(),
      }));

      // Broadcast tab status immediately on connection
      broadcastTabStatus();

      // Start heartbeat
      startHeartbeat();

      // Notify side panel
      broadcastToSidePanel({
        type: 'connection_status',
        payload: { connected: true },
      });
    };

    ws.onmessage = async (event) => {
      try {
        const message = JSON.parse(event.data);
        await handleServerMessage(message);
      } catch (err) {
        console.error('Failed to parse server message:', err);
      }
    };

    ws.onclose = async (event) => {
      console.log(`🔌 Disconnected from agent server (code: ${event.code})`);
      ws = null;
      stopHeartbeat();
      await setState({ connected: false });

      broadcastToSidePanel({
        type: 'connection_status',
        payload: { connected: false },
      });

      // Auto-reconnect
      if (event.code !== 1000) {
        scheduleReconnect();
      }
    };

    ws.onerror = async (err) => {
      console.error('WebSocket error:', err);
      await setState({ lastError: 'Connection failed' });
    };
  } catch (err) {
    console.error('Failed to create WebSocket:', err);
    scheduleReconnect();
  }
}

async function scheduleReconnect() {
  const state = await getState();
  const attempts = state.reconnectAttempts + 1;
  const delay = Math.min(RECONNECT_BASE * Math.pow(2, attempts - 1), RECONNECT_MAX);

  await setState({ reconnectAttempts: attempts });
  console.log(`🔄 Reconnecting in ${delay}ms (attempt ${attempts})...`);

  // Use chrome.alarms instead of setTimeout (SW may terminate)
  await chrome.alarms.create('reconnect', { delayInMinutes: delay / 60000 });
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        id: crypto.randomUUID(),
        type: 'heartbeat',
        payload: {},
        timestamp: Date.now(),
      }));
    }
    // Periodically update the server about active model tabs
    broadcastTabStatus();
  }, HEARTBEAT_INTERVAL);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// ── Message Routing ─────────────────────────────────────────────────

/**
 * Handle messages from the agent server.
 */
async function handleServerMessage(message) {
  const { type, payload } = message;

  switch (type) {
    case 'status':
      // Connection/status update — forward to side panel
      broadcastToSidePanel(message);
      break;

    case 'inject_prompt':
      // Server wants us to inject a prompt into a model tab
      await injectPromptIntoModel(payload);
      break;

    case 'new_chat':
      // Server wants us to start a new chat
      await triggerNewChatInModel(payload);
      break;

    case 'diff_request':
      // Server wants user to approve a diff
      broadcastToSidePanel(message);
      break;

    case 'agent_response':
    case 'tool_call':
    case 'tool_result':
    case 'diff_result':
    case 'diff_auto_applied':
    case 'error':
    case 'command_result':
      // Forward to side panel for display
      broadcastToSidePanel(message);
      break;

    case 'heartbeat_ack':
      // Server is alive, nothing to do
      break;

    default:
      console.log('Unknown server message type:', type);
      broadcastToSidePanel(message);
  }
}

const MODEL_URLS = {
  'gemini': 'https://gemini.google.com/*',
  'chatgpt': 'https://chatgpt.com/*',
  'claude': 'https://claude.ai/*'
};

/**
 * Check which model tabs are open and send the status to the server.
 */
async function broadcastTabStatus() {
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

/**
 * Content script paths for each model (used for re-injection).
 */
const MODEL_SCRIPTS = {
  'gemini': 'content-scripts/gemini-bridge.js',
  'chatgpt': 'content-scripts/chatgpt-bridge.js',
  'claude': 'content-scripts/claude-bridge.js',
};

/**
 * Try to send a message to a tab's content script.
 * If it fails, activate the tab, optionally re-inject the script, and retry.
 */
async function trySendToTab(tab, message, targetModel) {
  // Attempt 1: Direct send
  try {
    const response = await chrome.tabs.sendMessage(tab.id, message);
    if (response && response.success === false) {
      throw new Error(response.error || 'Content script reported failure');
    }
    return true;
  } catch (firstErr) {
    console.warn(`[Service Worker] First attempt failed for ${targetModel} tab ${tab.id}:`, firstErr.message);
  }

  // Attempt 2: Activate the tab (un-freezes Chrome's throttling) then retry
  try {
    await chrome.tabs.update(tab.id, { active: true });
    await new Promise(r => setTimeout(r, 800)); // Wait for tab to wake up

    const response = await chrome.tabs.sendMessage(tab.id, message);
    if (response && response.success === false) {
      throw new Error(response.error || 'Content script reported failure');
    }
    return true;
  } catch (secondErr) {
    console.warn(`[Service Worker] Second attempt (after activation) failed for ${targetModel} tab ${tab.id}:`, secondErr.message);
  }

  // Attempt 3: Re-inject the content script programmatically and retry
  const scriptPath = MODEL_SCRIPTS[targetModel];
  if (scriptPath) {
    try {
      console.log(`[Service Worker] Re-injecting ${scriptPath} into tab ${tab.id}`);
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: [scriptPath],
      });
      await new Promise(r => setTimeout(r, 1000)); // Wait for script to initialize

      const response = await chrome.tabs.sendMessage(tab.id, message);
      if (response && response.success === false) {
        throw new Error(response.error || 'Content script reported failure');
      }
      return true;
    } catch (thirdErr) {
      console.warn(`[Service Worker] Third attempt (after re-injection) failed for ${targetModel} tab ${tab.id}:`, thirdErr.message);
    }
  }

  return false;
}

/**
 * Inject a prompt into the specified model tab via content script.
 */
async function injectPromptIntoModel(payload) {
  const targetModel = payload.targetModel || 'gemini';
  const targetUrl = MODEL_URLS[targetModel];

  if (!targetUrl) {
    const errorMsg = { type: 'error', payload: { message: `❌ Unsupported model: ${targetModel}` } };
    broadcastToSidePanel(errorMsg);
    sendToServer(errorMsg);
    return;
  }

  // Find all tabs for the target model
  const tabs = await chrome.tabs.query({ url: targetUrl });

  if (tabs.length === 0) {
    const errorMsg = {
      type: 'error',
      payload: {
        message: `❌ No ${targetUrl.replace('https://', '').replace('/*', '')} tab found. Please open one and try again.`,
      },
    };
    broadcastToSidePanel(errorMsg);
    sendToServer(errorMsg);
    return;
  }

  let success = false;
  const message = { type: 'inject_prompt', payload };

  // Try sending to the most recently opened tab first
  for (let i = tabs.length - 1; i >= 0; i--) {
    success = await trySendToTab(tabs[i], message, targetModel);
    if (success) break;
  }

  if (!success) {
    console.error(`Failed to send to any ${targetModel} content script after all retries.`);
    
    const errorMsg = {
      type: 'error',
      payload: {
        message: `Failed to communicate with ${targetModel} tab after multiple retries. Please hard-refresh the tab (Cmd+Shift+R) and try again!`,
      },
    };
    
    broadcastToSidePanel(errorMsg);
    sendToServer(errorMsg);
  }
}

/**
 * Trigger a new chat in the specified model tab via content script.
 */
async function triggerNewChatInModel(payload) {
  const targetModel = payload.targetModel || 'gemini';
  const targetUrl = MODEL_URLS[targetModel];
  if (!targetUrl) return;

  const tabs = await chrome.tabs.query({ url: targetUrl });
  if (tabs.length === 0) return;

  for (let i = tabs.length - 1; i >= 0; i--) {
    try {
      await chrome.tabs.sendMessage(tabs[i].id, {
        type: 'new_chat',
        payload,
      });
      break; // Success
    } catch (err) {
      console.warn(`[Gemini Agent] Failed to send new_chat to ${targetModel} tab ${tabs[i].id}:`, err);
    }
  }
}

/**
 * Broadcast a message to the side panel.
 */
function broadcastToSidePanel(message) {
  chrome.runtime.sendMessage(message).catch(() => {
    // Side panel may not be open — that's ok
  });
}

/**
 * Send a message to the agent server via WebSocket.
 */
function sendToServer(message) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      ...message,
    }));
  } else {
    console.warn('Cannot send to server — not connected');
    broadcastToSidePanel({
      type: 'error',
      payload: { message: '❌ Not connected to agent server. Is it running?' },
    });
  }
}

// ── Event Listeners ─────────────────────────────────────────────────

// Open side panel on extension icon click
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// Handle messages from side panel and content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    const { type, payload } = message;

    switch (type) {
      case 'user_message':
        // User typed in side panel → forward to server
        sendToServer({ type: 'user_message', payload });
        sendResponse({ success: true });
        break;

      case 'slash_command':
        // Slash command from side panel → forward to server
        sendToServer({ type: 'slash_command', payload });
        sendResponse({ success: true });
        break;

      case 'diff_response':
        // User approved/rejected diff in side panel → forward to server
        sendToServer({ type: 'diff_response', payload });
        sendResponse({ success: true });
        break;

      case 'gemini_response':
        // Content script extracted Gemini's response → forward to server
        sendToServer({ type: 'gemini_response', payload });
        sendResponse({ success: true });
        break;

      case 'gemini_response_stream':
        // Content script sending partial/streaming response → forward to server
        sendToServer({ type: 'gemini_response_stream', payload });
        sendResponse({ success: true });
        break;

      case 'get_status':
        // Side panel requesting current status
        const state = await getState();
        sendResponse({ success: true, ...state });
        break;

      case 'connect':
        // Manual connect request
        connectWebSocket();
        sendResponse({ success: true });
        break;

      default:
        sendResponse({ success: false, error: 'Unknown message type' });
    }
  })();

  return true; // Keep channel open for async response
});

// Handle alarms (for reconnection)
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'reconnect') {
    connectWebSocket();
  }
});

// Connect on install/startup
chrome.runtime.onInstalled.addListener(() => {
  console.log('🤖 Gemini Agent extension installed');
  connectWebSocket();
});

chrome.runtime.onStartup.addListener(() => {
  connectWebSocket();
});

// Handle keep-alive connections from content script to prevent SW from sleeping
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'keepAlive') {
    // Keeping this port open prevents Chrome from terminating the service worker
    port.onDisconnect.addListener(() => {
      // Content script disconnected (tab closed or refreshed)
    });
  }
});

// Try to connect immediately
connectWebSocket();
