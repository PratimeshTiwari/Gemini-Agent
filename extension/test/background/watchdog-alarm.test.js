/**
 * The reconnect alarm has to outlive the connection.
 *
 * It used to be created in `scheduleRetry` and cleared in `stopKeepAlive`,
 * which runs on `onopen` — so a *healthy* bridge had no alarm at all. Chrome
 * can still evict a service worker that believes it is connected, and when it
 * does, the socket dies with it: `onclose` never runs inside a worker that is
 * already gone, and no timer survives it either. Nothing outside the browser
 * can wake a dead worker, so the extension simply stopped existing until the
 * user happened to focus a tab and `chrome.tabs.onUpdated` started it again.
 *
 * That is the reported symptom — "the prompt only sends once I open Chrome" —
 * and it is why these assertions are about the alarm being *present*, not
 * about reconnect timing, which `policy.test.js` already covers.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const socketSrc = join(here, '../../src/background/socket.js');

/** The slice of `chrome` the alarm path touches, with the alarms observable. */
function stubChrome() {
  const alarms = new Map();
  const log = [];
  globalThis.chrome = {
    alarms: {
      get: async (name) => alarms.get(name),
      create: (name, opts) => { log.push(['create', name, opts]); alarms.set(name, { name, ...opts }); },
      clear: async (name) => { log.push(['clear', name]); return alarms.delete(name); },
      onAlarm: { addListener() {} },
    },
    storage: { local: { get: async () => ({}) }, session: { get: async () => ({}), set: async () => {} } },
    runtime: { getPlatformInfo: async () => ({}), id: 'test' },
    tabs: { query: async () => [] },
  };
  return { alarms, log };
}

let ctx;
beforeEach(() => { ctx = stubChrome(); });

test('arms a periodic alarm when none exists', async () => {
  const { ensureWatchdogAlarm } = await import('../../src/background/socket.js');
  await ensureWatchdogAlarm();

  const created = ctx.log.filter(([op]) => op === 'create');
  assert.equal(created.length, 1, 'should create the alarm exactly once');
  const [, name, opts] = created[0];
  assert.equal(name, 'reconnect');
  assert.ok(opts.periodInMinutes > 0, 'must repeat, or it is a one-shot that fires once and is gone');
});

test('does not re-create an alarm that already exists', async () => {
  // `chrome.alarms.create` on an existing name REPLACES it and restarts the
  // period — so re-arming on every retry would push the backstop further away
  // each time it is most needed.
  const { ensureWatchdogAlarm } = await import('../../src/background/socket.js');
  await ensureWatchdogAlarm();
  await ensureWatchdogAlarm();
  await ensureWatchdogAlarm();

  assert.equal(ctx.log.filter(([op]) => op === 'create').length, 1);
});

test('a failing alarms API does not throw into the caller', async () => {
  globalThis.chrome.alarms.get = async () => { throw new Error('no alarms here'); };
  const { ensureWatchdogAlarm } = await import('../../src/background/socket.js');
  await assert.doesNotReject(() => ensureWatchdogAlarm());
});

test('stopKeepAlive does not disarm the watchdog', () => {
  // A source assertion, because this is the exact line that caused the bug and
  // re-adding it reads as ordinary cleanup in a diff. `stopKeepAlive` runs on
  // `onopen`; clearing the alarm there is what left a connected worker with no
  // way back.
  const src = readFileSync(socketSrc, 'utf8');
  const start = src.indexOf('function stopKeepAlive()');
  assert.ok(start > -1, 'stopKeepAlive should still exist');
  const body = src.slice(start, src.indexOf('\n}', start));
  assert.ok(
    !/alarms\.clear/.test(body),
    'stopKeepAlive must not clear the reconnect alarm — see this file\'s header',
  );
});
