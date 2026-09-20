/**
 * A parked edit, answered from a front-end, all the way to the disk.
 *
 * `websocket-server.test.js` covers the two other things the loop parks on —
 * `ask_question` and `request_command_approval` — because both once deadlocked
 * a turn driven from the side panel: the loop awaited a promise, the panel
 * rendered nothing, and there was no inbound message type it could have
 * answered with. Reported as "the sidebar doesn't send prompts".
 *
 * `diff_response` is the third, and it had no test at all — for the one of the
 * three that **writes to disk**.
 *
 * So this drives the real chain: the real `edit_file` tool builds a real diff
 * through a real `DiffEngine`, `resolveDiff` parks on it, and the loop method
 * the bridge's `case 'diff_response'` calls is what answers. What is asserted
 * is the invariant `diff-approval.js` exists for — **three parties are told the
 * same thing**, and each has been the odd one out at some point:
 *
 *   - the disk, through `acceptDiff`
 *   - the model, through the returned tool result
 *   - the screen, through the mutated `resultTurn`
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MCPServer } from '../../src/mcp/mcp-server.js';
import { DiffEngine } from '../../src/core/diff-engine.js';
import { AgentLoop } from '../../src/core/agent-loop.js';
import { resolveDiff } from '../../src/core/diff-approval.js';

/** A workspace with one file, and a loop wired far enough to park on a diff. */
function bench() {
  const ws = fs.mkdtempSync(join(tmpdir(), 'diffresp-'));
  fs.mkdirSync(join(ws, '.agent'), { recursive: true });
  fs.writeFileSync(join(ws, 'a.txt'), 'original\n');

  const diffEngine = new DiffEngine(ws);
  const loop = Object.create(AgentLoop.prototype);
  Object.assign(loop, {
    workspace: ws,
    diffEngine,
    conversationHistory: [],
    // `requestDiffApproval` must exist, or `resolveDiff` takes its "no UI
    // wired: never block forever" path and rejects without ever parking —
    // which is correct behaviour and the opposite of what is under test here.
    callbacks: { sendToPanel() {}, requestDiffApproval() {} },
  });

  return {
    ws, loop, diffEngine,
    server: new MCPServer(ws, diffEngine),
    file: () => fs.readFileSync(join(ws, 'a.txt'), 'utf8').trim(),
    cleanup: () => fs.rmSync(ws, { recursive: true, force: true }),
  };
}

/** Park a turn on an approval, exactly as `_executeToolCalls` does. */
async function park(b) {
  const r = await b.server.executeTool('edit_file',
    { path: 'a.txt', edits: [{ oldText: 'original', newText: 'changed' }] }, { workspace: b.ws });

  assert.equal(r.success, true, `the fixture never produced a diff: ${r.error}`);
  const resultTurn = { success: true, result: 'diff generated' };
  const pending = resolveDiff(b.loop, {
    call: { name: 'edit_file' },
    diffResult: r.result,
    needsApproval: true,
    risk: { level: 'safe', reason: '' },
    resultTurn,
  });
  await new Promise((res) => setImmediate(res));
  return { pending, resultTurn, diffId: r.result.diffId };
}

/** Whatever the answer, the turn must not be left hanging on it. */
const settle = (pending) =>
  Promise.race([pending, new Promise((r) => setTimeout(() => r('DEADLOCK'), 2000))]);

describe('a diff answered from a front-end', () => {
  test('it parks until something answers', async () => {
    const b = bench();
    await park(b);

    assert.equal(typeof b.loop.pendingDiffResolve, 'function',
      'nothing can answer this, so the turn would hang forever');
    b.cleanup();
  });

  test('accept writes the file and tells everyone it did', async () => {
    const b = bench();
    const { pending, resultTurn, diffId } = await park(b);

    b.loop.handleDiffResponse('m1', { diffId, action: 'accept' });
    const out = await settle(pending);

    assert.notEqual(out, 'DEADLOCK');
    assert.equal(b.file(), 'changed', 'the disk never got the edit');
    assert.match(out.result, /APPROVED/, 'the model was not told it applied');
    assert.equal(out.failed, false);
    assert.equal(resultTurn.success, true, 'the transcript row still says pending');
    b.cleanup();
  });

  /*
   * The half that used to be wrong on screen. `resultTurn` is recorded when the
   * diff is *generated*, which succeeds whether or not anyone approves it — so
   * a rejected edit drew `✓ edit_file` in green on a change never written.
   */
  test('reject leaves the file alone and tells everyone that', async () => {
    const b = bench();
    const { pending, resultTurn, diffId } = await park(b);

    b.loop.handleDiffResponse('m1', { diffId, action: 'reject' });
    const out = await settle(pending);

    assert.notEqual(out, 'DEADLOCK');
    assert.equal(b.file(), 'original', 'a rejected edit was written anyway');
    assert.match(out.result, /REJECTED/);
    assert.equal(out.failed, true);
    assert.equal(resultTurn.success, false, 'the transcript drew a rejected edit as a success');
    b.cleanup();
  });
});

