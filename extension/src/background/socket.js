import { getState, setState } from './state.js';
import { retryDelay, resolvePort, socketUrlFor } from './policy.js';
import { broadcastToSidePanel, sendToServer } from './messaging.js';
import { injectPromptIntoModel, triggerNewChatInModel, broadcastTabStatus, sendToModelTab, endSession, openThread, focusModelTab } from './content.js';

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

// The ladder, the floor it must stay under, and the port rules live in
// `policy.js` — they are arithmetic and validation, and keeping them there is
// what lets `node --test` cover the decisions this file has always got wrong.

/**
 * Chrome terminates an idle service worker after ~30s. Any extension API call
 * resets that timer, so one cheap call on an interval keeps the worker resident
 * — but only while there is nothing to connect to, and never once connected,
 * where WebSocket traffic and the heartbeat already do it.
 */
const KEEPALIVE_MS = 20000;

/**
 * The backstop for the case this file cannot cover: the worker dies anyway.
 *
 * **It is armed while connected too, and that is the whole point.** It used to
 * be created in `scheduleRetry` and cleared in `stopKeepAlive`, which runs on
 * `onopen` — so a healthy bridge had no alarm at all. Chrome can still evict a
 * service worker that believes it is connected, and when it does the socket
 * dies with it, `onclose` never runs inside a worker that is already gone, and
 * there is no timer and no alarm left to notice. Nothing can push at a dead
 * worker from outside: the agent cannot wake it.
 *
 * What actually revived it was incidental — `chrome.tabs.onUpdated` firing
 * because the user came back and focused a tab. That is exactly the reported
 * symptom: "the prompt only sends once I open Chrome or the Gemini tab". The
 * prompt was not slow, the extension was not running, and the thing that
 * brought it back was the user's own navigation.
 *
 * So the alarm is periodic and permanent. While connected it costs nothing —
 * the worker is already resident on the heartbeat — and it is the only thing
 * that can resurrect a worker Chrome has silently collected.
 */
const ALARM_FALLBACK_MINUTES = 0.5; // the clamp floor; asking for less is ignored
const WATCHDOG_ALARM = 'reconnect';

const HEARTBEAT_INTERVAL = 10000;

export let ws = null;

/**
 * Is the socket open *right now*?
 *
 * The stored state is a record of the last transition, and a panel that opens
 * between transitions reads whatever was written last — or, if the service
 * worker has been recycled and `getState` falls back to its defaults,
 * `connected: false` while the bridge is perfectly fine. That is what "the
 * floating window says Disconnected while the docked one says Connected" was:
 * two surfaces asking two different questions.
 *
 * The socket itself cannot be stale, so it is the one worth asking.
 */
export const isSocketOpen = () => Boolean(ws) && ws.readyState === WebSocket.OPEN;
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
    return resolvePort(agentPort);
  } catch {
    return resolvePort(undefined);
  }
}

/** 127.0.0.1, not `localhost`: it says what it means and skips the hosts file. */
async function socketUrl() {
  return socketUrlFor(await getPort());
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
    ensureWatchdogAlarm();        // but the worker can still be evicted; see above
    await setState({ connected: true, reconnectAttempts: 0, lastError: null });

    ws.send(JSON.stringify({
      id: crypto.randomUUID(),
      type: 'identify',
      /*
       * The build Chrome actually has, from the manifest it actually loaded.
       *
       * Reported from use, 2026-09-24: `chrome://extensions` said 1.25.0 while
       * the loaded copy still had `github.com/*` site access — a permission
       * removed on 2026-09-19. So the version badge was a number someone had
       * typed, not evidence, and a day went into diagnosing selector failures
       * that were really a stale load.
       *
       * `getManifest()` cannot lie the same way: it is read out of the bundle
       * Chrome is running. The server compares it with the source tree it was
       * started from and says so when they differ.
       */
      payload: {
        clientType: 'extension',
        version: chrome.runtime.getManifest().version,
      },
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
  const delay = retryDelay(attempt);
  attempt++;

  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => connectWebSocket(), delay);

  startKeepAlive();
  ensureWatchdogAlarm();
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
  // The watchdog alarm is deliberately *not* cleared here. Being connected is
  // not evidence the worker will stay alive, and this function runs on `onopen`
  // — clearing it here is what left a healthy bridge with no way back.
}

/**
 * Arm the periodic watchdog, if it is not already armed.
 *
 * `chrome.alarms.create` with an existing name replaces the alarm and restarts
 * its period, so re-arming on every retry would push the backstop further away
 * each time it is needed most. Checking first keeps the cadence honest.
 */
export async function ensureWatchdogAlarm() {
  try {
    const existing = await chrome.alarms.get(WATCHDOG_ALARM);
    if (existing) return;
    chrome.alarms.create(WATCHDOG_ALARM, {
      delayInMinutes: ALARM_FALLBACK_MINUTES,
      periodInMinutes: ALARM_FALLBACK_MINUTES,
    });
  } catch {
    // Alarms unavailable is not a reason to fail a connection attempt.
  }
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
      broadcastToSidePanel(message);
      break;
    case 'inject_prompt':
      await injectPromptIntoModel(payload);
      break;
    case 'new_chat': {
      // Acked, like `open_thread` below. `/compact` is a handover and cannot
      // send the summary until it knows there is somewhere new to send it to.
      const started = await triggerNewChatInModel(payload || {});
      sendToServer({ type: 'chat_started', payload: { ok: started, requestId: payload?.requestId } });
      break;
    }

    // Resuming a past conversation: point the tab at it, so the model has the
    // history itself rather than a paraphrase of it.
    case 'open_thread': {
      const opened = await openThread(payload?.thread);
      sendToServer({ type: 'thread_opened', payload: { ok: opened, thread: payload?.thread } });
      break;
    }
    case 'end_session':
      // A batch task is over, so the tab it was holding can go. Closing it here
      // rather than when a turn completes is the whole point of a session: the
      // next turn has to find the thread still there.
      await endSession(payload?.sessionId);
      break;
    case 'focus_tab':
      await focusModelTab(payload?.targetModel);
      break;

    case 'discover_models':
    case 'switch_model':
      // Straight to the model tab. Neither injects a prompt, so neither goes
      // through the extension lock — reading the picker is not a turn.
      //
      // `sessionId` is carried through so a batch task changes effort in its
      // own tab. Without it this was always the main lane, which means the
      // user's tab: a background job raising its own effort would have changed
      // the model the person was mid-conversation with.
      await sendToModelTab({ type, payload }, payload?.targetModel || 'gemini', payload?.sessionId || null);
      break;
    case 'heartbeat_ack':
      break;
    default:
      broadcastToSidePanel(message);
  }
}
