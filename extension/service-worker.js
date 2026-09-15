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

  // src/background/policy.js
  var RETRY_LADDER_MS = [250, 500, 1e3, 2e3, 4e3, 8e3];
  var RETRY_STEADY_MS = 5e3;
  var DEFAULT_PORT = 7777;
  function retryDelay(attempt2) {
    const n = Number.isInteger(attempt2) && attempt2 >= 0 ? attempt2 : 0;
    return RETRY_LADDER_MS[n] ?? RETRY_STEADY_MS;
  }
  function resolvePort(stored) {
    const n = parseInt(stored, 10);
    return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_PORT;
  }
  function socketUrlFor(port) {
    return `ws://127.0.0.1:${resolvePort(port)}`;
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
        payload: {
          op: "not_connected",
          stage: "send_to_server",
          message: "\u274C Not connected to agent server. Is it running?"
        }
      });
    }
  }

  // src/background/content.js
  var MODEL_URLS = {
    "gemini": "https://gemini.google.com/*",
    "chatgpt": "https://chatgpt.com/*"
  };
  var MODEL_SCRIPTS = {
    "gemini": "content-scripts/gemini-bridge.js",
    "chatgpt": "content-scripts/chatgpt-bridge.js"
  };
  async function reinjectModelTabs() {
    for (const [model, targetUrl] of Object.entries(MODEL_URLS)) {
      const file = MODEL_SCRIPTS[model];
      if (!file) continue;
      let tabs = [];
      try {
        tabs = await chrome.tabs.query({ url: targetUrl });
      } catch {
        continue;
      }
      for (const tab of tabs) {
        try {
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [file] });
        } catch {
        }
      }
    }
  }
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
  var lastTabFailure = null;
  var focusTakenFrom = /* @__PURE__ */ new Map();
  async function restoreFocusFrom(modelTabId) {
    const restoreTo = focusTakenFrom.get(modelTabId);
    focusTakenFrom.delete(modelTabId);
    if (restoreTo === void 0) return;
    try {
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!active || active.id !== modelTabId) return;
      await chrome.tabs.update(restoreTo, { active: true });
    } catch (e) {
    }
  }
  function rememberFocus(modelTabId, fromTabId) {
    if (fromTabId === null || fromTabId === void 0) return;
    if (modelTabId === fromTabId) return;
    focusTakenFrom.set(modelTabId, fromTabId);
  }
  var mainTabs = /* @__PURE__ */ new Map();
  var subagentTabs = /* @__PURE__ */ new Set();
  function claimSubagentTab(tabId) {
    if (tabId !== void 0 && tabId !== null) subagentTabs.add(tabId);
  }
  function forgetTab(tabId) {
    subagentTabs.delete(tabId);
    focusTakenFrom.delete(tabId);
    for (const [model, id] of mainTabs) {
      if (id === tabId) mainTabs.delete(model);
    }
  }
  async function pickMainTab(targetModel = "gemini") {
    const targetUrl = MODEL_URLS[targetModel];
    if (!targetUrl) return null;
    const remembered = mainTabs.get(targetModel);
    if (remembered !== void 0) {
      try {
        const tab = await chrome.tabs.get(remembered);
        if (tab && tab.url && matchesModelUrl(tab.url, targetModel)) return tab;
      } catch {
      }
      mainTabs.delete(targetModel);
    }
    const tabs = await chrome.tabs.query({ url: targetUrl });
    const usable = tabs.filter((t) => !subagentTabs.has(t.id));
    if (usable.length === 0) return null;
    const chosen = usable[usable.length - 1];
    mainTabs.set(targetModel, chosen.id);
    return chosen;
  }
  function matchesModelUrl(url, targetModel) {
    const pattern = MODEL_URLS[targetModel];
    if (!pattern || !url) return false;
    const host = pattern.replace(/^https?:\/\//, "").replace(/\/\*$/, "").replace(/\*$/, "");
    return url.includes(host);
  }
  async function trySendToTab(tab, message, targetModel) {
    let originalActiveTabId = null;
    try {
      const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTabs.length > 0) originalActiveTabId = activeTabs[0].id;
      if (tab.id !== originalActiveTabId) {
        await chrome.tabs.update(tab.id, { active: true });
        await new Promise((r) => setTimeout(r, 250));
        rememberFocus(tab.id, originalActiveTabId);
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
      lastTabFailure = { stage: "send", message: firstErr.message };
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
          lastTabFailure = { stage: "reinject", message: secondErr.message };
        }
      }
    }
    return success;
  }
  async function ensureModelTab(targetModel = "gemini") {
    const targetUrl = MODEL_URLS[targetModel];
    if (!targetUrl) return null;
    const existing = await pickMainTab(targetModel);
    if (existing) return existing;
    console.log(`[Agent CLI] No ${targetModel} tab found. Auto-reopening in a new tab...`);
    const openUrl = targetModel === "gemini" ? "https://gemini.google.com/app" : targetModel === "chatgpt" ? "https://chatgpt.com" : targetUrl.replace("/*", "");
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
    mainTabs.set(targetModel, newTab.id);
    broadcastTabStatus();
    return newTab;
  }
  async function injectPromptIntoModel(payload) {
    const targetModel = payload.targetModel || "gemini";
    const targetUrl = MODEL_URLS[targetModel];
    if (!targetUrl) {
      const errorMsg = {
        type: "error",
        payload: { op: "unsupported_model", stage: "route", targetModel, message: `\u274C Unsupported model: ${targetModel}` }
      };
      broadcastToSidePanel(errorMsg);
      sendToServer(errorMsg);
      return;
    }
    const message = { type: "inject_prompt", payload };
    let success = false;
    if (payload.isSubagent) {
      const newTab = await chrome.tabs.create({ url: targetUrl.replace("/*", ""), active: false });
      claimSubagentTab(newTab.id);
      await new Promise((r) => setTimeout(r, 4e3));
      success = await trySendToTab(newTab, message, targetModel);
    } else {
      const mine = await pickMainTab(targetModel);
      let tabs = mine ? [mine] : [];
      if (tabs.length === 0) {
        console.log(`[Agent CLI] No active ${targetModel} tab found. Auto-reopening...`);
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
          payload: {
            op: "no_tab",
            stage: "open_tab",
            targetModel,
            url: targetUrl,
            message: `\u274C Failed to open ${targetModel} tab automatically. Please open https://gemini.google.com/app manually.`
          }
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
        payload: {
          op: "tab_unreachable",
          stage: lastTabFailure?.stage || "send",
          targetModel,
          url: targetUrl,
          detail: lastTabFailure?.message,
          message: `Failed to communicate with ${targetModel} tab after multiple retries${lastTabFailure?.message ? ` \u2014 ${lastTabFailure.message}` : ""}. Hard-refresh the tab (Cmd+Shift+R) and try again.`
        }
      };
      lastTabFailure = null;
      broadcastToSidePanel(errorMsg);
      sendToServer(errorMsg);
    }
  }
  async function sendToModelTab(message, targetModel = "gemini") {
    const targetUrl = MODEL_URLS[targetModel];
    if (!targetUrl) return false;
    const tab = await pickMainTab(targetModel);
    if (!tab) return false;
    try {
      await chrome.tabs.sendMessage(tab.id, message);
      return true;
    } catch (err) {
      console.warn(`[Agent CLI] ${message.type} could not reach the ${targetModel} tab:`, err.message);
      return false;
    }
  }
  async function triggerNewChatInModel(payload) {
    const targetModel = payload.targetModel || "gemini";
    const targetUrl = MODEL_URLS[targetModel];
    if (!targetUrl) return;
    const tab = await pickMainTab(targetModel) || await ensureModelTab(targetModel);
    if (!tab) return;
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "new_chat", payload });
    } catch (err) {
      console.warn(`[Agent CLI] Failed to send new_chat to ${targetModel} tab ${tab.id}:`, err);
    }
  }

  // src/background/socket.js
  var KEEPALIVE_MS = 2e4;
  var ALARM_FALLBACK_MINUTES = 0.5;
  var HEARTBEAT_INTERVAL = 1e4;
  var ws = null;
  var heartbeatTimer = null;
  var retryTimer = null;
  var keepAliveTimer = null;
  var attempt = 0;
  async function getPort() {
    try {
      const { agentPort } = await chrome.storage.local.get("agentPort");
      return resolvePort(agentPort);
    } catch {
      return resolvePort(void 0);
    }
  }
  async function socketUrl() {
    return socketUrlFor(await getPort());
  }
  async function connectWebSocket() {
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
      console.warn("[socket] could not open", url, err?.message);
      scheduleRetry();
      return;
    }
    ws.onopen = async () => {
      attempt = 0;
      stopKeepAlive();
      await setState({ connected: true, reconnectAttempts: 0, lastError: null });
      ws.send(JSON.stringify({
        id: crypto.randomUUID(),
        type: "identify",
        payload: { clientType: "extension" },
        timestamp: Date.now()
      }));
      broadcastTabStatus();
      startHeartbeat();
      broadcastToSidePanel({ type: "connection_status", payload: { connected: true } });
    };
    ws.onmessage = async (event) => {
      try {
        await handleServerMessage(JSON.parse(event.data));
      } catch (err) {
        console.warn("[socket] unparseable server message:", err?.message);
      }
    };
    ws.onclose = async (event) => {
      ws = null;
      stopHeartbeat();
      await setState({ connected: false });
      broadcastToSidePanel({ type: "connection_status", payload: { connected: false } });
      if (event.code !== 1e3) scheduleRetry();
    };
    ws.onerror = async () => {
      await setState({ lastError: "Connection failed" });
    };
  }
  function scheduleRetry() {
    const delay = retryDelay(attempt);
    attempt++;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => connectWebSocket(), delay);
    startKeepAlive();
    chrome.alarms.create("reconnect", { delayInMinutes: ALARM_FALLBACK_MINUTES });
    setState({ reconnectAttempts: attempt }).catch(() => {
    });
  }
  function startKeepAlive() {
    if (keepAliveTimer) return;
    const ping = () => chrome.runtime.getPlatformInfo().catch(() => {
    });
    ping();
    keepAliveTimer = setInterval(() => {
      ping();
    }, KEEPALIVE_MS);
  }
  function stopKeepAlive() {
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
    chrome.alarms.clear("reconnect").catch(() => {
    });
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
      case "discover_models":
      case "switch_model":
        await sendToModelTab({ type, payload });
        break;
      case "heartbeat_ack":
        break;
      default:
        broadcastToSidePanel(message);
    }
  }

  // src/background/main.js
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  chrome.tabs.onRemoved.addListener((tabId) => {
    forgetTab(tabId);
    broadcastTabStatus();
  });
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === "complete" && tab.url && (tab.url.includes("gemini.google.com") || tab.url.includes("chatgpt.com"))) {
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
          if (type === "gemini_response" && sender.tab) {
            const finished = payload.complete || payload.timedOut;
            if (finished) {
              await restoreFocusFrom(sender.tab.id);
            }
            if (finished && payload.isSubagent) {
              if (payload.complete) payload.subagentUrl = sender.tab.url;
              forgetTab(sender.tab.id);
              chrome.tabs.remove(sender.tab.id).catch((err) => console.warn("Failed to auto-close subagent tab:", err));
            }
          }
          sendToServer({ type, payload });
          sendResponse({ success: true });
          break;
        case "turn_trace":
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
    console.log("\u{1F916} Agent CLI extension installed");
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
  reinjectModelTabs();
})();
