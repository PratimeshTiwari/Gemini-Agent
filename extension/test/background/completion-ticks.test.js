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

/**
 * Wait for the thing to have happened, not for a length of time.
 *
 * `await elapse(TICK * 2.5)` then `assert.ok(ticks.length >= 2)` leaves **20ms**
 * of margin at a 40ms cadence, and under a full-suite run a 40ms timer drifts
 * further than that. This file failed roughly one run in five on load and passed
 * 3/3 in isolation — which is the signature of an assertion measuring the
 * machine rather than the code.
 *
 * `CLAUDE.md` records the same lesson twice: the frame-budget harness was
 * rewritten to wait on observed output for exactly this reason, and an earlier
 * version of this very file asserted `>= 3` ticks four milliseconds before the
 * deadline. The generous ceiling costs nothing when the code is right — it
 * returns on the first satisfying observation — and only a slow failure when it
 * is wrong.
 */
async function until(predicate, { timeoutMs = TICK * 40, everyMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await elapse(everyMs);
  }
  return predicate();
}

/**
 * The count settled on, after giving a wrong one time to appear.
 *
 * For "exactly N" the hazard runs the other way: asserting too early passes
 * against a ticker that was about to fire again. So wait for N, then hold long
 * enough that an N+1 would have landed.
 */
async function settledCount(list, expected) {
  await until(() => list.length >= expected);
  await elapse(TICK * 2);
  return list.length;
}

let mod;
beforeEach(async () => {
  stubChrome();
  mod = await import('../../src/background/content.js');
});
afterEach(() => { mod.stopCompletionTicks(7); });

test('ticks the tab on the service worker\'s own clock', async () => {
  const ticks = stubChrome();
  mod.startCompletionTicks(7, TICK);

  const mine = () => ticks.filter((t) => t.tabId === 7 && t.type === 'tick_completion');
  assert.ok(await until(() => mine().length >= 2),
    `expected at least 2 ticks, got ${mine().length}`);
});

test('stops as soon as the tab says the turn is over', async () => {
  // Watching for the first tick, finished after it.
  const ticks = stubChrome((n) => ({ watching: n < 2 }));
  mod.startCompletionTicks(7, TICK);
  // Long enough that a ticker which ignored the answer would fire a THIRD
  // time. At 5s it would not have, and this assertion passed against a
  // mutant with the stop removed — it was measuring the interval, not the
  // stop.
  assert.equal(await settledCount(ticks, 2), 2,
    `should stop on the first "not watching", got ${ticks.length}`);
});

test('stops when the tab stops answering at all', async () => {
  const ticks = stubChrome(() => new Error('Receiving end does not exist'));
  mod.startCompletionTicks(7, TICK);

  assert.equal(await settledCount(ticks, 1), 1, 'a dead tab is not worth ticking');
});

test('keeps ticking an older content script that answers undefined', async () => {
  // A tab still running a pre-tick_completion script. Falling back to the
  // throttled path there is exactly the wrong response.
  const ticks = stubChrome(() => undefined);
  mod.startCompletionTicks(7, TICK);

  assert.ok(await until(() => ticks.length >= 2),
    `should keep ticking, got ${ticks.length}`);
});

test('starting twice does not double the cadence', async () => {
  const ticks = stubChrome();
  mod.startCompletionTicks(7, TICK);
  mod.startCompletionTicks(7, TICK);
  // An upper bound needs the interval to actually have run, or it passes
  // against a doubled cadence that simply had not fired yet.
  await until(() => ticks.length >= 2);
  await elapse(TICK);

  assert.ok(ticks.length <= 4, `one ticker per tab, got ${ticks.length}`);
});

test('stopCompletionTicks is safe for a tab that was never started', () => {
  assert.doesNotThrow(() => mod.stopCompletionTicks(999));
});

