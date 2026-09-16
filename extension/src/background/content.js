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

/**
 * Tabs this extension opened, and therefore may type into.
 *
 * **The agent must never use a Gemini tab the person opened for themselves.**
 * It types a system prompt and a task into whatever tab it picks, and scrapes
 * the reply back out — into a personal conversation that would be somebody's
 * own chat history, polluted with our prompts and read by us.
 *
 * `pickMainTab` used to fall back to `chrome.tabs.query({url})` and take the
 * newest match, which its own doc described as "how a lane adopts the tab the
 * user opened themselves". That is fine exactly once — when the only Gemini tab
 * open *is* the one you opened for the agent — and wrong every other time.
 *
 * It is worse in combination with MV3. `mainTabs` is module state, so every
 * time Chrome recycles the service worker the extension forgets which tab was
 * its own; the next turn re-queried and re-adopted. Recycling is not an edge
 * case here — the reconnect cadence was measured at a 30-second floor — so
 * "forget, then adopt the user's tab" was the *ordinary* path, not a rare one.
 *
 * So ownership is explicit and it is persisted. `chrome.storage.session`
 * survives a worker restart and is cleared when the browser closes, which is
 * exactly the lifetime of a tab id.
 */
const OWNED_KEY = 'agentOwnedTabs';

/** Tab ids this extension created, read through the worker's own restarts. */
async function ownedTabIds() {
  try {
    const { [OWNED_KEY]: ids = [] } = await chrome.storage.session.get(OWNED_KEY);
    return new Set(ids);
  } catch {
    // Storage unavailable: own nothing rather than claim everything. The cost
    // is a fresh tab; the cost of the other default is somebody's chat history.
    return new Set();
  }
}

/** Record that we opened this tab, so a recycled worker still knows it is ours. */
export async function claimOwnedTab(tabId) {
  if (tabId === undefined || tabId === null) return;
  try {
    const ids = await ownedTabIds();
    ids.add(tabId);
    await chrome.storage.session.set({ [OWNED_KEY]: [...ids] });
  } catch { /* the in-memory maps still work for this worker's lifetime */ }
}

/** Forget a tab we owned — it closed, or navigated away from the model. */
async function releaseOwnedTab(tabId) {
  try {
    const ids = await ownedTabIds();
    if (!ids.delete(tabId)) return;
    await chrome.storage.session.set({ [OWNED_KEY]: [...ids] });
  } catch { /* nothing to do */ }
}

/** Is this a tab we opened? */
export async function isOwnedTab(tabId) {
  return (await ownedTabIds()).has(tabId);
}

/**
 * Batch tasks that hold one tab across several turns.
 *
 * A subagent turn gets a fresh tab and that is usually right — one comment, one
 * clean conversation. A *batch task* is different: `runHeadlessTask` takes up to
 * ten turns, and giving each one its own tab means the thread is thrown away
 * every time, so the whole history has to be retyped into the next tab.
 *
 * Measured on a ten-turn task with realistic tool results: **156,140 characters
 * typed into browser tabs where 28,943 were new — 81% of it resent.** And it
 * grows with the turn, so turn 10 is a 29 KB prompt: exactly the shape
 * `CLAUDE.md` says trips Gemini's repetition filters.
 *
 * So a payload carrying `sessionId` reuses that session's tab. If the tab is
 * gone the request is **refused**, not silently rehomed: the server sent an
 * incremental prompt believing the thread was there, and dropping it into an
 * empty conversation would produce a confident answer to a question the model
 * never saw.
 *
 * @type {Map<string, number>} sessionId -> tabId
 */
const sessionTabs = new Map();

/** Register a tab opened for one subagent turn. */
export function claimSubagentTab(tabId, sessionId = null) {
  if (tabId === undefined || tabId === null) return;
  subagentTabs.add(tabId);
  if (sessionId) sessionTabs.set(sessionId, tabId);
  // We opened it, so it is ours — and a recycled worker must not later mistake
  // it for one of the user's own tabs, nor adopt it as the main lane's.
  claimOwnedTab(tabId);
}

/**
 * The live tab for a batch session, or null.
 *
 * Checks the tab still exists rather than trusting the map: the user can close
 * it, and a send into a closed tab is an error the server cannot interpret.
 */
export async function sessionTab(sessionId) {
  if (!sessionId || !sessionTabs.has(sessionId)) return null;
  const tabId = sessionTabs.get(sessionId);
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab) return tab;
  } catch {
    /* closed while we were not looking */
  }
  sessionTabs.delete(sessionId);
  return null;
}

/** End a batch session and close the tab it was holding. */
export async function endSession(sessionId) {
  const tabId = sessionTabs.get(sessionId);
  sessionTabs.delete(sessionId);
  if (tabId === undefined) return;
  subagentTabs.delete(tabId);
  focusTakenFrom.delete(tabId);
  try {
    await chrome.tabs.remove(tabId);
  } catch {
    /* already gone */
  }
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
  for (const [session, id] of sessionTabs) {
    if (id === tabId) sessionTabs.delete(session);
  }
  for (const [model, id] of mainTabs) {
    if (id === tabId) mainTabs.delete(model);
  }
  releaseOwnedTab(tabId);
}

