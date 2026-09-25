/**
 * A picker that cannot be read is not a turn that has died.
 *
 * `discover_models` and `switch_model` are messages to the tab, not prompts —
 * they deliberately never take the extension lane, because reading the mode
 * picker is a question about the page. Their *failures*, though, arrive as
 * ordinary `error` payloads and fell through to the same two lines every other
 * extension error does:
 *
 *     this.agentLoop.isProcessing = false;
 *     this.agentLoop.abortExtensionWork();
 *
 * which clears the lane and abandons whatever prompt is in flight. So `/effort`
 * typed during a turn, or a picker whose menu would not open, killed the turn
 * underneath it — and the reason was filed under `flow: 'extension'`, nowhere
 * near the turn that stopped. CLAUDE.md already records the same shape twice
 * ("a local command must not touch a running turn").
 *
 * The second half is the double report. One unreachable tab produced
 * `discover_models` here and `model_options_unanswered` eight seconds later,
 * because the watchdog is about *silence* and a refusal is an answer. In
 * `.agent/logs/errors.jsonl` that is 13 and 36 of the same cause.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from '../../src/bridge/websocket-server.js';

/** Just enough loop to record what the bridge does to it. */
function fakeLoop() {
  const workspace = mkdtempSync(join(tmpdir(), 'picker-errors-'));
  return {
    workspace,
    isProcessing: true,
    aborted: false,
    settled: [],
    callbacks: null,
    setBackgroundCallbacks() {},
    abortExtensionWork() { this.aborted = true; },
    settleModelOptions(reason) { this.settled.push(reason ?? null); },
  };
}

/** Drive one message in, without opening a socket. */
async function deliver(loop, payload) {
  const bridge = new WebSocketServer({ port: 0, agentLoop: loop });
  bridge.clients.set('c1', { type: 'extension' });
  await bridge._handleMessage('c1', { type: 'error', payload });
  return bridge;
}

test('a picker failure leaves the turn alone', async (t) => {
  for (const op of ['discover_models', 'switch_model', 'focus_tab']) {
    await t.test(op, async () => {
      const loop = fakeLoop();
      await deliver(loop, { op, message: 'no gemini tab this extension owns', stage: 'tab' });

      assert.equal(loop.aborted, false, `${op} aborted the extension lane`);
      assert.equal(loop.isProcessing, true,
        `${op} declared the in-flight turn finished; the prompt is still out there`);
    });
  }
});

test('and it settles the watchdog, so one cause is logged once', async () => {
  const loop = fakeLoop();
  await deliver(loop, {
    op: 'discover_models',
    message: 'no gemini tab this extension owns',
    stage: 'tab',
  });

  assert.deepEqual(loop.settled, ['no gemini tab this extension owns'],
    'the 8s watchdog is still armed, so this will be reported again as silence');
});

/*
 * The negative control. Without it the test above passes for a version of the
 * bridge that never aborts for anything, which would be a far worse bug than
 * the one being fixed: a prompt that is never coming back would hold the lane
 * until the seven-minute watchdog.
 */
test('every other extension error still takes the lane back', async (t) => {
  for (const op of ['find_input', 'send', 'response_timeout', undefined]) {
    await t.test(String(op), async () => {
      const loop = fakeLoop();
      await deliver(loop, { op, message: 'the composer is gone' });

      assert.equal(loop.aborted, true, `${op} left the lane held`);
      assert.equal(loop.isProcessing, false);
      assert.deepEqual(loop.settled, [], 'a dead turn is not a picker answer');
    });
  }
});

test('a lost batch session is still handed to its own resolver', async () => {
  const loop = fakeLoop();
  loop.resolved = [];
  loop.resolveSubagent = (id, result) => loop.resolved.push([id, result]);

  await deliver(loop, { op: 'session_lost', requestId: 'r1', message: 'tab closed' });

  assert.deepEqual(loop.resolved, [['r1', { sessionLost: true }]]);
  assert.equal(loop.aborted, false);
});
