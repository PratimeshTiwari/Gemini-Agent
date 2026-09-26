/**
 * A model switch is a DOM interaction on a tab a turn may be using.
 *
 * `switchModelTo` was the one tab interaction in the system that did **not**
 * go through `extension-lock`. Everything else is serialised per lane exactly
 * because a tab can only do one thing at a time; this opened a menu whenever
 * it felt like it.
 *
 * Reported from use on 2026-09-24 with a screenshot: the turn-0 prompt sitting
 * in the composer, the mode picker open on top of it, nothing sent. The picker
 * overlays the composer, so the send button is behind it — `waitForSendButton`
 * finds a control it cannot click, burns its budget, and the turn is lost. The
 * next prompt then goes to whatever model was selected, because the switch
 * never landed either. Both halves of that report are this bug.
 *
 * **Deferred, not lane-holding, and that is the decision this file pins.**
 * Holding the lane would need an ack to release on, and an ack that never
 * arrives — a stale extension, a changed picker selector, both seen this week
 * — wedges the main lane for the rest of the session with every later prompt
 * vanishing into it. Deferring cannot fail that way: the worst case is a
 * switch one turn late, which the mismatch row already covers.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop } from '../../src/core/agent-loop.js';

/** Just enough loop to exercise the switch, with a lane whose busyness we set. */
const stub = (busy) => {
  const sent = [];
  const loop = Object.create(AgentLoop.prototype);
  Object.assign(loop, {
    modelConfig: { main: 'gemini', effort: 'high' },
    extensionLock: {
      busy,
      isBusy() { return this.busy; },
      release() { this.busy = false; },
    },
    _toExtension: (type, payload) => sent.push({ type, ...payload }),
  });
  return { loop, sent };
};

describe('switchModelTo waits for the tab', () => {
  test('an idle tab is switched immediately', () => {
    const { loop, sent } = stub(false);
    loop.switchModelTo('3.1 Pro');
    assert.deepEqual(sent, [{ type: 'switch_model', label: '3.1 Pro' }]);
  });

  test('a tab mid-turn is not interrupted', () => {
    const { loop, sent } = stub(true);
    loop.switchModelTo('3.5 Flash-Lite');
    assert.deepEqual(sent, [], 'nothing may reach the tab while a turn holds it');
    assert.equal(loop._pendingModelSwitch, '3.5 Flash-Lite', 'held, not dropped');
  });

  test('and it goes out when the turn hands the lane back', () => {
    const { loop, sent } = stub(true);
    loop.switchModelTo('3.5 Flash-Lite');
    loop._releaseExtension();
    assert.deepEqual(sent, [{ type: 'switch_model', label: '3.5 Flash-Lite' }]);
    assert.equal(loop._pendingModelSwitch, null, 'and is not sent twice');
  });

  /*
   * `release()` pumps the next queued prompt, so the lane can be busy again
   * the instant it is handed back. Asking again is cheaper than guessing, and
   * the switch stays pending for the release after that.
   */
  test('a lane that is busy again keeps the switch pending', () => {
    const { loop, sent } = stub(true);
    loop.switchModelTo('3.8 Flash');
    loop.extensionLock.release = () => {};          // release, then immediately busy
    loop._releaseExtension();
    assert.deepEqual(sent, []);
    assert.equal(loop._pendingModelSwitch, '3.8 Flash');

    loop.extensionLock.busy = false;
    loop._releaseExtension();
    assert.deepEqual(sent, [{ type: 'switch_model', label: '3.8 Flash' }]);
  });

  // A subagent's tab is its own and cannot collide with the main turn, so it
  // must not be made to wait behind one.
  test("a session's own tab is switched without waiting", () => {
    const { loop, sent } = stub(true);
    loop.switchModelTo('3.8 Flash', 'session-1');
    assert.deepEqual(sent, [{ type: 'switch_model', label: '3.8 Flash', sessionId: 'session-1' }]);
    assert.ok(!loop._pendingModelSwitch);
  });

  test('no label is no message', () => {
    const { loop, sent } = stub(false);
    loop.switchModelTo('');
    loop.switchModelTo(null);
    assert.deepEqual(sent, []);
  });
});
