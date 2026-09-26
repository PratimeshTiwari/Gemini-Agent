import { connectWebSocket, isSocketOpen, ensureWatchdogAlarm } from './socket.js';
import { sendToServer } from './messaging.js';
import { getState } from './state.js';
import { broadcastTabStatus, reinjectModelTabs, restoreFocusFrom, forgetTab, endSession, stopCompletionTicks } from './content.js';

// The toolbar icon opens the popup declared in the manifest, so the
// open-on-click behaviour this used to set is now ignored by Chrome — a popup
// and a panel cannot both own the same click. The side panel is still reachable
// from `⊟` inside the popup, which is the trade this makes: one click to a
// panel that drops down where you are looking, one more if you want it docked.
//
// The three surfaces are one page. Chrome closes a popup whenever it loses
// focus, which is fine for a question and wrong for watching a long turn, so
// the popup is the doorway and the panel or the window is where you stay.

// Listen for tab removals / updates to keep server informed of active tabs
chrome.tabs.onRemoved.addListener((tabId) => {
  // Any tab, not just ones we opened: a main tab the user closes by hand must
  // stop being remembered, or the next turn sends into a tab that is gone and
  // reports the site as unreachable.
  forgetTab(tabId);
  broadcastTabStatus();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && tab.url.includes('gemini.google.com')) {
    broadcastTabStatus();
  }
});

// Handle messages from side panel and content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    const { type, payload } = message;

    switch (type) {
      case 'user_message':
      case 'slash_command':
      case 'diff_response':
      case 'gemini_response':
      case 'gemini_response_stream':
        if (type === 'gemini_response' && sender.tab) {
          // Which conversation answered. Gemini puts the thread id in the URL
          // (`/app/<id>`), and that is the only way to tell later whether the
          // model still *remembers* a session or has to be told what happened.
          // Attached for every reply, not just a subagent's, because the main
          // lane is the one whose sessions get resumed.
          payload.tabUrl = sender.tab.url;

          // A turn is over when the reply is complete *or* when it gave up. The
          // close used to run only on `complete`, so a timed-out subagent left
          // its tab open — and `runHeadlessTask` runs up to ten turns.
          const finished = payload.complete || payload.timedOut;

          if (finished) {
            // Nothing left to check in that tab.
            stopCompletionTicks(sender.tab.id);
            // Before the close, not after: once the tab is gone Chrome has
            // already picked a new active tab, and the "do we still hold focus"
            // check can no longer tell whether the user had moved on.
            await restoreFocusFrom(sender.tab.id);
          }

          if (finished && payload.isSubagent) {
            if (payload.complete) payload.subagentUrl = sender.tab.url;
            // A tab held for a *batch session* outlives the turn: the whole
            // point is that the next turn finds the thread still there. It is
            // closed by an explicit end_session when the task is over.
            if (!payload.sessionId) {
              forgetTab(sender.tab.id);
              chrome.tabs.remove(sender.tab.id)
                .catch(err => console.warn('Failed to auto-close subagent tab:', err));
            }
          }
        }
        sendToServer({ type, payload });
        sendResponse({ success: true });
        break;

      // The panel unblocking a turn that is parked on a question or a command
      // approval. Pure relay — the server owns both resolvers.
      case 'get_history':
      case 'list_sessions':
      case 'resume_session':
      case 'pick_workspace':
      case 'set_workspace':
      case 'question_response':
      case 'command_approval_response':
      case 'turn_trace':
      /*
       * The three below are what a **content script** reports, and their
       * absence here is the whole of "the model never switches".
       *
       * `readModelOptions` works — measured against the live page at 27.7ms,
       * returning every option with `selected` correct. It hands the list to
       * `safeSend`, which is `chrome.runtime.sendMessage`, which arrives *here*
       * — and `model_options` was not a case, so it fell to `default` and was
       * dropped one hop before the socket. The server waited out every budget
       * it had and reported, accurately, that nothing came back.
       *
       * `gemini_response` is in this list, which is exactly why prompts worked
       * while `/effort`, `ctrl+b` and the mismatch warning did not: one path
       * was relayed and the other was not.
       *
       * CLAUDE.md states the rule this broke, about the side panel: "a surface
       * that ignores an unknown message type is not equally harmless for every
       * type. Dropping a notification costs a missing line; dropping a request
       * deadlocks whatever is waiting on the answer." The same sentence applies
       * to the worker, and nothing was checking.
       */
      case 'model_options':
      case 'error':
        sendToServer({ type, payload });
        sendResponse({ success: true });
        break;

      case 'get_status': {
        // The live socket overrides the stored flag. Stored state records the
        // last transition; a panel opening between transitions — or after the
        // service worker was recycled, when `getState` falls back to its
        // `connected: false` default — would otherwise report Disconnected
        // over a working bridge.
        const state = await getState();
        sendResponse({ success: true, ...state, connected: isSocketOpen() });
        break;
      }

      /*
       * Absorbed, not relayed: the bridge announcing itself is news for the
       * worker and means nothing to the agent.
       *
       * It still needs a case. Without one it reaches `default`, which now
       * reports an unrelayed message — so a page-load announcement would file
       * an error row every time a Gemini tab opened. Found by the drift test
       * added alongside this fix, which is the second thing that test caught
       * before it had finished being written.
       */
      case 'content_script_ready':
        sendResponse({ success: true });
        break;

      case 'connect':
        // The reply carries the state so a model tab can back its nudge off.
        // Reported before the attempt, not after: `connectWebSocket` resolves
        // long before a socket is open, and answering "connected" here would
        // slow the nudge down at exactly the moment it is doing its job.
        sendResponse({ success: true, connected: isSocketOpen() });
        connectWebSocket();
        break;

      default:
        /*
         * Never silently again.
         *
         * This arm dropped `model_options` for the entire life of the picker
         * feature, and it cost five releases of fixes aimed at every hop except
         * this one. It answered the *sender* — a content script that ignores
         * the reply — and told the server nothing, so the message vanished
         * between two processes with no trace in either.
         *
         * A console line is not enough on its own, because MV3 evicts this
         * worker constantly and takes its console with it. The server is told,
         * so it lands in `/logs extension` and survives.
         */
        console.warn('[Agent CLI] worker has no relay for message type:', type);
        sendToServer({
          type: 'error',
          payload: {
            op: 'unrelayed_message',
            message: `The extension received "${type}" from a content script and `
              + 'has no rule for it, so it was dropped before reaching the agent.',
          },
        });
        sendResponse({ success: false, error: 'Unknown message type' });
    }
  })();
  return true;
});

