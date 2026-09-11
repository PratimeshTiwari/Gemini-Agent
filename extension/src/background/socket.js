import { getState, setState } from './state.js';
import { broadcastToSidePanel, sendToServer } from './messaging.js';
import { injectPromptIntoModel, triggerNewChatInModel, broadcastTabStatus } from './content.js';

/**
 * The socket to the local agent, and the retry policy around it.
 *
 * The retry policy is the interesting half, because the obvious version of it
 * does not work under MV3 and the symptom is "the extension takes half a minute
 * to notice the agent is running".
 *
 * It used to compute an exponential backoff — 1s, 2s, 4s, 8s, 16s, capped at
 * RECONNECT_MAX = 30000 — and hand the result to `chrome.alarms`. Alarms clamp
 * to a **30-second floor**, and that cap was exactly the floor, so the whole
 * ladder collapsed to a constant: every retry was 30 seconds and the arithmetic
 * above it did nothing. Measured with the real extension in headless Chrome,
 * timing `listening` → `identify`: **13.6s** with Chrome already running, 25.6s
 * on a cold start, and in both cases the server saw exactly **one** handshake.
 * The extension was not retrying and failing, it was not trying.
 *
 * Two things fix it, and under MV3 they are one problem:
 *
 *  - Retry on `setTimeout` while the worker is alive. Alarms are for long gaps.
 *  - Keep the worker alive while disconnected. A pending `setTimeout` does not
 *    stop Chrome terminating an idle worker, and a timer inside a dead worker
 *    never fires — so a fast ladder without this is a fast ladder that gets
 *    killed after the first rung.
 *
 * Nothing can push at the worker from outside: the agent cannot wake it. So the
 * extension has to be the thing still looking, which is why being resident
 * *while disconnected* is the point, and why it stops the moment a socket opens.
 */

const DEFAULT_PORT = 7777;

/** How long to wait before each successive attempt, then this cadence forever. */
const RETRY_LADDER_MS = [250, 500, 1000, 2000, 4000, 8000];
const RETRY_STEADY_MS = 5000;

/**
 * Chrome terminates an idle service worker after ~30s. Any extension API call
 * resets that timer, so one cheap call on an interval keeps the worker resident
 * — but only while there is nothing to connect to, and never once connected,
 * where WebSocket traffic and the heartbeat already do it.
 */
const KEEPALIVE_MS = 20000;

/** The backstop for the case this file cannot cover: the worker dies anyway. */
const ALARM_FALLBACK_MINUTES = 0.5; // the clamp floor; asking for less is ignored

const HEARTBEAT_INTERVAL = 10000;

export let ws = null;
let heartbeatTimer = null;
let retryTimer = null;
let keepAliveTimer = null;
let attempt = 0;

/**
 * The agent's port. `--port` is a documented server flag, so this cannot be a
 * constant — but it also cannot be discovered, so it is a setting with the
 * default the server also uses.
 */
async function getPort() {
  try {
    const { agentPort } = await chrome.storage.local.get('agentPort');
    const n = parseInt(agentPort, 10);
    return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_PORT;
  } catch {
    return DEFAULT_PORT;
  }
}

/** 127.0.0.1, not `localhost`: it says what it means and skips the hosts file. */
async function socketUrl() {
  return `ws://127.0.0.1:${await getPort()}`;
}

export async function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  clearTimeout(retryTimer);
  retryTimer = null;

  let url;
  try {
    url = await socketUrl();
    ws = new WebSocket(url);
  } catch (err) {
    console.warn('[socket] could not open', url, err?.message);
    scheduleRetry();
    return;
  }

  ws.onopen = async () => {
    attempt = 0;
    stopKeepAlive();              // connected: the heartbeat keeps the worker up
    await setState({ connected: true, reconnectAttempts: 0, lastError: null });

    ws.send(JSON.stringify({
      id: crypto.randomUUID(),
      type: 'identify',
      payload: { clientType: 'extension' },
      timestamp: Date.now(),
    }));

    broadcastTabStatus();
    startHeartbeat();
    broadcastToSidePanel({ type: 'connection_status', payload: { connected: true } });
  };

  ws.onmessage = async (event) => {
    try {
      await handleServerMessage(JSON.parse(event.data));
    } catch (err) {
      console.warn('[socket] unparseable server message:', err?.message);
    }
  };

  ws.onclose = async (event) => {
    ws = null;
    stopHeartbeat();
    await setState({ connected: false });
    broadcastToSidePanel({ type: 'connection_status', payload: { connected: false } });
    // 1000 is a deliberate close from the other end; everything else is the
    // agent not being there yet, which is the ordinary case at startup.
    if (event.code !== 1000) scheduleRetry();
  };

  ws.onerror = async () => {
    // `onclose` always follows, and that is where the retry is scheduled — doing
    // it here too would double the ladder.
    await setState({ lastError: 'Connection failed' });
  };
}

/**
 * Try again soon, and stay alive long enough to do it.
 *
 * The alarm is armed alongside the timer rather than instead of it: if Chrome
 * kills the worker despite the keepalive, the timer dies with it and the alarm
 * is the only thing left that can bring it back.
 */
function scheduleRetry() {
  const delay = RETRY_LADDER_MS[attempt] ?? RETRY_STEADY_MS;
  attempt++;

  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => connectWebSocket(), delay);

  startKeepAlive();
  chrome.alarms.create('reconnect', { delayInMinutes: ALARM_FALLBACK_MINUTES });
  setState({ reconnectAttempts: attempt }).catch(() => {});
}

function startKeepAlive() {
  if (keepAliveTimer) return;
  const ping = () => chrome.runtime.getPlatformInfo().catch(() => {});
  ping();                       // immediately, not one interval from now
  keepAliveTimer = setInterval(() => {
    // Any extension API call resets the worker's idle timer. This is the
    // cheapest one that does not touch tabs, storage or the network.
    ping();
  }, KEEPALIVE_MS);
}

function stopKeepAlive() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
  chrome.alarms.clear('reconnect').catch(() => {});
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
      broadcastToSidePanel(message);
  }
}
