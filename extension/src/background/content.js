import { broadcastToSidePanel, sendToServer } from './messaging.js';
import { ws } from './socket.js';

const MODEL_URLS = {
  'gemini': 'https://gemini.google.com/*',
  'chatgpt': 'https://chatgpt.com/*',
};

const MODEL_SCRIPTS = {
  'gemini': 'content-scripts/gemini-bridge.js',
  'chatgpt': 'content-scripts/chatgpt-bridge.js',
};

/**
 * Re-inject the bridge into model tabs that are already open.
 *
 * Reloading the extension orphans every content script already running: the
 * page keeps executing, but its link to the extension is severed and
 * `chrome.runtime.sendMessage` throws. The symptom is the worst kind — the tab
 * looks fine, Gemini answers normally, and the reply simply never arrives. One
 * live turn was lost to exactly this: the CLI sat on "Thinking…" for the full
 * watchdog with no explanation anywhere.
 *
 * The content script now notices and goes quiet, but going quiet is not
 * repairing. This is the repair: on every worker start, put a fresh copy into
 * the tabs that are already open. Chrome gives the new copy its own isolated
 * world, so it does not collide with the orphaned one, and the orphan has
 * already stopped its own timers by then.
 *
 * Failures are ignored per tab on purpose — a restricted or discarded tab is
 * not a reason to skip the rest.
 */
export async function reinjectModelTabs() {
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
        // Discarded, restricted, or mid-navigation. The next start tries again.
      }
    }
  }
}

export async function broadcastTabStatus() {
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
    type: 'tab_status',
    payload: { connectedModels },
  });
}

/**
 * Why the last attempt to reach a tab failed.
 *
 * The bridge logs whatever the extension reports, and the extension reported
 * only "failed after multiple retries" — so `/logs extension` could say that
 * something in the browser broke and nothing about what. This carries the
 * actual DOM-side message out to the terminal, which is the only place anyone
 * is looking when a selector on gemini.google.com changes.
 */
let lastTabFailure = null;

/**
 * Model tab id -> the tab whose focus it took.
 *
 * The Tab Wakeup Protocol activates a model tab so Chrome does not throttle the
 * DOM work happening in it, and it never gave the focus back — so every send
 * yanked the browser to Gemini and left it there, which on a tool whose whole
 * premise is that the browser is a background engine is the most intrusive
 * thing it does.
 *
 * Keyed by tab rather than held in one slot because a subagent turn and the
 * user's own turn can be in flight at once, in different tabs, and each has its
 * own answer to "where was I before this started".
 */
const focusTakenFrom = new Map();

/**
 * Give focus back, once the tab is finished with.
 *
 * Deliberately does nothing if the model tab is no longer the active one: that
 * means the user moved on while the reply was generating, and pulling them back
 * would be a second theft rather than a repair.
 */
export async function restoreFocusFrom(modelTabId) {
  const restoreTo = focusTakenFrom.get(modelTabId);
  focusTakenFrom.delete(modelTabId);
  if (restoreTo === undefined) return;

  try {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!active || active.id !== modelTabId) return;
    await chrome.tabs.update(restoreTo, { active: true });
  } catch (e) {
    // The tab we came from has been closed. Nothing to go back to.
  }
}

/** Record that `modelTabId` took the focus that belonged to `fromTabId`. */
export function rememberFocus(modelTabId, fromTabId) {
  if (fromTabId === null || fromTabId === undefined) return;
  if (modelTabId === fromTabId) return;
  focusTakenFrom.set(modelTabId, fromTabId);
}

/** A tab that closes on its own must not leave an entry behind. */
export function forgetFocusFrom(modelTabId) {
  focusTakenFrom.delete(modelTabId);
}

/**
 * Which tab belongs to which lane.
 *
 * Tabs were addressed by URL pattern and never by identity: every path did
 * `chrome.tabs.query({ url })` and took `tabs[tabs.length - 1]`, whatever tab
 * happened to be last. A subagent turn opens a *fresh* tab on the same site, so
 * the newest matching tab is very often the subagent's — and the user's next
 * prompt was typed into it, landing in the middle of a subagent's conversation.
 * Reading the mode picker had the same fault, from the same line.
 *
 * `ExtensionLock` already gives each model its own queue, so two models really
 * do run at once. That is only sound if a lane can say *which tab is mine*.
 *
 * Two structures, because there are two questions. `mainTabs` answers "where
 * does this model's conversation live", and is sticky so a turn lands in the
 * same chat thread as the turn before it. `subagentTabs` answers "is this tab
 * somebody else's", and is a denial list rather than an ownership one: a
 * subagent tab is disposable and lives for one turn, so nothing needs to find
 * it again — the main lane only needs to never pick it.
 */