/**
 * The periodic watchdog firing.
 *
 * This listener is registered at the top level, which is what lets Chrome
 * *start a terminated worker* to deliver the alarm. That is the only reason
 * the alarm exists: a worker Chrome has evicted cannot reconnect itself, and
 * nothing outside the browser can reach in and wake it.
 *
 * `connectWebSocket` early-returns when the socket is already OPEN or
 * CONNECTING, so firing every 30s on a healthy bridge costs one function call.
 */
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'reconnect') return;
  if (isSocketOpen()) return;
  connectWebSocket();
});

// Connect on install/startup
chrome.runtime.onInstalled.addListener(() => {
  console.log('🤖 Agent CLI extension installed');
  ensureWatchdogAlarm();
  connectWebSocket();
});

chrome.runtime.onStartup.addListener(() => {
  ensureWatchdogAlarm();
  connectWebSocket();
});

// Handle keep-alive connections
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'keepAlive') {
    port.onDisconnect.addListener(() => {});
  }
});

// Try to connect immediately, and make sure the backstop is armed. Both run on
// every worker start, including the ones Chrome performs to deliver an event —
// so a worker that was evicted mid-session re-arms itself on the way back up.
ensureWatchdogAlarm();
connectWebSocket();

// And repair any tab whose content script this worker's start just orphaned.
// See reinjectModelTabs: without it, a reload of the extension leaves open
// Gemini tabs looking healthy while every reply is silently dropped.
reinjectModelTabs();
