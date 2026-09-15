/**
 * Who gets the browser back after a turn.
 *
 * `src/background/` is ordinary JavaScript — tab bookkeeping, not DOM scraping —
 * so it runs under `node --test` with a stubbed `chrome`. These are the first
 * tests it has had; EXTENSION-PLAN phase 3 is the rest of them.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/** The slice of the `chrome` API this code touches, and a log of what it did. */
function stubChrome({ activeTabId }) {
  const updates = [];
  globalThis.chrome = {
    tabs: {
      query: async ({ active }) => (active && activeTabId !== null
        ? [{ id: activeTabId }]
        : []),
      update: async (id, props) => { updates.push({ id, ...props }); },
      sendMessage: async () => ({ success: true }),
    },
  };
  return updates;
}

let content;
beforeEach(async () => {
  // Fresh module state per test: the map of stolen focus is module-level.
  content = await import(`../../src/background/content.js?${Math.random()}`);
});

/** Take focus through the same call `trySendToTab` makes. */
async function takeFocus(modelTabId, fromTabId) {
  stubChrome({ activeTabId: fromTabId });
  content.rememberFocus(modelTabId, fromTabId);
}

test('nothing was taken, so nothing is given back', async () => {
  const updates = stubChrome({ activeTabId: 7 });
  await content.restoreFocusFrom(7);
  assert.deepEqual(updates, []);
});

test('focus goes back to the tab it was taken from', async () => {
  await takeFocus(42, 7);
  const updates = stubChrome({ activeTabId: 42 });   // the model tab still has it
  await content.restoreFocusFrom(42);
  assert.deepEqual(updates, [{ id: 7, active: true }]);
});

test('the user who moved on is left alone', async () => {
  await takeFocus(42, 7);
  // The user switched to some third tab while the reply was generating.
  const updates = stubChrome({ activeTabId: 99 });
  await content.restoreFocusFrom(42);
  assert.deepEqual(updates, [], 'pulling them back would be a second theft');
});

test('focus is restored once, not on every later message', async () => {
  await takeFocus(42, 7);
  stubChrome({ activeTabId: 42 });
  await content.restoreFocusFrom(42);
  const updates = stubChrome({ activeTabId: 42 });
  await content.restoreFocusFrom(42);
  assert.deepEqual(updates, []);
});

test('two tabs in flight each remember their own origin', async () => {
  await takeFocus(42, 7);    // the user's own turn
  await takeFocus(43, 8);    // a subagent, started from somewhere else

  let updates = stubChrome({ activeTabId: 43 });
  await content.restoreFocusFrom(43);
  assert.deepEqual(updates, [{ id: 8, active: true }]);

  updates = stubChrome({ activeTabId: 42 });
  await content.restoreFocusFrom(42);
  assert.deepEqual(updates, [{ id: 7, active: true }]);
});

test('forgetting a tab drops its claim on the focus', async () => {
  await takeFocus(42, 7);
  content.forgetFocusFrom(42);
  const updates = stubChrome({ activeTabId: 42 });
  await content.restoreFocusFrom(42);
  assert.deepEqual(updates, []);
});

test('a closed origin tab fails quietly', async () => {
  await takeFocus(42, 7);
  stubChrome({ activeTabId: 42 });
  chrome.tabs.update = async () => { throw new Error('No tab with id: 7'); };
  await content.restoreFocusFrom(42);   // must not reject
});