test('confirms fast when the tab says it is one observation from done', async () => {
  // The latency this exists to remove. Measured over 74 real turns, every
  // `complete` landed on a ~2000ms boundary because a finished reply was only
  // noticed on the next slow tick — a turn that ended at 4.2s was delivered
  // at 6s, and requiring a second consecutive quiet check added another whole
  // interval on top.
  const ticks = stubChrome(() => ({ watching: true, confirmSoon: true }));
  mod.startCompletionTicks(7, TICK);
  await elapse(TICK * 3);

  /*
   * The slow cadence cannot reach 6 in this window — it fires 3 times — while
   * the confirming look, at a quarter of the interval, gives about 9.
   *
   * The margin is the point. This asserted `>= 3` after `TICK * 1.6`, where a
   * slow tick fires once and the fast ones land at exactly 50ms and 60ms of a
   * 64ms window: the third tick and the deadline were 4ms apart, so ordinary
   * scheduler jitter failed it about one run in five. A wall-clock driver with
   * no margin measures the machine's load, not the code — the same lesson the
   * frame-budget harness already learned.
   */
  assert.ok(ticks.length >= 6, `expected fast re-checks, got ${ticks.length}`);
});

test('does not poll fast while the model is still writing', async () => {
  // Slow is correct during generation: a fast poll there buys nothing and
  // just burns messages into the tab.
  const ticks = stubChrome(() => ({ watching: true, confirmSoon: false }));
  mod.startCompletionTicks(7, TICK);
  await elapse(TICK * 2.5);

  assert.ok(ticks.length <= 3, `expected the slow cadence, got ${ticks.length}`);
});

/**
 * Stopping a turn has to stop the confirming look too.
 *
 * The confirm was a bare `setTimeout` nobody held, and `stopCompletionTicks`
 * cleared only the interval — so a turn stopped from outside (the tab closed,
 * the session ended, the next turn starting) left a scheduled tick to fire into
 * a tab whose turn was over.
 *
 * The costly half is the next turn. `startCompletionTicks` stops the old ticker
 * and installs a new one, so an orphaned confirm firing afterwards finds
 * `completionTickers.has(tabId)` true again and schedules another — a second
 * fast chain beside the real one, at the *previous* turn's cadence, with no
 * handle anywhere to stop it. It compounds once per turn.
 *
 * Found by widening an unrelated timing window until the leak reached the next
 * test, which is the only reason anything noticed: a stray message costs
 * nothing visible, and the doubling is invisible until you count.
 */
test('stopping a turn cancels a confirm that was already scheduled', async () => {
  const ticks = stubChrome(() => ({ watching: true, confirmSoon: true }));
  mod.startCompletionTicks(7, TICK);

  // Long enough for the first tick to land and schedule its confirm.
  await elapse(TICK * 1.25);
  const atStop = ticks.length;
  assert.ok(atStop >= 1, 'nothing ticked, so there is no confirm to cancel');

  mod.stopCompletionTicks(7);
  await elapse(TICK * 3);

  assert.equal(ticks.length, atStop, `${ticks.length - atStop} ticks fired after the turn was stopped`);
});

/*
 * And the compounding case, which is the one that costs something. A second
 * turn on the same tab must run at one cadence, not two.
 */
test('a new turn does not inherit the previous turn\'s confirm chain', async () => {
  const first = stubChrome(() => ({ watching: true, confirmSoon: true }));
  mod.startCompletionTicks(7, TICK);
  await elapse(TICK * 1.25);
  assert.ok(first.length >= 1, 'the first turn never ticked');

  // The next turn: slow cadence, nothing to confirm. Anything above the slow
  // rate here is the old turn's orphaned chain still running.
  const second = stubChrome(() => ({ watching: true, confirmSoon: false }));
  mod.startCompletionTicks(7, TICK);
  await elapse(TICK * 2.5);

  assert.ok(second.length <= 3,
    `expected the slow cadence for the new turn, got ${second.length} — the old chain is still ticking`);
});

test('a fast confirmation stops with the turn, not after it', async () => {
  // confirmSoon on the first reply, finished on the next: the scheduled
  // follow-up must not keep the ticker alive past the end of the turn.
  const ticks = stubChrome((n) => (n === 1
    ? { watching: true, confirmSoon: true }
    : { watching: false }));
  mod.startCompletionTicks(7, TICK);
  await elapse(TICK * 4);

  assert.equal(ticks.length, 2, `should stop on the confirming check, got ${ticks.length}`);
});
