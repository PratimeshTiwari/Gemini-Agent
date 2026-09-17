/**
 * Waiting for the bridge to answer, instead of guessing how long it takes.
 *
 * Every wait on the send path was a flat `setTimeout`: 4000ms after opening a
 * subagent tab, 1500ms after a new main tab loaded, 1000ms after re-injecting.
 * A fixed sleep is wrong in both directions — it burns seconds on a warm
 * machine and still lands too early on a cold one, where the send arrives
 * before the listener exists and is reported as an unreachable tab.
 *
 * The two-tier answer is the part worth pinning. Gating only on `canType`
 * would turn a changed composer selector from "the send fails with a real
 * error" into "every turn burns its whole budget first", so the tail of the
 * budget accepts a merely-alive script.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/** `chrome` reduced to the one call `waitForBridge` makes. */
function stubChrome(reply) {
  let calls = 0;
  globalThis.chrome = {
    tabs: {
      sendMessage: async (tabId, msg) => {
        calls += 1;
        const r = reply(calls, msg);
        if (r instanceof Error) throw r;
        return r;
      },
      query: async () => [],
    },
    storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}) } },
    runtime: { id: 'test', getPlatformInfo: async () => ({}) },
    alarms: { get: async () => undefined, create() {}, clear: async () => {}, onAlarm: { addListener() {} } },
    scripting: { executeScript: async () => {} },
  };
  return () => calls;
}

let waitForBridge;
beforeEach(async () => {
  stubChrome(() => ({ ready: true, canType: true }));
  ({ waitForBridge } = await import('../../src/background/content.js'));
});

test('returns as soon as the composer is there, without burning the budget', async () => {
  stubChrome(() => ({ ready: true, canType: true }));
  const t0 = Date.now();
  const ok = await waitForBridge(1, 4000);
  const elapsed = Date.now() - t0;

  assert.equal(ok, true);
  // The whole point: a ready tab costs a round trip, not the budget. The old
  // path slept 4000ms here unconditionally.
  assert.ok(elapsed < 500, `should return promptly, took ${elapsed}ms`);
});

test('keeps waiting while the script answers but the composer is absent', async () => {
  // Ready at once, composer only on the fourth ping.
  const calls = stubChrome((n) => ({ ready: true, canType: n >= 4 }));
  const ok = await waitForBridge(1, 4000);

  assert.equal(ok, true);
  assert.ok(calls() >= 4, `should have polled until canType, polled ${calls()}`);
});

test('accepts a merely-alive script once the grace share has passed', async () => {
  // canType never becomes true — a changed composer selector.
  stubChrome(() => ({ ready: true, canType: false }));
  const t0 = Date.now();
  const ok = await waitForBridge(1, 600);
  const elapsed = Date.now() - t0;

  assert.equal(ok, true, 'must degrade to the send-and-see-the-real-error path');
  assert.ok(elapsed >= 600 * 0.6, `should not give up before the grace share, took ${elapsed}ms`);
  assert.ok(elapsed < 600, `and should not wait the whole budget, took ${elapsed}ms`);
});

test('returns false when nothing is listening at all', async () => {
  stubChrome(() => new Error('Could not establish connection'));
  const ok = await waitForBridge(1, 300);
  assert.equal(ok, false);
});

test('a throwing sendMessage is retried, not fatal', async () => {
  // No listener for the first two pings, then the script mounts.
  const calls = stubChrome((n) => (n <= 2 ? new Error('no listener') : { ready: true, canType: true }));
  const ok = await waitForBridge(1, 3000);

  assert.equal(ok, true);
  assert.ok(calls() >= 3, 'should have kept pinging past the throws');
});
