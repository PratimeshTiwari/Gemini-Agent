(() => {
  // src/background/state.js
  async function getState() {
    const { agentState = {} } = await chrome.storage.session.get("agentState");
    return {
      connected: false,
      reconnectAttempts: 0,
      lastError: null,
      ...agentState
    };
  }
  async function setState(updates) {
    const current = await getState();
    await chrome.storage.session.set({
      agentState: { ...current, ...updates }
    });
  }

  // src/background/messaging.js
  function broadcastToSidePanel(message) {
    chrome.runtime.sendMessage(message).catch(() => {
    });
  }
  function sendToServer(message) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        ...message
      }));
    } else {
      console.warn("Cannot send to server \u2014 not connected");
      broadcastToSidePanel({
        type: "error",
        payload: { message: "\u274C Not connected to agent server. Is it running?" }
      });
    }
  }

  // src/background/content.js
  var MODEL_URLS = {
    "gemini": "https://gemini.google.com/*",
    "chatgpt": "https://chatgpt.com/*",
    "claude": "https://claude.ai/*"
  };
  var MODEL_SCRIPTS = {
    "gemini": "content-scripts/gemini-bridge.js",
    "chatgpt": "content-scripts/chatgpt-bridge.js",
    "claude": "content-scripts/claude-bridge.js"
  };
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
      type: "tab_status",
      payload: { connectedModels }
    });
  }
  async function trySendToTab(tab, message, targetModel) {
    let originalActiveTabId = null;
    try {
      const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTabs.length > 0) originalActiveTabId = activeTabs[0].id;
      if (tab.id !== originalActiveTabId) {
        await chrome.tabs.update(tab.id, { active: true });
        await new Promise((r) => setTimeout(r, 250));
      }
    } catch (e) {
      console.warn("Failed to execute Tab Wakeup:", e);
    }
    let success = false;
    try {
      const response = await chrome.tabs.sendMessage(tab.id, message);
      if (response && response.success === false) throw new Error(response.error || "Content script reported failure");
      success = true;
    } catch (firstErr) {
      console.warn(`[Service Worker] First attempt failed for ${targetModel} tab ${tab.id}:`, firstErr.message);
      const scriptPath = MODEL_SCRIPTS[targetModel];
      if (scriptPath) {
        try {
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [scriptPath] });
          await new Promise((r) => setTimeout(r, 1e3));
          const response = await chrome.tabs.sendMessage(tab.id, message);
          if (response && response.success === false) throw new Error(response.error || "Content script reported failure");
          success = true;
        } catch (secondErr) {
          console.warn(`[Service Worker] Second attempt failed for ${targetModel} tab ${tab.id}:`, secondErr.message);
        }
      }
    }
    return success;
  }
  async function ensureModelTab(targetModel = "gemini") {
    const targetUrl = MODEL_URLS[targetModel];
    if (!targetUrl) return null;
    const tabs = await chrome.tabs.query({ url: targetUrl });
    if (tabs.length > 0) {
      return tabs[tabs.length - 1];
    }
    console.log(`[Gemini Agent] No ${targetModel} tab found. Auto-reopening in a new tab...`);
    const openUrl = targetModel === "gemini" ? "https://gemini.google.com/app" : targetModel === "chatgpt" ? "https://chatgpt.com" : targetModel === "claude" ? "https://claude.ai" : targetUrl.replace("/*", "");
    const newTab = await chrome.tabs.create({ url: openUrl, active: true });
    await new Promise((resolve) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      }, 8e3);
      function listener(tabId, changeInfo) {
        if (tabId === newTab.id && changeInfo.status === "complete") {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        }
      }
      chrome.tabs.onUpdated.addListener(listener);
    });
    await new Promise((r) => setTimeout(r, 1500));
    broadcastTabStatus();
    return newTab;
  }
  async function injectPromptIntoModel(payload) {
    const targetModel = payload.targetModel || "gemini";
    const targetUrl = MODEL_URLS[targetModel];
    if (!targetUrl) {
      const errorMsg = { type: "error", payload: { message: `\u274C Unsupported model: ${targetModel}` } };
      broadcastToSidePanel(errorMsg);
      sendToServer(errorMsg);
      return;
    }
    const message = { type: "inject_prompt", payload };
    let success = false;
    if (payload.isSubagent) {
      const newTab = await chrome.tabs.create({ url: targetUrl.replace("/*", ""), active: false });
      await new Promise((r) => setTimeout(r, 4e3));
      success = await trySendToTab(newTab, message, targetModel);
    } else {
      let tabs = await chrome.tabs.query({ url: targetUrl });
      if (tabs.length === 0) {
        console.log(`[Gemini Agent] No active ${targetModel} tab found. Auto-reopening...`);
        sendToServer({
          type: "status",
          payload: { message: `\u{1F310} Reopening ${targetModel} in a new tab...` }
        });
        const newTab = await ensureModelTab(targetModel);
        if (newTab) {
          tabs = [newTab];
        }
      }
      if (tabs.length === 0) {
        const errorMsg = {
          type: "error",
          payload: { message: `\u274C Failed to open ${targetModel} tab automatically. Please open https://gemini.google.com/app manually.` }
        };
        broadcastToSidePanel(errorMsg);
        sendToServer(errorMsg);
        return;
      }
      for (let i = tabs.length - 1; i >= 0; i--) {
        success = await trySendToTab(tabs[i], message, targetModel);
        if (success) break;
      }
    }
    if (!success) {
      const errorMsg = {
        type: "error",
        payload: { message: `Failed to communicate with ${targetModel} tab after multiple retries. Please hard-refresh the tab (Cmd+Shift+R) and try again!` }
      };
      broadcastToSidePanel(errorMsg);
      sendToServer(errorMsg);
    }
  }
  async function triggerNewChatInModel(payload) {
    const targetModel = payload.targetModel || "gemini";
    const targetUrl = MODEL_URLS[targetModel];
    if (!targetUrl) return;
    let tabs = await chrome.tabs.query({ url: targetUrl });
    if (tabs.length === 0) {
      const newTab = await ensureModelTab(targetModel);
      if (newTab) tabs = [newTab];
    }
    if (tabs.length === 0) return;
    for (let i = tabs.length - 1; i >= 0; i--) {
      try {
        await chrome.tabs.sendMessage(tabs[i].id, { type: "new_chat", payload });
        break;
      } catch (err) {
        console.warn(`[Gemini Agent] Failed to send new_chat to ${targetModel} tab ${tabs[i].id}:`, err);
      }
    }
  }

  // src/background/socket.js
  var WS_URL = "ws://localhost:7777";
  var RECONNECT_BASE = 1e3;
  var RECONNECT_MAX = 3e4;
  var HEARTBEAT_INTERVAL = 1e4;
  var ws = null;
  var heartbeatTimer = null;
  function connectWebSocket() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    try {
      ws = new WebSocket(WS_URL);
      ws.onopen = async () => {
        console.log("\u2705 Connected to agent server");
        await setState({ connected: true, reconnectAttempts: 0, lastError: null });
        ws.send(JSON.stringify({
          id: crypto.randomUUID(),
          type: "identify",
          payload: { clientType: "extension" },
          timestamp: Date.now()
        }));
        broadcastTabStatus();
        startHeartbeat();
        broadcastToSidePanel({
          type: "connection_status",
          payload: { connected: true }
        });
      };
      ws.onmessage = async (event) => {
        try {
          const message = JSON.parse(event.data);
          await handleServerMessage(message);
        } catch (err) {
          console.error("Failed to parse server message:", err);
        }
      };
      ws.onclose = async (event) => {
        console.log(`\u{1F50C} Disconnected from agent server (code: ${event.code})`);
        ws = null;
        stopHeartbeat();
        await setState({ connected: false });
        broadcastToSidePanel({
          type: "connection_status",
          payload: { connected: false }
        });
        if (event.code !== 1e3) {
          scheduleReconnect();
        }
      };
      ws.onerror = async (err) => {
        console.error("WebSocket error:", err);
        await setState({ lastError: "Connection failed" });
      };
    } catch (err) {
      console.error("Failed to create WebSocket:", err);
      scheduleReconnect();
    }
  }
  async function scheduleReconnect() {
    const state = await getState();
    const attempts = state.reconnectAttempts + 1;
    const delay = Math.min(RECONNECT_BASE * Math.pow(2, attempts - 1), RECONNECT_MAX);
    await setState({ reconnectAttempts: attempts });
    console.log(`\u{1F504} Reconnecting in ${delay}ms (attempt ${attempts})...`);
    await chrome.alarms.create("reconnect", { delayInMinutes: delay / 6e4 });
  }
  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          id: crypto.randomUUID(),
          type: "heartbeat",
          payload: {},
          timestamp: Date.now()
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
      case "status":
      case "diff_request":
      case "agent_response":
      case "tool_call":
      case "tool_result":
      case "diff_result":
      case "diff_auto_applied":
      case "error":
      case "command_result":
      case "github_notification":
      case "github_plan_generated":
        broadcastToSidePanel(message);
        break;
      case "inject_prompt":
        await injectPromptIntoModel(payload);
        break;
      case "new_chat":
        await triggerNewChatInModel(payload);
        break;
      case "heartbeat_ack":
        break;
      default:
        console.log("Unknown server message type:", type);
        broadcastToSidePanel(message);
    }
  }

  // src/background/main.js
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  chrome.tabs.onRemoved.addListener(() => {
    broadcastTabStatus();
  });
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === "complete" && tab.url && (tab.url.includes("gemini.google.com") || tab.url.includes("chatgpt.com") || tab.url.includes("claude.ai"))) {
      broadcastTabStatus();
    }
  });
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
      const { type, payload } = message;
      switch (type) {
        case "user_message":
        case "slash_command":
        case "diff_response":
        case "gemini_response":
        case "gemini_response_stream":
          if (type === "gemini_response" && payload.complete && payload.isSubagent && sender.tab) {
            payload.subagentUrl = sender.tab.url;
            chrome.tabs.remove(sender.tab.id).catch((err) => console.warn("Failed to auto-close subagent tab:", err));
          }
          sendToServer({ type, payload });
          sendResponse({ success: true });
          break;
        case "github_pr_comment":
        case "github_pr_viewing":
          sendToServer({ type, payload });
          sendResponse({ success: true });
          break;
        case "get_status":
          const state = await getState();
          sendResponse({ success: true, ...state });
          break;
        case "connect":
          connectWebSocket();
          sendResponse({ success: true });
          break;
        default:
          sendResponse({ success: false, error: "Unknown message type" });
      }
    })();
    return true;
  });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "reconnect") connectWebSocket();
  });
  chrome.runtime.onInstalled.addListener(() => {
    console.log("\u{1F916} Gemini Agent extension installed");
    connectWebSocket();
  });
  chrome.runtime.onStartup.addListener(() => {
    connectWebSocket();
  });
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name === "keepAlive") {
      port.onDisconnect.addListener(() => {
      });
    }
  });
  connectWebSocket();
})();
