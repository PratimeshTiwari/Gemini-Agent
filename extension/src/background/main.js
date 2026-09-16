import { connectWebSocket, isSocketOpen } from './socket.js';
import { sendToServer } from './messaging.js';
import { getState } from './state.js';
import { broadcastTabStatus, reinjectModelTabs, restoreFocusFrom, forgetTab, endSession } from './content.js';

// Open side panel on extension icon click
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// Listen for tab removals / updates to keep server informed of active tabs
chrome.tabs.onRemoved.addListener((tabId) => {
  // Any tab, not just ones we opened: a main tab the user closes by hand must
  // stop being remembered, or the next turn sends into a tab that is gone and
  // reports the site as unreachable.
  forgetTab(tabId);
  broadcastTabStatus();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && (tab.url.includes('gemini.google.com') || tab.url.includes('chatgpt.com'))) {
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
          // A turn is over when the reply is complete *or* when it gave up. The
          // close used to run only on `complete`, so a timed-out subagent left
          // its tab open — and `runHeadlessTask` runs up to ten turns.
          const finished = payload.complete || payload.timedOut;

          if (finished) {
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
      case 'question_response':
      case 'command_approval_response':
      case 'turn_trace':
      case 'github_pr_comment':
      case 'github_pr_viewing':
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

      case 'connect':
        connectWebSocket();
        sendResponse({ success: true });
        break;

      default:
        sendResponse({ success: false, error: 'Unknown message type' });
    }
  })();
  return true;
});

// Handle alarms (for reconnection)
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'reconnect') connectWebSocket();
});

// Connect on install/startup
chrome.runtime.onInstalled.addListener(() => {
  console.log('🤖 Agent CLI extension installed');
  connectWebSocket();
});

chrome.runtime.onStartup.addListener(() => {
  connectWebSocket();
});

// Handle keep-alive connections
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'keepAlive') {
    port.onDisconnect.addListener(() => {});
  }
});

// Try to connect immediately
connectWebSocket();

// And repair any tab whose content script this worker's start just orphaned.
// See reinjectModelTabs: without it, a reload of the extension leaves open
// Gemini tabs looking healthy while every reply is silently dropped.
reinjectModelTabs();
