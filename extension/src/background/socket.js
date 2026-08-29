import { getState, setState } from './state.js';
import { broadcastToSidePanel, sendToServer } from './messaging.js';
import { injectPromptIntoModel, triggerNewChatInModel, broadcastTabStatus } from './content.js';

const WS_URL = 'ws://localhost:7777';
const RECONNECT_BASE = 1000;
const RECONNECT_MAX = 30000;
const HEARTBEAT_INTERVAL = 10000;

export let ws = null;
let heartbeatTimer = null;

export function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  try {
    ws = new WebSocket(WS_URL);

    ws.onopen = async () => {
      console.log('✅ Connected to agent server');
      await setState({ connected: true, reconnectAttempts: 0, lastError: null });

      ws.send(JSON.stringify({
        id: crypto.randomUUID(),
        type: 'identify',
        payload: { clientType: 'extension' },
        timestamp: Date.now(),
      }));

      broadcastTabStatus();
      startHeartbeat();

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
    broadcastTabStatus();
  }, HEARTBEAT_INTERVAL);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

async function handleServerMessage(message) {
  const { type, payload } = message;

  switch (type) {
    case 'status':
    case 'diff_request':
    case 'agent_response':
    case 'tool_call':
    case 'tool_result':
    case 'diff_result':
    case 'diff_auto_applied':
    case 'error':
    case 'command_result':
    case 'github_notification':
    case 'github_plan_generated':
      broadcastToSidePanel(message);
      break;
    case 'inject_prompt':
      await injectPromptIntoModel(payload);
      break;
    case 'new_chat':
      await triggerNewChatInModel(payload);
      break;
    case 'heartbeat_ack':
      break;
    default:
      console.log('Unknown server message type:', type);
      broadcastToSidePanel(message);
  }
}