/**
 * The tab this model's main lane should use, or null.
 *
 * Prefers the one it used last — a conversation has a thread, and moving
 * between tabs mid-session would restate context the old tab already had.
 *
 * **Only tabs this extension opened.** It used to fall back to the newest
 * matching tab, which meant that with no remembered tab — the state after every
 * service-worker recycle — the agent typed its system prompt into whichever
 * Gemini tab was newest. If that was the person's own conversation, their chat
 * history got our prompts and we scraped their thread.
 *
 * Returning `null` is the safe answer: `ensureModelTab` opens a fresh tab,
 * which costs one tab and cannot cost somebody's private conversation.
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
    await releaseOwnedTab(remembered);
  }

  // The worker may have been recycled since we opened it, so ownership is read
  // from storage rather than from the map above.
  const owned = await ownedTabIds();
  if (owned.size === 0) return null;

  const tabs = await chrome.tabs.query({ url: targetUrl });
  const usable = tabs.filter((t) => owned.has(t.id) && !subagentTabs.has(t.id));
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
  await claimOwnedTab(newTab.id);
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
    // A batch task holds one tab across its turns, so the thread survives and
    // only what is new has to be typed. See sessionTabs.
    const existing = await sessionTab(payload.sessionId);

    if (payload.sessionId && payload.continuing && !existing) {
      // Refused, not rehomed. The server sent an incremental prompt believing
      // the thread was there; dropping it into an empty conversation would get
      // a confident answer to a question the model never saw.
      const errorMsg = {
        type: 'error',
        payload: {
          op: 'session_lost',
          stage: 'send',
          targetModel,
          sessionId: payload.sessionId,
          requestId: payload.requestId,
          message: 'The tab holding this task was closed. Resend the full history.',
        },
      };
      broadcastToSidePanel(errorMsg);
      sendToServer(errorMsg);
      return;
    }

    if (existing) {
      success = await trySendToTab(existing, message, targetModel);
    } else {
      // Tab Pooling: Create a fresh isolated tab for this subagent
      const newTab = await chrome.tabs.create({ url: targetUrl.replace('/*', ''), active: false });
      // Claimed before the wait, not after: the user's own turn can be
      // dispatched during those four seconds, and an unclaimed tab is one the
      // main lane will happily pick as "the newest matching tab".
      claimSubagentTab(newTab.id, payload.sessionId);
      // Wait for initial load
      await new Promise(r => setTimeout(r, 4000));
      success = await trySendToTab(newTab, message, targetModel);
    }
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

    // One tab, because `pickMainTab` chose it. This used to walk every matching
    // tab newest-first, trying each in turn — the fallback that went with
    // addressing tabs by URL pattern. With a lane that owns its tab there is
    // nothing to fall back to, and a loop over a one-element array reads as if
    // there were.
    success = await trySendToTab(tabs[0], message, targetModel);
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
/**
 * Send a non-prompt message to a model tab.
 *
 * With a `sessionId` this addresses **that batch session's own tab**, and
 * fails rather than falling back. The fallback is the bug it exists to stop:
 * `switch_model` is how effort is changed, so a background task raising its
 * own effort would otherwise raise it in *the user's* Gemini tab — silently
 * changing the model the person is talking to, from a task they are not
 * watching. A background job that cannot reach its own tab should do nothing.
 *
 * Without one it is the main lane, which is right for everything the user
 * themselves triggers (`/effort`, reading the picker).
 */
/**
 * Point a tab at a specific past conversation.
 *
 * The far better half of "resume": the model's memory *is* the chat thread, so
 * instead of paraphrasing an old conversation back to it, open the tab on that
 * conversation. Gemini puts the thread in the URL (`/app/<id>`), so it is
 * reachable — and then the model genuinely has the history rather than a
 * summary of it.
 *
 * The lane's own tab is navigated where possible rather than piling up a tab
 * per resume. A tab we do not own is never touched: that is somebody's own
 * conversation, and taking it over would be the bug the ownership rules exist
 * to prevent.
 *
 * @param {{model: string, id: string}} thread
 * @returns {Promise<boolean>} whether a tab is now on that conversation
 */
export async function openThread(thread) {
  const model = thread?.model || 'gemini';
  const id = thread?.id;
  if (!id || !MODEL_URLS[model]) return false;

  const url = model === 'chatgpt'
    ? `https://chatgpt.com/c/${id}`
    : `https://gemini.google.com/app/${id}`;

  try {
    const existing = await pickMainTab(model);
    const tab = existing
      ? await chrome.tabs.update(existing.id, { url, active: true })
      : await chrome.tabs.create({ url, active: true });

    mainTabs.set(model, tab.id);
    await claimOwnedTab(tab.id);

    // The content script has to be in the page before anything is typed into
    // it, and a navigation replaces the one that was there.
    await new Promise((resolve) => {
      const done = setTimeout(finish, 8000);
      function finish() {
        clearTimeout(done);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
      function listener(tabId, info) {
        if (tabId === tab.id && info.status === 'complete') finish();
      }
      chrome.tabs.onUpdated.addListener(listener);
    });
    return true;
  } catch (err) {
    console.warn('[Agent CLI] Could not open that conversation:', err?.message);
    return false;
  }
}

export async function sendToModelTab(message, targetModel = 'gemini', sessionId = null) {
  const targetUrl = MODEL_URLS[targetModel];
  if (!targetUrl) return false;

  const tab = sessionId ? await sessionTab(sessionId) : await pickMainTab(targetModel);
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
