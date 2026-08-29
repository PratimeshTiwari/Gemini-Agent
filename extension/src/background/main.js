import { connectWebSocket } from './socket.js';
import { sendToServer } from './messaging.js';
import { getState } from './state.js';

// Open side panel on extension icon click
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

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
