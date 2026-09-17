/**
 * Repairing the tab between attempts, instead of giving up on it.
 *
 * A failed send reaches the server as `tab_unreachable`, and the server's
 * only answer is `abortExtensionWork()`: the turn dies. But nearly everything
 * that breaks a send is transient and local to the tab — the content script
 * was orphaned by an extension reload, the tab was discarded, the page
 * navigated, an interstitial appeared. Those are repairable.
 *
 * The order matters as much as the repairs. Re-injection is tried before a
 * reload because it is cheaper and fixes the commonest cause, and **nothing
 * opens a fresh tab**: a reload returns to the same `/app/<id>` and Gemini
 * still has the thread, while a new tab is a new conversation, and an
 * incremental prompt sent into one gets a confident answer to a question the
 * model never saw.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * @param {(attempt: number) => any} answer  what sendMessage does, per call
 */
function stubChrome(answer) {
  const log = [];
  let sends = 0;
  globalThis.chrome = {
    tabs: {
      sendMessage: async (tabId, msg) => {
        if (msg.type === 'ping') return { ready: true, canType: true };
        sends += 1;
        log.push(`send#${sends}`);
        const r = answer(sends);
        if (r instanceof Error) throw r;
        return r;
      },
      reload: async () => { log.push('reload'); },
      get: async (id) => ({ id, discarded: false, autoDiscardable: false }),
      update: async () => {},
      query: async () => [],
    },
    scripting: { executeScript: async () => { log.push('reinject'); } },
    storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}) } },
    runtime: { id: 'test', getPlatformInfo: async () => ({}) },
    alarms: { get: async () => undefined, create() {}, clear: async () => {}, onAlarm: { addListener() {} } },
  };
  return log;
}

let sendWithRepairs;
beforeEach(async () => {
  stubChrome(() => ({ success: true }));
  ({ sendWithRepairs } = await import('../../src/background/content.js'));
});

const MSG = { type: 'inject_prompt', payload: { prompt: 'hi' } };

test('a working tab costs exactly one send and no repairs', async () => {
  const log = stubChrome(() => ({ success: true }));
  assert.equal(await sendWithRepairs(1, MSG, 'gemini'), true);
  assert.deepEqual(log, ['send#1']);
});

test('an orphaned script is repaired by re-injection', async () => {
  const log = stubChrome((n) => (n === 1 ? new Error('Receiving end does not exist') : { success: true }));
  assert.equal(await sendWithRepairs(1, MSG, 'gemini'), true);
  assert.deepEqual(log, ['send#1', 'reinject', 'send#2'], 're-inject before anything heavier');
});

test('a wedged page is repaired by a reload', async () => {
  const log = stubChrome((n) => (n < 3 ? new Error('no listener') : { success: true }));
  assert.equal(await sendWithRepairs(1, MSG, 'gemini'), true);
  assert.deepEqual(log, ['send#1', 'reinject', 'send#2', 'reload', 'send#3']);
});

test('a content script reporting failure counts as a failure', async () => {
  // `{success:false}` is not an exception, and treating it as success was how
  // a silently-refused paste became a turn that waited out its watchdog.
  const log = stubChrome((n) => (n === 1 ? { success: false, error: 'composer missing' } : { success: true }));
  assert.equal(await sendWithRepairs(1, MSG, 'gemini'), true);
  assert.deepEqual(log, ['send#1', 'reinject', 'send#2']);
});

test('gives up after the reload, and never opens a fresh tab', async () => {
  const log = stubChrome(() => new Error('nope'));
  assert.equal(await sendWithRepairs(1, MSG, 'gemini'), false);
  assert.deepEqual(log, ['send#1', 'reinject', 'send#2', 'reload', 'send#3']);
  assert.ok(!log.includes('create'), 'a new tab is a new conversation — see the header');
});

test('an unknown model skips re-injection but still reloads', async () => {
  // There is no script path to inject, which must not swallow the reload.
  const log = stubChrome(() => new Error('nope'));
  assert.equal(await sendWithRepairs(1, MSG, 'nosuchmodel'), false);
  assert.deepEqual(log, ['send#1', 'reload', 'send#2']);
});
