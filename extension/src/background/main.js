import { connectWebSocket } from './socket.js';
import { sendToServer } from './messaging.js';
import { getState } from './state.js';
import { broadcastTabStatus } from './content.js';

// Open side panel on extension icon click
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// Listen for tab removals / updates to keep server informed of active tabs
chrome.tabs.onRemoved.addListener(() => {
  broadcastTabStatus();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && (tab.url.includes('gemini.google.com') || tab.url.includes('chatgpt.com') || tab.url.includes('claude.ai'))) {
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
        if (type === 'gemini_response' && payload.complete && payload.isSubagent && sender.tab) {
          payload.subagentUrl = sender.tab.url;
          chrome.tabs.remove(sender.tab.id).catch(err => console.warn('Failed to auto-close subagent tab:', err));
        }
        sendToServer({ type, payload });
        sendResponse({ success: true });
        break;

      case 'github_pr_comment':
      case 'github_pr_viewing':
        sendToServer({ type, payload });
        sendResponse({ success: true });
        break;

      case 'get_status':
        const state = await getState();
        sendResponse({ success: true, ...state });
        break;

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
  console.log('🤖 Gemini Agent extension installed');
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
