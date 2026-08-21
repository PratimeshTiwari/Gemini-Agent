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
      // Server wants us to inject a prompt into Gemini
      await injectPromptIntoGemini(payload);
      break;

    case 'new_chat':
      // Server wants us to start a new chat in Gemini
      await triggerNewChatInGemini(payload);
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

/**
 * Inject a prompt into the Gemini tab via content script.
 */
async function injectPromptIntoGemini(payload) {
  // Find all Gemini tabs
  const tabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });

  if (tabs.length === 0) {
    // No Gemini tab open — notify side panel
    const errorMsg = {
      type: 'error',
      payload: {
        message: '❌ No gemini.google.com tab found. Please open one and try again.',
      },
    };
    broadcastToSidePanel(errorMsg);
    sendToServer(errorMsg);
    return;
  }

  let success = false;
  let lastErr = null;

  // Try sending to the most recently opened tab first (usually at the end of the array)
  for (let i = tabs.length - 1; i >= 0; i--) {
    try {
      const response = await chrome.tabs.sendMessage(tabs[i].id, {
        type: 'inject_prompt',
        payload,
      });
      if (response && response.success === false) {
        throw new Error(response.error || 'Content script reported failure');
      }
      success = true;
      break; // It worked!
    } catch (err) {
      console.warn(`[Gemini Agent] Failed to send to tab ${tabs[i].id}:`, err);
      lastErr = err;
    }
  }

  // If ALL tabs failed to receive the message (e.g., they all need to be refreshed)
  if (!success) {
    console.error('Failed to send to any content script:', lastErr);
    
    const errorMsg = {
      type: 'error',
      payload: {
        message: `Failed to communicate with Gemini tab: ${lastErr?.message || 'Unknown error'}. Please refresh the Gemini tab in your browser!`,
      },
    };
    
    broadcastToSidePanel(errorMsg);
    sendToServer(errorMsg);
  }
}

/**
 * Trigger a new chat in the Gemini tab via content script.
 */
async function triggerNewChatInGemini(payload) {
  const tabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
  if (tabs.length === 0) return;

  for (let i = tabs.length - 1; i >= 0; i--) {
    try {
      await chrome.tabs.sendMessage(tabs[i].id, {
        type: 'new_chat',
        payload,
      });
      break; // Success
    } catch (err) {
      console.warn(`[Gemini Agent] Failed to send new_chat to tab ${tabs[i].id}:`, err);
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
