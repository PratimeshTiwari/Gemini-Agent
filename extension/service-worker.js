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
    "gemini": "https://gemini.google.com/*"
  };
  var MODEL_SCRIPTS = {
    "gemini": "content-scripts/gemini-bridge.js"
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
  var OWNED_KEY = "agentOwnedTabs";
  async function ownedTabIds() {
    try {
      const { [OWNED_KEY]: ids = [] } = await chrome.storage.session.get(OWNED_KEY);
      return new Set(ids);
    } catch {
      return /* @__PURE__ */ new Set();
    }
  }
  async function claimOwnedTab(tabId) {
    if (tabId === void 0 || tabId === null) return;
    try {
      const ids = await ownedTabIds();
      ids.add(tabId);
      await chrome.storage.session.set({ [OWNED_KEY]: [...ids] });
    } catch {
    }
  }
  async function releaseOwnedTab(tabId) {
    try {
      const ids = await ownedTabIds();
      if (!ids.delete(tabId)) return;
      await chrome.storage.session.set({ [OWNED_KEY]: [...ids] });
    } catch {
    }
  }
  var sessionTabs = /* @__PURE__ */ new Map();
  function claimSubagentTab(tabId, sessionId = null) {
    if (tabId === void 0 || tabId === null) return;
    subagentTabs.add(tabId);
    if (sessionId) {
      sessionTabs.set(sessionId, tabId);
      rememberSessionTab(sessionId, tabId);
    }
    claimOwnedTab(tabId);
  }
  var SESSIONS_KEY = "agentSessionTabs";
  async function storedSessions() {
    try {
      const { [SESSIONS_KEY]: map = {} } = await chrome.storage.session.get(SESSIONS_KEY);
      return map;
    } catch {
      return {};
    }
  }
  async function rememberSessionTab(sessionId, tabId) {
    if (!sessionId) return;
    try {
      const map = await storedSessions();
      map[sessionId] = tabId;
      await chrome.storage.session.set({ [SESSIONS_KEY]: map });
    } catch {
    }
  }
  async function forgetSessionTab(sessionId) {
    if (!sessionId) return;
    try {
      const map = await storedSessions();
      if (!(sessionId in map)) return;
      delete map[sessionId];
      await chrome.storage.session.set({ [SESSIONS_KEY]: map });
    } catch {
    }
  }
  async function sessionTab(sessionId) {
    if (!sessionId) return null;
    let tabId = sessionTabs.get(sessionId);
    if (tabId === void 0) {
      tabId = (await storedSessions())[sessionId];
      if (tabId === void 0) return null;
      sessionTabs.set(sessionId, tabId);
      subagentTabs.add(tabId);
    }
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab) return tab;
    } catch {
    }
    sessionTabs.delete(sessionId);
    await forgetSessionTab(sessionId);
    return null;
  }
  async function endSession(sessionId) {
    const tabId = sessionTabs.get(sessionId) ?? (await storedSessions())[sessionId];
    sessionTabs.delete(sessionId);
    await forgetSessionTab(sessionId);
    if (tabId === void 0) return;
    subagentTabs.delete(tabId);
    focusTakenFrom.delete(tabId);
    try {
      await chrome.tabs.remove(tabId);
    } catch {
    }
  }
  function forgetTab(tabId) {
    stopCompletionTicks(tabId);
    subagentTabs.delete(tabId);
    focusTakenFrom.delete(tabId);
    for (const [session, id] of sessionTabs) {
      if (id === tabId) sessionTabs.delete(session);
    }
    for (const [model, id] of mainTabs) {
      if (id === tabId) mainTabs.delete(model);
    }
    releaseOwnedTab(tabId);
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
      await releaseOwnedTab(remembered);
    }
    const owned = await ownedTabIds();
    if (owned.size === 0) return null;
    const tabs = await chrome.tabs.query({ url: targetUrl });
    const usable = tabs.filter((t) => owned.has(t.id) && !subagentTabs.has(t.id));
    if (usable.length === 0) return null;
    const chosen = usable[usable.length - 1];
    mainTabs.set(targetModel, chosen.id);
    return chosen;
  }
  async function adoptableModelTab(targetModel = "gemini") {
    const targetUrl = MODEL_URLS[targetModel];
    if (!targetUrl) return null;
    try {
      const tabs = await chrome.tabs.query({ url: targetUrl });
      const usable = tabs.filter((t) => !subagentTabs.has(t.id));
      return usable.length ? usable[usable.length - 1] : null;
    } catch {
      return null;
    }
  }
  function matchesModelUrl(url, targetModel) {
    const pattern = MODEL_URLS[targetModel];
    if (!pattern || !url) return false;
    const host = pattern.replace(/^https?:\/\//, "").replace(/\/\*$/, "").replace(/\*$/, "");
    return url.includes(host);
  }
  var BRIDGE_PING_START_MS = 50;
  var BRIDGE_PING_MAX_MS = 400;
  var BRIDGE_CAN_TYPE_SHARE = 0.6;
  async function waitForBridge(tabId, budgetMs) {
    const start = Date.now();
    const deadline = start + budgetMs;
    const canTypeDeadline = start + budgetMs * BRIDGE_CAN_TYPE_SHARE;
    let delay = BRIDGE_PING_START_MS;
    let sawAlive = false;
    while (Date.now() < deadline) {
      try {
        const res = await chrome.tabs.sendMessage(tabId, { type: "ping" });
        if (res?.canType) return true;
        if (res?.ready) {
          sawAlive = true;
          if (Date.now() > canTypeDeadline) return true;
        }
      } catch {
      }
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(Math.round(delay * 1.5), BRIDGE_PING_MAX_MS);
    }
    return sawAlive;
  }
  var COMPLETION_TICK_MS = 2e3;
  var COMPLETION_CONFIRM_MS = 250;
  var completionTickers = /* @__PURE__ */ new Map();
  var completionConfirms = /* @__PURE__ */ new Map();
  function startCompletionTicks(tabId, everyMs = COMPLETION_TICK_MS) {
    stopCompletionTicks(tabId);
    const tick = async () => {
      try {
        const res = await chrome.tabs.sendMessage(tabId, { type: "tick_completion" });
        if (res && res.watching === false) {
          stopCompletionTicks(tabId);
          return;
        }
        if (res && res.confirmSoon && completionTickers.has(tabId)) {
          const soon = setTimeout(tick, Math.min(COMPLETION_CONFIRM_MS, everyMs / 4));
          soon.unref?.();
          completionConfirms.set(tabId, soon);
        }
      } catch {
        stopCompletionTicks(tabId);
      }
    };
    const timer = setInterval(tick, everyMs);
    timer.unref?.();
    completionTickers.set(tabId, timer);
  }
  function stopCompletionTicks(tabId) {
    const soon = completionConfirms.get(tabId);
    if (soon !== void 0) {
      clearTimeout(soon);
      completionConfirms.delete(tabId);
    }
    const timer = completionTickers.get(tabId);
    if (timer === void 0) return;
    clearInterval(timer);
    completionTickers.delete(tabId);
  }
  async function prepareTabForTurn(tabId) {
    let info = null;
    try {
      info = await chrome.tabs.get(tabId);
    } catch {
      return;
    }
    try {
      if (info.autoDiscardable !== false) {
        await chrome.tabs.update(tabId, { autoDiscardable: false });
      }
    } catch {
    }
    if (!info.discarded) return;
    try {
      await chrome.tabs.reload(tabId);
      await waitForBridge(tabId, 1e4);
    } catch {
    }
  }
  async function sendWithRepairs(tabId, message, targetModel) {
    const scriptPath = MODEL_SCRIPTS[targetModel];
    const attempt2 = async () => {
      const response = await chrome.tabs.sendMessage(tabId, message);
      if (response && response.success === false) {
        throw new Error(response.error || "Content script reported failure");
      }
      return true;
    };
    const repairs = [
      { stage: "send", before: null },
      {
        stage: "reinject",
        before: scriptPath ? async () => {
          await chrome.scripting.executeScript({ target: { tabId }, files: [scriptPath] });
          await waitForBridge(tabId, 3e3);
        } : null
      },
      {
        stage: "reload",
        before: async () => {
          await chrome.tabs.reload(tabId);
          await waitForBridge(tabId, 15e3);
        }
      }
    ];
    for (const { stage, before } of repairs) {
      if (stage !== "send" && !before) continue;
      try {
        if (before) await before();
        return await attempt2();
      } catch (err) {
        console.warn(`[Service Worker] ${stage} attempt failed for ${targetModel} tab ${tabId}:`, err.message);
        lastTabFailure = { stage, message: err.message };
      }
    }
    return false;
  }
  async function selectModelInTab(tabId, label, budgetMs) {
    const wanted = String(label || "").trim().toLowerCase();
    if (!wanted) return false;
    try {
      await chrome.tabs.sendMessage(tabId, { type: "switch_model", payload: { label } });
    } catch {
      return false;
    }
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150));
      try {
        const status = await chrome.tabs.sendMessage(tabId, { type: "get_page_status" });
        const now = String(status?.model || "").toLowerCase();
        if (now && (now === wanted || now.includes(wanted) || wanted.includes(now))) return true;
      } catch {
      }
    }
    return false;
  }
  async function trySendToTab(tab, message, targetModel) {
    await prepareTabForTurn(tab.id);
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
    const success = await sendWithRepairs(tab.id, message, targetModel);
    if (success) {
      startCompletionTicks(tab.id);
      await restoreFocusFrom(tab.id);
    }
    return success;
  }
  async function ensureModelTab(targetModel = "gemini") {
    const targetUrl = MODEL_URLS[targetModel];
    if (!targetUrl) return null;
    const existing = await pickMainTab(targetModel);
    if (existing) return existing;
    console.log(`[Agent CLI] No ${targetModel} tab found. Auto-reopening in a new tab...`);
    const openUrl = targetModel === "gemini" ? "https://gemini.google.com/app" : targetUrl.replace("/*", "");
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
    await waitForBridge(newTab.id, 5e3);
    mainTabs.set(targetModel, newTab.id);
    await claimOwnedTab(newTab.id);
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
      const existing = await sessionTab(payload.sessionId);
      if (payload.sessionId && payload.continuing && !existing) {
        const errorMsg = {
          type: "error",
          payload: {
            op: "session_lost",
            stage: "send",
            targetModel,
            sessionId: payload.sessionId,
            requestId: payload.requestId,
            message: "The tab holding this task was closed. Resend the full history."
          }
        };
        broadcastToSidePanel(errorMsg);
        sendToServer(errorMsg);
        return;
      }
      if (existing) {
        success = await trySendToTab(existing, message, targetModel);
      } else {
        const newTab = await chrome.tabs.create({ url: targetUrl.replace("/*", ""), active: false });
        claimSubagentTab(newTab.id, payload.sessionId);
        await waitForBridge(newTab.id, 1e4);
        if (payload.model) await selectModelInTab(newTab.id, payload.model, 5e3);
        success = await trySendToTab(newTab, message, targetModel);
      }
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
      success = await trySendToTab(tabs[0], message, targetModel);
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
  async function focusModelTab(targetModel = "gemini") {
    const tab = await pickMainTab(targetModel) || await adoptableModelTab(targetModel);
    if (!tab) return false;
    try {
      await chrome.tabs.update(tab.id, { active: true });
      if (tab.windowId != null) {
        await chrome.windows.update(tab.windowId, { focused: true, state: "normal" });
      }
      return true;
    } catch (err) {
      console.warn("[Agent CLI] Could not focus the model tab:", err);
      return false;
    }
  }
  async function openThread(thread) {
    const model = thread?.model || "gemini";
    const id = thread?.id;
    if (!id || !MODEL_URLS[model]) return false;
    const url = `https://gemini.google.com/app/${id}`;
    try {
      const existing = await pickMainTab(model);
      const tab = existing ? await chrome.tabs.update(existing.id, { url, active: true }) : await chrome.tabs.create({ url, active: true });
      mainTabs.set(model, tab.id);
      await claimOwnedTab(tab.id);
      await new Promise((resolve) => {
        const done = setTimeout(finish, 8e3);
        function finish() {
          clearTimeout(done);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
        function listener(tabId, info) {
          if (tabId === tab.id && info.status === "complete") finish();
        }
        chrome.tabs.onUpdated.addListener(listener);
      });
      return true;
    } catch (err) {
      console.warn("[Agent CLI] Could not open that conversation:", err?.message);
      return false;
    }
  }
  async function sendToModelTab(message, targetModel = "gemini", sessionId = null) {
    const targetUrl = MODEL_URLS[targetModel];
    if (!targetUrl) return false;
    const tab = sessionId ? await sessionTab(sessionId) : await pickMainTab(targetModel);
    if (!tab) {
      lastTabFailure = `[${message.type}] no ${targetModel} tab this extension owns \u2014 open one from the agent, or reload the extension if you opened it yourself`;
      return false;
    }
    try {
      await chrome.tabs.sendMessage(tab.id, message);
      return true;
    } catch (err) {
      lastTabFailure = `[${message.type}] ${err.message}`;
      console.warn(`[Agent CLI] ${message.type} could not reach the ${targetModel} tab:`, err.message);
      return false;
    }
  }
  function takeTabFailure() {
    const reason = lastTabFailure;
    lastTabFailure = null;
    return reason;
  }
  async function triggerNewChatInModel(payload) {
    const targetModel = payload.targetModel || "gemini";
    const targetUrl = MODEL_URLS[targetModel];
    if (!targetUrl) return false;
    const tab = await pickMainTab(targetModel) || await ensureModelTab(targetModel);
    if (!tab) return false;
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "new_chat", payload });
      return true;
    } catch (err) {
      console.warn(`[Agent CLI] Failed to send new_chat to ${targetModel} tab ${tab.id}:`, err);
      return false;
    }
  }

  // src/background/socket.js
  var KEEPALIVE_MS = 2e4;
  var ALARM_FALLBACK_MINUTES = 0.5;
  var WATCHDOG_ALARM = "reconnect";
  var HEARTBEAT_INTERVAL = 1e4;
  var ws = null;
  var isSocketOpen = () => Boolean(ws) && ws.readyState === WebSocket.OPEN;
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
      ensureWatchdogAlarm();
      await setState({ connected: true, reconnectAttempts: 0, lastError: null });
      ws.send(JSON.stringify({
        id: crypto.randomUUID(),
        type: "identify",
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
          clientType: "extension",
          version: chrome.runtime.getManifest().version
        },
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
    ensureWatchdogAlarm();
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
  }
  async function ensureWatchdogAlarm() {
    try {
      const existing = await chrome.alarms.get(WATCHDOG_ALARM);
      if (existing) return;
      chrome.alarms.create(WATCHDOG_ALARM, {
        delayInMinutes: ALARM_FALLBACK_MINUTES,
        periodInMinutes: ALARM_FALLBACK_MINUTES
      });
    } catch {
    }
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
  function reportTabFailure(op) {
    const message = takeTabFailure() || `[${op}] could not reach a model tab`;
    sendToServer({ type: "error", payload: { op, stage: "tab", message } });
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
        broadcastToSidePanel(message);
        break;
      case "inject_prompt":
        await injectPromptIntoModel(payload);
        break;
      case "new_chat": {
        const started = await triggerNewChatInModel(payload || {});
        sendToServer({ type: "chat_started", payload: { ok: started, requestId: payload?.requestId } });
        break;
      }
      // Resuming a past conversation: point the tab at it, so the model has the
      // history itself rather than a paraphrase of it.
      case "open_thread": {
        const opened = await openThread(payload?.thread);
        sendToServer({ type: "thread_opened", payload: { ok: opened, thread: payload?.thread } });
        break;
      }
      case "end_session":
        await endSession(payload?.sessionId);
        break;
      case "focus_tab":
        if (!await focusModelTab(payload?.targetModel)) reportTabFailure("focus_tab");
        break;
      case "discover_models":
      case "switch_model":
        if (!await sendToModelTab(
          { type, payload },
          payload?.targetModel || "gemini",
          payload?.sessionId || null
        )) reportTabFailure(type);
        break;
      case "heartbeat_ack":
        break;
      default:
        broadcastToSidePanel(message);
    }
  }

  // src/background/main.js
  chrome.tabs.onRemoved.addListener((tabId) => {
    forgetTab(tabId);
    broadcastTabStatus();
  });
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === "complete" && tab.url && tab.url.includes("gemini.google.com")) {
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
            payload.tabUrl = sender.tab.url;
            const finished = payload.complete || payload.timedOut;
            if (finished) {
              stopCompletionTicks(sender.tab.id);
              await restoreFocusFrom(sender.tab.id);
            }
            if (finished && payload.isSubagent) {
              if (payload.complete) payload.subagentUrl = sender.tab.url;
              if (!payload.sessionId) {
                forgetTab(sender.tab.id);
                chrome.tabs.remove(sender.tab.id).catch((err) => console.warn("Failed to auto-close subagent tab:", err));
              }
            }
          }
          sendToServer({ type, payload });
          sendResponse({ success: true });
          break;
        // The panel unblocking a turn that is parked on a question or a command
        // approval. Pure relay — the server owns both resolvers.
        case "get_history":
        case "list_sessions":
        case "resume_session":
        case "pick_workspace":
        case "set_workspace":
        case "question_response":
        case "command_approval_response":
        case "turn_trace":
          sendToServer({ type, payload });
          sendResponse({ success: true });
          break;
        case "get_status": {
          const state = await getState();
          sendResponse({ success: true, ...state, connected: isSocketOpen() });
          break;
        }
        case "connect":
          sendResponse({ success: true, connected: isSocketOpen() });
          connectWebSocket();
          break;
        default:
          sendResponse({ success: false, error: "Unknown message type" });
      }
    })();
    return true;
  });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== "reconnect") return;
    if (isSocketOpen()) return;
    connectWebSocket();
  });
  chrome.runtime.onInstalled.addListener(() => {
    console.log("\u{1F916} Agent CLI extension installed");
    ensureWatchdogAlarm();
    connectWebSocket();
  });
  chrome.runtime.onStartup.addListener(() => {
    ensureWatchdogAlarm();
    connectWebSocket();
  });
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name === "keepAlive") {
      port.onDisconnect.addListener(() => {
      });
    }
  });
  ensureWatchdogAlarm();
  connectWebSocket();
  reinjectModelTabs();
})();
