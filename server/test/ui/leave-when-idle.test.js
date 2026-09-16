/**
 * A restart must not go out from under a turn that is still running.
 *
 * Reported from use: switching workspace mid-turn killed the process, the
 * browser kept generating into a socket nobody was holding, and the reply was
 * simply never drawn. "It stopped and did not output" — and it is silent,
 * because from the transcript's point of view the turn just never finished.
 *
 * Every restart path had it: `/restart`, `/workspace`, and `/update`, which was
 * written the same way an hour earlier.
 *
 * True concurrency is not the fix and is not available: a restart is *why*
 * these paths exist — every collaborator keyed on the workspace is rebuilt by
 * restarting. So the turn is allowed to finish, and `esc` is the way to have it
 * now, because that clears `isProcessing` and this notices.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { leaveWhenIdle } from '../../src/ui/hooks/use-slash-commands.js';

/** A stand-in for the agent loop, plus a recorded exit. */
function ctx(isProcessing) {
  const exits = [];
  const agentLoop = { isProcessing };
  return { agentLoop, exits, arg: { agentLoop, exit: (code) => exits.push(code) } };
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

describe('leaveWhenIdle', () => {
  test('an idle agent leaves immediately', () => {
    const c = ctx(false);
    leaveWhenIdle(75, c.arg);
    assert.deepEqual(c.exits, [75], 'it waited when there was nothing to wait for');
  });

  test('a running turn is not cut off', async () => {
    const c = ctx(true);
    leaveWhenIdle(75, c.arg);
    await tick(600);
    assert.deepEqual(c.exits, [], 'the turn was killed mid-flight — the reported bug');
  });

  test('and the restart happens once the turn finishes', async () => {
    const c = ctx(true);
    leaveWhenIdle(75, c.arg);
    await tick(600);
    c.agentLoop.isProcessing = false;      // the turn completed
    await tick(600);
    assert.deepEqual(c.exits, [75], 'the deferred restart never happened');
  });

  test('esc is the escape hatch, for free', async () => {
    // `esc` sends `:stop`, which clears `isProcessing` — the same thing the
    // turn completing does, so no second mechanism was needed.
    const c = ctx(true);
    leaveWhenIdle(75, c.arg);
    await tick(500);
    c.agentLoop.isProcessing = false;      // :stop
    await tick(500);
    assert.deepEqual(c.exits, [75]);
  });

  test('it says so, but only when there is a wait', () => {
    const idle = ctx(false);
    let told = 0;
    leaveWhenIdle(75, idle.arg, { announce: () => { told += 1; } });
    assert.equal(told, 0, 'it announced a wait that was not happening');

    const busy = ctx(true);
    leaveWhenIdle(75, busy.arg, { announce: () => { told += 1; } });
    assert.equal(told, 1);
  });

  test('it leaves exactly once, however long the turn ran', async () => {
    const c = ctx(true);
    leaveWhenIdle(75, c.arg);
    c.agentLoop.isProcessing = false;
    await tick(1400);                       // several poll intervals
    assert.deepEqual(c.exits, [75], 'the interval was not cleared');
  });

  test('no agent loop at all still leaves', () => {
    const exits = [];
    leaveWhenIdle(0, { exit: (code) => exits.push(code) });
    assert.deepEqual(exits, [0]);
  });
});
