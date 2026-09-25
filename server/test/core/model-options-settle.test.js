/**
 * "The browser cannot answer" is an answer, and the watchdog has to accept it.
 *
 * `requestModelOptions` arms an 8-second timer whose job is to notice *silence*.
 * When the extension answers "there is no tab I own to ask", that is not
 * silence — but nothing settled the timer, so it fired anyway and logged
 * `model_options_unanswered`, saying the picker "cannot be read" eight seconds
 * after the extension had said exactly why. Two ops, two flows, one cause.
 *
 * The method is borrowed off the prototype rather than built on a real loop:
 * it touches three fields, and a whole AgentLoop would bring a workspace, a
 * session store and a websocket server along to test a `clearTimeout`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop } from '../../src/core/agent-loop.js';

const settleModelOptions = AgentLoop.prototype.settleModelOptions;

function loopWithWatchdog(extra = {}) {
  const loop = {
    notices: [],
    fired: false,
    modelOptions: [{ label: 'Pro', selected: true }],
    _pendingEffortSwitch: null,
    _notify(text) { this.notices.push(text); },
    ...extra,
  };
  loop._modelOptionsWatchdog = setTimeout(() => { loop.fired = true; }, 5);
  return loop;
}

/** Let the watchdog fire if it is still armed. */
const tick = () => new Promise((r) => setTimeout(r, 25));

test('a refusal disarms the watchdog', async () => {
  const loop = loopWithWatchdog();
  settleModelOptions.call(loop, 'no gemini tab this extension owns');
  await tick();

  assert.equal(loop.fired, false, 'the same cause is about to be logged a second time');
  assert.equal(loop._modelOptionsWatchdog, null);
});

// The negative control: without it this file passes against a `settle` that
// does nothing, as long as the timer happens not to be armed.
test('and an unsettled watchdog really does fire', async () => {
  const loop = loopWithWatchdog();
  await tick();
  assert.equal(loop.fired, true);
});

test('the last known list survives — it is better than nothing', () => {
  const loop = loopWithWatchdog();
  settleModelOptions.call(loop, 'the picker did not open');

  assert.deepEqual(loop.modelOptions, [{ label: 'Pro', selected: true }],
    'a failure to ask overwrote what we already knew');
});

test('a waiting /effort is told, once, and stops waiting', () => {
  const loop = loopWithWatchdog({ _pendingEffortSwitch: 'pro' });
  settleModelOptions.call(loop, 'the picker did not open');

  assert.equal(loop.notices.length, 1);
  assert.match(loop.notices[0], /could not read its model picker/);
  assert.match(loop.notices[0], /the picker did not open/,
    'the extension said why and the row did not pass it on');
  assert.equal(loop._pendingEffortSwitch, null,
    'a pending switch left armed is applied to the next list that arrives, '
    + 'long after the user stopped expecting it');
});

// The background poll is nobody's question. CLAUDE.md: a warning per minute
// about a picker you are not currently setting is one people learn to skip.
test('the once-a-turn poll says nothing', () => {
  const loop = loopWithWatchdog();
  settleModelOptions.call(loop, 'the picker did not open');
  assert.deepEqual(loop.notices, []);
});

test('it works with no reason given', () => {
  const loop = loopWithWatchdog({ _pendingEffortSwitch: 'pro' });
  settleModelOptions.call(loop);
  assert.equal(loop.notices.length, 1);
  assert.doesNotMatch(loop.notices[0], /null|undefined/);
});
