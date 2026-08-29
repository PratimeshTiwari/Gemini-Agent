import { ws } from './socket.js';

export function broadcastToSidePanel(message) {
  chrome.runtime.sendMessage(message).catch(() => {
    // Side panel may not be open — that's ok
  });
}

export function sendToServer(message) {
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