const mainTabs = new Map();
const subagentTabs = new Set();

/** Register a tab opened for one subagent turn. */
export function claimSubagentTab(tabId) {
  if (tabId !== undefined && tabId !== null) subagentTabs.add(tabId);
}

/** Whether a tab belongs to a subagent turn. */
export const isSubagentTab = (tabId) => subagentTabs.has(tabId);

/**
 * Drop every record of a tab.
 *
 * Called for *any* tab that closes, not just ones we opened: a main tab the
 * user closes by hand must not stay remembered, or the next turn tries to send
 * into a tab that no longer exists and reports the site as unreachable.
 */
export function forgetTab(tabId) {
  subagentTabs.delete(tabId);
  focusTakenFrom.delete(tabId);
  for (const [model, id] of mainTabs) {
    if (id === tabId) mainTabs.delete(model);
  }
}

/** Test seam: the lane bookkeeping, with nothing else attached. */
export function __tabLanes() {
  return { mainTabs, subagentTabs };
}

/**
 * The tab this model's main lane should use, or null.
 *
 * Prefers the one it used last — a conversation has a thread, and moving
 * between tabs mid-session would restate context the old tab already had. Falls
 * back to the newest matching tab that is not a subagent's, which is also how a
 * lane adopts the tab the user opened themselves.
 */
export async function pickMainTab(targetModel = 'gemini') {
  const targetUrl = MODEL_URLS[targetModel];
  if (!targetUrl) return null;

  const remembered = mainTabs.get(targetModel);
  if (remembered !== undefined) {
    try {
      const tab = await chrome.tabs.get(remembered);
      // A tab that has navigated away is no longer this lane's tab, even though
      // its id is unchanged.
      if (tab && tab.url && matchesModelUrl(tab.url, targetModel)) return tab;
    } catch {
      /* closed while we were not looking */
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

/** Does this URL belong to that model? The query pattern, without the query. */
export function matchesModelUrl(url, targetModel) {
  const pattern = MODEL_URLS[targetModel];
  if (!pattern || !url) return false;
  const host = pattern.replace(/^https?:\/\//, '').replace(/\/\*$/, '').replace(/\*$/, '');
  return url.includes(host);
}

async function trySendToTab(tab, message, targetModel) {
  let originalActiveTabId = null;
  try {
    const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTabs.length > 0) originalActiveTabId = activeTabs[0].id;
    
    // Tab Wakeup Protocol: Briefly activate the target tab to bypass throttling
    if (tab.id !== originalActiveTabId) {
      await chrome.tabs.update(tab.id, { active: true });
      await new Promise(r => setTimeout(r, 250)); // Wait for Chrome to wake up the DOM
      // Remember what we took it from. Restoring here would undo the wakeup —
      // completion is detected by a 2s `setInterval` in the content script, and
      // Chrome throttles that to once a minute in a background tab, so a turn
      // would take a minute to be noticed as finished. The tab has to stay in
      // front until the reply lands; `restoreFocusFrom` is called then.
      rememberFocus(tab.id, originalActiveTabId);
    }
  } catch (e) {
    console.warn('Failed to execute Tab Wakeup:', e);
  }

  let success = false;
  try {
    const response = await chrome.tabs.sendMessage(tab.id, message);
    if (response && response.success === false) throw new Error(response.error || 'Content script reported failure');
    success = true;
  } catch (firstErr) {
    console.warn(`[Service Worker] First attempt failed for ${targetModel} tab ${tab.id}:`, firstErr.message);
    lastTabFailure = { stage: 'send', message: firstErr.message };
    
    const scriptPath = MODEL_SCRIPTS[targetModel];
    if (scriptPath) {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [scriptPath] });
        await new Promise(r => setTimeout(r, 1000));
        const response = await chrome.tabs.sendMessage(tab.id, message);
        if (response && response.success === false) throw new Error(response.error || 'Content script reported failure');
        success = true;
      } catch (secondErr) {
        console.warn(`[Service Worker] Second attempt failed for ${targetModel} tab ${tab.id}:`, secondErr.message);
        lastTabFailure = { stage: 'reinject', message: secondErr.message };
      }
    }
  }

  // Keep the target model tab active to prevent Chrome from throttling background DOM operations

  return success;
}

