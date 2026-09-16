/**
 * Which tab is this lane's tab.
 *
 * Every path here addressed tabs by URL pattern and never by identity:
 * `chrome.tabs.query({ url })` then `tabs[tabs.length - 1]` — whatever tab
 * happened to be last. A subagent turn opens a *fresh* tab on the same site, so
 * the newest matching tab is very often the subagent's, and the user's next
 * prompt went into the middle of a subagent's conversation. Reading and
 * switching the mode picker had the same fault from the same line, and so did
 * starting a new chat, which would have wiped a subagent's thread mid-turn.
 *
 * `ExtensionLock` gives each model its own queue so two models genuinely run at
 * once. That is only sound if a lane can say which tab is its own.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const GEMINI = 'https://gemini.google.com/app';

/**
 * The slice of `chrome` these paths touch, over a fake set of open tabs.
 *
 * `owned` seeds `chrome.storage.session` with the tabs the extension is to
 * believe it opened. Ownership is persisted there rather than held in module
 * state because the service worker is recycled constantly — and a recycled
 * worker that has forgotten its own tab used to adopt the user's.
 */
function stubChrome(tabs, owned = []) {
  const open = new Map(tabs.map((t) => [t.id, t]));
  const sent = [];
  const created = [];
  const session = { agentOwnedTabs: [...owned] };
  globalThis.chrome = {
    storage: {
      session: {
        get: async (key) => ({ [key]: session[key] }),
        set: async (obj) => { Object.assign(session, obj); },
      },
    },
    tabs: {
      query: async ({ url, active }) => {
        if (active) return [...open.values()].filter((t) => t.active);
        if (!url) return [...open.values()];
        const host = url.replace(/^https?:\/\//, '').replace(/\/\*$/, '');
        return [...open.values()].filter((t) => (t.url || '').includes(host));
      },
      get: async (id) => {
        if (!open.has(id)) throw new Error('No tab with id: ' + id);
        return open.get(id);
      },
      create: async (props) => {
        const tab = { id: 1000 + created.length, ...props };
        open.set(tab.id, tab);
        created.push(tab);
        return tab;
      },
      update: async () => {},
      remove: async (id) => { open.delete(id); },
      sendMessage: async (id, message) => { sent.push({ id, message }); return { success: true }; },
      onUpdated: { addListener: () => {}, removeListener: () => {} },
    },
    scripting: { executeScript: async () => {} },
    runtime: { sendMessage: async () => {} },
  };
  return { open, sent, created, session };
}

let content;
beforeEach(async () => {
  // Fresh module state per test: the lane maps are module-level.
  content = await import(`../../src/background/content.js?${Math.random()}`);
});

test('with one tab open that we opened, that is the lane\'s tab', async () => {
  stubChrome([{ id: 5, url: GEMINI }], [5]);
  const tab = await content.pickMainTab('gemini');
  assert.equal(tab.id, 5);
});

test('a subagent tab is never picked for the main lane', async () => {
  stubChrome([{ id: 5, url: GEMINI }, { id: 9, url: GEMINI }], [5, 9]);
  content.claimSubagentTab(9);        // 9 is newer, and used to win
  const tab = await content.pickMainTab('gemini');
  assert.equal(tab.id, 5, 'the user\'s prompt would have gone into the subagent\'s chat');
});

test('the lane keeps the tab it used last, not the newest one', async () => {
  const { open } = stubChrome([{ id: 5, url: GEMINI }], [5]);
  assert.equal((await content.pickMainTab('gemini')).id, 5);
  // The user opens a second Gemini tab. The conversation is still in the first
  // — and that one is theirs, so it was never a candidate anyway.
  open.set(11, { id: 11, url: GEMINI });
  assert.equal((await content.pickMainTab('gemini')).id, 5,
    'moving tabs mid-session restates context the old tab already had');
});

test('a closed tab is released, and the lane adopts another', async () => {
  const { open } = stubChrome([{ id: 5, url: GEMINI }, { id: 11, url: GEMINI }], [5, 11]);
  assert.equal((await content.pickMainTab('gemini')).id, 11);
  open.delete(11);
  assert.equal((await content.pickMainTab('gemini')).id, 5);
});

test('a tab that navigated away is no longer the lane\'s, id or not', async () => {
  const { open } = stubChrome([{ id: 5, url: GEMINI }], [5]);
  assert.equal((await content.pickMainTab('gemini')).id, 5);
  open.set(5, { id: 5, url: 'https://example.com/' });
  assert.equal(await content.pickMainTab('gemini'), null);
});

test('no tab at all is null, not a throw', async () => {
  stubChrome([]);
  assert.equal(await content.pickMainTab('gemini'), null);
});

test('an unknown model is null', async () => {
  stubChrome([{ id: 5, url: GEMINI }]);
  assert.equal(await content.pickMainTab('nosuchmodel'), null);
});

test('forgetTab drops the lane and the subagent claim together', async () => {
  const { open } = stubChrome([{ id: 5, url: GEMINI }, { id: 9, url: GEMINI }], [5, 9]);
  content.claimSubagentTab(9);
  await content.pickMainTab('gemini');                 // claims 5
  assert.equal(content.isSubagentTab(9), true);

  content.forgetTab(9);
  assert.equal(content.isSubagentTab(9), false);

  // 5 is forgotten as a lane, so the next pick is free to choose the newest.
  content.forgetTab(5);
  open.delete(5);
  assert.equal((await content.pickMainTab('gemini')).id, 9);
});

test('a subagent turn claims its tab before it waits for the load', async () => {
  // The four-second wait is long enough for the user's own turn to be
  // dispatched, and an unclaimed tab is one the main lane will pick.
  const { created } = stubChrome([{ id: 5, url: GEMINI }], [5]);
  const inFlight = content.injectPromptIntoModel({
    targetModel: 'gemini', isSubagent: true, prompt: 'go',
  });
  // Yield once: enough for tabs.create to resolve, not for the 4s wait.
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(created.length, 1, 'no subagent tab was created');
  assert.equal(content.isSubagentTab(created[0].id), true,
    'the tab is claimable by the main lane during the load wait');
  assert.equal((await content.pickMainTab('gemini')).id, 5);
  await inFlight;
});

test('a new chat goes to the lane\'s tab, never a subagent\'s', async () => {
  const { sent } = stubChrome([{ id: 5, url: GEMINI }, { id: 9, url: GEMINI }], [5, 9]);
  content.claimSubagentTab(9);
  await content.triggerNewChatInModel({ targetModel: 'gemini' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, 5, 'a new chat would have wiped a subagent mid-turn');
  assert.equal(sent[0].message.type, 'new_chat');
});

test('the mode picker is read in the lane\'s tab', async () => {
  const { sent } = stubChrome([{ id: 5, url: GEMINI }, { id: 9, url: GEMINI }], [5, 9]);
  content.claimSubagentTab(9);
  assert.equal(await content.sendToModelTab({ type: 'read_model_options' }, 'gemini'), true);
  assert.equal(sent[0].id, 5);
});

/**
 * Effort is changed with `switch_model`, and a batch task can want a different
 * effort from the person at the keyboard. Routing that to the main lane would
 * change the model *the user* is mid-conversation with, from a job they are
 * not watching — so a session-addressed message goes to the session's tab, and
 * when it cannot, it does nothing at all.
 */
test('a batch session switches effort in its own tab, not the user\'s', async () => {
  const { sent } = stubChrome([{ id: 5, url: GEMINI }, { id: 9, url: GEMINI }]);
  content.claimSubagentTab(9, 'task-1');
  assert.equal(
    await content.sendToModelTab({ type: 'switch_model' }, 'gemini', 'task-1'),
    true,
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, 9, "it went to the user's tab");
});

test('with no session it is still the main lane, which is what /effort wants', async () => {
  const { sent } = stubChrome([{ id: 5, url: GEMINI }, { id: 9, url: GEMINI }], [5, 9]);
  content.claimSubagentTab(9, 'task-1');
  assert.equal(await content.sendToModelTab({ type: 'switch_model' }, 'gemini'), true);
  assert.equal(sent[0].id, 5);
});

// The fallback is the bug, not the safety net.
test('a session whose tab is gone does nothing, rather than using the user\'s', async () => {
  const { sent } = stubChrome([{ id: 5, url: GEMINI }]);
  content.claimSubagentTab(999, 'task-gone');
  assert.equal(
    await content.sendToModelTab({ type: 'switch_model' }, 'gemini', 'task-gone'),
    false,
  );
  assert.equal(sent.length, 0, "it fell back to the user's tab");
});

test('an unknown session does not reach the main lane either', async () => {
  const { sent } = stubChrome([{ id: 5, url: GEMINI }]);
  assert.equal(
    await content.sendToModelTab({ type: 'switch_model' }, 'gemini', 'never-started'),
    false,
  );
  assert.equal(sent.length, 0);
});

test('matchesModelUrl knows a site from a lookalike', () => {
  assert.equal(content.matchesModelUrl(GEMINI, 'gemini'), true);
  assert.equal(content.matchesModelUrl('https://chatgpt.com/c/1', 'chatgpt'), true);
  assert.equal(content.matchesModelUrl('https://example.com/', 'gemini'), false);
  assert.equal(content.matchesModelUrl(undefined, 'gemini'), false);
});

/**
 * The user's own Gemini tabs.
 *
 * The agent types a system prompt and a task into the tab it picks, and scrapes
 * the reply back out. Picking a conversation the person opened for themselves
 * means their chat history gets our prompts in it and we read their thread.
 *
 * `pickMainTab` used to fall back to the newest matching tab — its own comment
 * called that "how a lane adopts the tab the user opened themselves" — and
 * because `mainTabs` was module state, every service-worker recycle put it back
 * in exactly that position. Recycling is routine here (the reconnect cadence
 * has a 30-second floor), so adopting the user's tab was the ordinary path.
 */
test('a Gemini tab the user opened is never adopted', async () => {
  // Their tab is open; we have opened nothing.
  stubChrome([{ id: 42, url: GEMINI }], []);
  assert.equal(await content.pickMainTab('gemini'), null,
    "the agent would have typed into the user's own conversation");
});

test('with both open, only ours is a candidate', async () => {
  stubChrome([{ id: 42, url: GEMINI }, { id: 7, url: GEMINI }], [7]);
  const tab = await content.pickMainTab('gemini');
  assert.equal(tab.id, 7, 'the newest tab won again, and it was theirs');
});

test('ownership survives the service worker being recycled', async () => {
  const stub = stubChrome([{ id: 42, url: GEMINI }, { id: 7, url: GEMINI }], [7]);
  assert.equal((await content.pickMainTab('gemini')).id, 7);

  // Chrome recycles the worker: module state goes, `chrome.storage.session`
  // stays. This is the moment the old code forgot and re-adopted.
  const revived = await import(`../../src/background/content.js?${Math.random()}`);
  assert.equal(stub.session.agentOwnedTabs.includes(7), true, 'ownership was never written down');
  assert.equal((await revived.pickMainTab('gemini')).id, 7,
    'a recycled worker forgot its own tab and was free to take the user\'s');
});

test('a tab we open is ours from then on', async () => {
  const { created } = stubChrome([{ id: 42, url: GEMINI }], []);
  const opened = await content.ensureModelTab('gemini');
  assert.equal(created.length, 1, 'it used the user\'s tab instead of opening one');
  assert.equal(opened.id, created[0].id);
  assert.equal(await content.isOwnedTab(opened.id), true);

  // And it is the one picked next time, with the user's tab still open.
  assert.equal((await content.pickMainTab('gemini')).id, created[0].id);
});

test('closing our tab gives up the claim', async () => {
  const stub = stubChrome([{ id: 7, url: GEMINI }], [7]);
  assert.equal((await content.pickMainTab('gemini')).id, 7);
  content.forgetTab(7);
  await new Promise((r) => setTimeout(r, 5));   // releaseOwnedTab is async
  assert.equal(stub.session.agentOwnedTabs.includes(7), false);
});

// Storage can fail — a private window, or a context without it. Owning nothing
// costs a fresh tab; owning everything costs somebody's chat history.
test('unreadable storage owns nothing rather than everything', async () => {
  stubChrome([{ id: 42, url: GEMINI }], []);
  globalThis.chrome.storage.session.get = async () => { throw new Error('nope'); };
  assert.equal(await content.pickMainTab('gemini'), null);
});