describe('it cannot be left hanging', () => {
  /*
   * An unknown diff id is the shape a stale front-end sends — a panel answering
   * about a diff from a turn that has already ended. `handleDiffResponse`
   * catches and resolves as a rejection rather than letting the error escape,
   * because the alternative is the deadlock this whole file is about.
   */
  test('an answer naming a diff that does not exist still settles the turn', async () => {
    const b = bench();
    const { pending } = await park(b);

    b.loop.handleDiffResponse('m1', { diffId: 'no-such-diff', action: 'accept' });
    const out = await settle(pending);

    assert.notEqual(out, 'DEADLOCK', 'a bad diff id left the turn parked forever');
    assert.equal(b.file(), 'original', 'it wrote something on an id it could not find');
    b.cleanup();
  });

  test('a malformed payload does not throw', async () => {
    const b = bench();
    await park(b);

    assert.doesNotThrow(() => b.loop.handleDiffResponse('m1', {}));
    b.cleanup();
  });
});

/**
 * The extension's own status line, which was dropped 21 times.
 *
 * `content.js` sends `{type:'status'}` when it cannot find your model tab and
 * is reopening one — the moment you most want a line on screen, because the CLI
 * otherwise just sits there. The bridge had no case for it, so it went to
 * `unknown_message`: **the largest single entry in this workspace's error log**,
 * found by reading the log rather than by anyone reporting it.
 *
 * `status` already existed in the other direction, which is why this is a relay
 * rather than a feature. It is a notification and nothing waits on it, so the
 * cost was a missing line — but `CLAUDE.md`'s rule is that dropping an unknown
 * type is not equally harmless for every type, and the way to find out which
 * kind you have is to handle it.
 */
describe('the extension can say what it is doing', () => {
  test('an inbound status reaches the screen', async () => {
    const seen = [];
    const loop = Object.create(AgentLoop.prototype);
    Object.assign(loop, {
      conversationHistory: [],
      callbacks: { sendToPanel: (m) => seen.push(m) },
      setBackgroundCallbacks() {},
    });
    const { WebSocketServer } = await import('../../src/bridge/websocket-server.js');
    const server = new WebSocketServer({ port: 0, agentLoop: loop });
    // `_handleMessage` returns at once for a client it does not know, so the
    // fixture registers one the way `_handleConnection` does.
    server.clients.set('client-1', { ws: null, type: 'extension', connectedAt: Date.now() });

    await server._handleMessage('client-1', {
      type: 'status', id: 'm1', payload: { message: '🌐 Reopening gemini in a new tab...' },
    });

    const row = seen.find((m) => m.type === 'status');
    assert.ok(row, 'the extension said something and nothing carried it to the screen');
    assert.match(row.payload.message, /Reopening/);
  });

  // The control: an actually-unknown type must still be reported as one, or the
  // relay has simply widened the hole rather than closed it.
  test('a genuinely unknown type is still reported', async () => {
    const loop = Object.create(AgentLoop.prototype);
    Object.assign(loop, {
      conversationHistory: [], callbacks: { sendToPanel() {} }, setBackgroundCallbacks() {},
    });
    const { WebSocketServer } = await import('../../src/bridge/websocket-server.js');
    const server = new WebSocketServer({ port: 0, agentLoop: loop });
    server.clients.set('client-1', { ws: null, type: 'extension', connectedAt: Date.now() });

    await assert.doesNotReject(() =>
      server._handleMessage('client-1', { type: 'not_a_real_type', id: 'm2', payload: {} }));
  });
});
