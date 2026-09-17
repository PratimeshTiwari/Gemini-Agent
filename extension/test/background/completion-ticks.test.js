/**
 * Moving the turn's clock out of the tab.
 *
 * Completion was detected by a 2s `setInterval` in the content script, and
 * Chrome throttles page timers in a hidden tab. Measured on example.com in a
 * genuinely hidden tab (Chrome 152): that timer delivered **0.98/s** at 30s
 * hidden and **0.03/s** by 90s — roughly one tick per half-minute. Over the
 * same window a `MutationObserver` held **9.97/s** and `getBoundingClientRect`
 * returned a real box **296 times out of 296**.
 *
 * So the scrape was never the problem. The clock was, and it is the entire
 * reason the bridge activates the model tab and holds your focus for the
 * length of a turn. A service worker is not a tab and is not throttled, and
 * `chrome.tabs.sendMessage` is an event rather than a timer, so it is
 * delivered at full rate into a hidden page.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

function stubChrome(reply = () => ({ watching: true })) {
  const ticks = [];
  globalThis.chrome = {
    tabs: {
      sendMessage: async (tabId, msg) => {
        ticks.push({ tabId, type: msg.type });
        const r = reply(ticks.length, msg);
        if (r instanceof Error) throw r;
        return r;
      },
      query: async () => [],
      get: async (id) => ({ id, discarded: false, autoDiscardable: false }),
      update: async () => {},
      reload: async () => {},
    },
    storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}) } },
    runtime: { id: 'test', getPlatformInfo: async () => ({}) },
    alarms: { get: async () => undefined, create() {}, clear: async () => {}, onAlarm: { addListener() {} } },
    scripting: { executeScript: async () => {} },
  };
  return ticks;
}

/** Tests drive a 40ms cadence; production is 2000ms. */
const TICK = 40;
const elapse = (ms) => new Promise((r) => setTimeout(r, ms));

let mod;
beforeEach(async () => {
  stubChrome();
  mod = await import('../../src/background/content.js');
});
afterEach(() => { mod.stopCompletionTicks(7); });

test('ticks the tab on the service worker\'s own clock', async () => {
  const ticks = stubChrome();
  mod.startCompletionTicks(7, TICK);
  await elapse(TICK * 2.5);

  const mine = ticks.filter((t) => t.tabId === 7 && t.type === 'tick_completion');
  assert.ok(mine.length >= 2, `expected at least 2 ticks, got ${mine.length}`);
});

test('stops as soon as the tab says the turn is over', async () => {
  // Watching for the first tick, finished after it.
  const ticks = stubChrome((n) => ({ watching: n < 2 }));
  mod.startCompletionTicks(7, TICK);
  // Long enough that a ticker which ignored the answer would fire a THIRD
  // time. At 5s it would not have, and this assertion passed against a
  // mutant with the stop removed — it was measuring the interval, not the
  // stop.
  await elapse(TICK * 3.75);

  assert.equal(ticks.length, 2, `should stop on the first "not watching", got ${ticks.length}`);
});

test('stops when the tab stops answering at all', async () => {
  const ticks = stubChrome(() => new Error('Receiving end does not exist'));
  mod.startCompletionTicks(7, TICK);
  await elapse(TICK * 2.5);

  assert.equal(ticks.length, 1, 'a dead tab is not worth ticking');
});

test('keeps ticking an older content script that answers undefined', async () => {
  // A tab still running a pre-tick_completion script. Falling back to the
  // throttled path there is exactly the wrong response.
  const ticks = stubChrome(() => undefined);
  mod.startCompletionTicks(7, TICK);
  await elapse(TICK * 2.5);

  assert.ok(ticks.length >= 2, `should keep ticking, got ${ticks.length}`);
});

test('starting twice does not double the cadence', async () => {
  const ticks = stubChrome();
  mod.startCompletionTicks(7, TICK);
  mod.startCompletionTicks(7, TICK);
  await elapse(TICK * 2.5);

  assert.ok(ticks.length <= 3, `one ticker per tab, got ${ticks.length}`);
});

test('stopCompletionTicks is safe for a tab that was never started', () => {
  assert.doesNotThrow(() => mod.stopCompletionTicks(999));
});