export async function ensureModelTab(targetModel = 'gemini') {
  const targetUrl = MODEL_URLS[targetModel];
  if (!targetUrl) return null;

  // The lane's own tab, never a subagent's — see pickMainTab.
  const existing = await pickMainTab(targetModel);
  if (existing) return existing;

  // No tab found: automatically reopen in a new tab
  console.log(`[Agent CLI] No ${targetModel} tab found. Auto-reopening in a new tab...`);
  const openUrl = targetModel === 'gemini' 
    ? 'https://gemini.google.com/app' 
    : (targetModel === 'chatgpt' ? 'https://chatgpt.com' : targetUrl.replace('/*', ''));

  const newTab = await chrome.tabs.create({ url: openUrl, active: true });

  // Wait for the new tab to complete loading
  await new Promise((resolve) => {
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }, 8000);

    function listener(tabId, changeInfo) {
      if (tabId === newTab.id && changeInfo.status === 'complete') {
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

  // Brief pause for the content script bridge to mount into the DOM
  await new Promise(r => setTimeout(r, 1500));
  mainTabs.set(targetModel, newTab.id);
  broadcastTabStatus();
  return newTab;
}

export async function injectPromptIntoModel(payload) {
  const targetModel = payload.targetModel || 'gemini';
  const targetUrl = MODEL_URLS[targetModel];

  if (!targetUrl) {
    const errorMsg = {
      type: 'error',
      payload: { op: 'unsupported_model', stage: 'route', targetModel, message: `❌ Unsupported model: ${targetModel}` },
    };
    broadcastToSidePanel(errorMsg);
    sendToServer(errorMsg);
    return;
  }

  const message = { type: 'inject_prompt', payload };
  let success = false;

  if (payload.isSubagent) {
    // Tab Pooling: Create a fresh isolated tab for this subagent
    const newTab = await chrome.tabs.create({ url: targetUrl.replace('/*', ''), active: false });
    // Claimed before the wait, not after: the user's own turn can be dispatched
    // during those four seconds, and an unclaimed tab is one the main lane will
    // happily pick as "the newest matching tab".
    claimSubagentTab(newTab.id);
    // Wait for initial load
    await new Promise(r => setTimeout(r, 4000));
    success = await trySendToTab(newTab, message, targetModel);
  } else {
    // Primary Agent: this lane's own tab, or open one. Never a subagent's:
    // those are on the same site, and taking the newest matching tab used to
    // drop the user's prompt into a subagent's conversation.
    const mine = await pickMainTab(targetModel);
    let tabs = mine ? [mine] : [];
    if (tabs.length === 0) {
      console.log(`[Agent CLI] No active ${targetModel} tab found. Auto-reopening...`);
      sendToServer({
        type: 'status',
        payload: { message: `🌐 Reopening ${targetModel} in a new tab...` }
      });
      const newTab = await ensureModelTab(targetModel);
      if (newTab) {
        tabs = [newTab];
      }
    }

    if (tabs.length === 0) {
      const errorMsg = {
        type: 'error',
        payload: {
          op: 'no_tab',
          stage: 'open_tab',
          targetModel,
          url: targetUrl,
          message: `❌ Failed to open ${targetModel} tab automatically. Please open https://gemini.google.com/app manually.`,
        },
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
      type: 'error',
      payload: {
        op: 'tab_unreachable',
        stage: lastTabFailure?.stage || 'send',
        targetModel,
        url: targetUrl,
        detail: lastTabFailure?.message,
        message: `Failed to communicate with ${targetModel} tab after multiple retries`
          + `${lastTabFailure?.message ? ` — ${lastTabFailure.message}` : ''}`
          + '. Hard-refresh the tab (Cmd+Shift+R) and try again.',
      },
    };
    lastTabFailure = null;
    broadcastToSidePanel(errorMsg);
    sendToServer(errorMsg);
  }
}

/**
 * Send one message to an existing model tab, and do nothing else.
 *
 * Unlike `injectPromptIntoModel` this never opens a tab and never activates one:
 * reading the mode picker is not a turn, and the whole point of doing it is to
 * avoid surprises — opening a window to find out which model is selected would
 * be a worse cure than the disease.
 */
export async function sendToModelTab(message, targetModel = 'gemini') {
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

export async function triggerNewChatInModel(payload) {
  const targetModel = payload.targetModel || 'gemini';
  const targetUrl = MODEL_URLS[targetModel];
  if (!targetUrl) return;

  // This lane's tab. Starting a new chat in a subagent's tab would clear a
  // conversation that is mid-turn, and leave the user's own thread untouched.
  const tab = (await pickMainTab(targetModel)) || (await ensureModelTab(targetModel));
  if (!tab) return;

  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'new_chat', payload });
  } catch (err) {
    console.warn(`[Agent CLI] Failed to send new_chat to ${targetModel} tab ${tab.id}:`, err);
  }
}
