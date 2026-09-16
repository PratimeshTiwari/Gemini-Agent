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

/** The slice of `chrome` these paths touch, over a fake set of open tabs. */
function stubChrome(tabs) {
  const open = new Map(tabs.map((t) => [t.id, t]));
  const sent = [];
  const created = [];
  globalThis.chrome = {
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
  return { open, sent, created };
}

let content;
beforeEach(async () => {
  // Fresh module state per test: the lane maps are module-level.
  content = await import(`../../src/background/content.js?${Math.random()}`);
});

test('with one tab open, that is the lane\'s tab', async () => {
  stubChrome([{ id: 5, url: GEMINI }]);
  const tab = await content.pickMainTab('gemini');
  assert.equal(tab.id, 5);
});

test('a subagent tab is never picked for the main lane', async () => {
  stubChrome([{ id: 5, url: GEMINI }, { id: 9, url: GEMINI }]);
  content.claimSubagentTab(9);        // 9 is newer, and used to win
  const tab = await content.pickMainTab('gemini');
  assert.equal(tab.id, 5, 'the user\'s prompt would have gone into the subagent\'s chat');
});

test('the lane keeps the tab it used last, not the newest one', async () => {
  const { open } = stubChrome([{ id: 5, url: GEMINI }]);
  assert.equal((await content.pickMainTab('gemini')).id, 5);
  // The user opens a second Gemini tab. The conversation is still in the first.
  open.set(11, { id: 11, url: GEMINI });
  assert.equal((await content.pickMainTab('gemini')).id, 5,
    'moving tabs mid-session restates context the old tab already had');
});

test('a closed tab is released, and the lane adopts another', async () => {
  const { open } = stubChrome([{ id: 5, url: GEMINI }, { id: 11, url: GEMINI }]);
  assert.equal((await content.pickMainTab('gemini')).id, 11);
  open.delete(11);
  assert.equal((await content.pickMainTab('gemini')).id, 5);
});

test('a tab that navigated away is no longer the lane\'s, id or not', async () => {
  const { open } = stubChrome([{ id: 5, url: GEMINI }]);
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
  const { open } = stubChrome([{ id: 5, url: GEMINI }, { id: 9, url: GEMINI }]);
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
  const { created } = stubChrome([{ id: 5, url: GEMINI }]);
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
  const { sent } = stubChrome([{ id: 5, url: GEMINI }, { id: 9, url: GEMINI }]);
  content.claimSubagentTab(9);
  await content.triggerNewChatInModel({ targetModel: 'gemini' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, 5, 'a new chat would have wiped a subagent mid-turn');
  assert.equal(sent[0].message.type, 'new_chat');
});

test('the mode picker is read in the lane\'s tab', async () => {
  const { sent } = stubChrome([{ id: 5, url: GEMINI }, { id: 9, url: GEMINI }]);
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
  const { sent } = stubChrome([{ id: 5, url: GEMINI }, { id: 9, url: GEMINI }]);
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
