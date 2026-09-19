/**
 * Compaction is a handover, and it used not to hand anything over.
 *
 * `_compactHistory` rewrote `conversationHistory`, reset the prompt state and
 * reset `contextChars` — and sent nothing to the browser. The only sender of
 * `new_chat` was `/new`. So the tab stayed on the thread that still held every
 * turn just summarised, and three things followed:
 *
 * - the model's memory was unchanged; it still had all of it;
 * - `resetPromptState` sent a full turn-0 payload *plus* a summary of those
 *   turns into the thread that contains them;
 * - `contextChars`, documented as "everything ever typed into the browser tab",
 *   was reset to the summary's length while the tab kept the lot — so the
 *   auto-compaction threshold, the status bar and `/context` all described a
 *   thread that did not exist.
 *
 * The counter reset is only correct once there is genuinely a new thread. That
 * is the coupling these tests exist to pin: **no handover, no reset.**
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop } from '../../src/core/agent-loop.js';

/**
 * @param {'ok'|'refused'|'silent'} browser - what the extension does with
 *   `new_chat`: acks true, acks false, or never answers at all.
 */
function loopWith(browser) {
  const ws = mkdtempSync(join(tmpdir(), 'handover-'));
  mkdirSync(join(ws, '.agent'), { recursive: true });

  const l = Object.create(AgentLoop.prototype);
  l.workspace = ws;
  l.modelConfig = { main: 'gemini' };
  l.contextChars = 250000;
  l.chatThread = { model: 'gemini', id: 'OLD_THREAD' };
  l.promptBuilder = { resetPromptState() {} };
  l.sessionStore = { saveHistory() {}, appendTurn() {} };
  l.conversationHistory = Array.from({ length: 12 }, (_, i) => ({
    role: i % 2 ? 'agent' : 'user',
    content: `turn ${i} `.repeat(200),
    timestamp: Date.now(),
  }));
  l._executeSubagent = async () => ({ success: true, result: 'A short summary.' });

  const sent = [];
  l.callbacks = {
    sendToPanel: (m) => {
      sent.push(m);
      // Stand in for the extension. `setImmediate` because the real ack comes
      // back over a socket — resolving synchronously inside the send would let
      // a broken await pass.
      if (m.type === 'new_chat' && browser !== 'silent') {
        setImmediate(() => l.handleChatStarted({ ok: browser === 'ok' }));
      }
    },
  };
  return { l, sent, ws };
}

describe('compaction hands the thread over', () => {
  test('it asks the browser for a new conversation', async () => {
    const { l, sent, ws } = loopWith('ok');
    await l._compactHistory();

    assert.ok(sent.some((m) => m.type === 'new_chat'), 'nothing was sent to the tab');
    assert.equal(l.chatThread, null, 'the old thread is no longer the current one');
    rmSync(ws, { recursive: true, force: true });
  });

  test('the thread it left is kept, so it can be looked back at', async () => {
    const { l, ws } = loopWith('ok');
    await l._compactHistory();

    assert.deepEqual(l.previousThread, { model: 'gemini', id: 'OLD_THREAD' });
    rmSync(ws, { recursive: true, force: true });
  });

  test('on a real handover the counter starts again', async () => {
    const { l, ws } = loopWith('ok');
    await l._compactHistory();

    assert.ok(l.contextChars < 250000, 'a new thread carries only the summary');
    rmSync(ws, { recursive: true, force: true });
  });

  /*
   * The control the whole change rests on. A counter reset against a thread
   * that never changed is precisely the bug being fixed, so it must not happen
   * when the browser says no — and the user has to be told, because the tab in
   * front of them is still the old conversation.
   */
  test('a refused handover leaves the counter alone and says so', async () => {
    const { l, ws } = loopWith('refused');
    const out = await l._compactHistory();

    assert.equal(l.contextChars, 250000, 'the tab still holds every one of those characters');
    assert.match(out.message, /did not confirm/);
    rmSync(ws, { recursive: true, force: true });
  });

});

describe('startNewChat settles, always', () => {
  test('a second request supersedes the first without leaving it pending', async () => {
    const { l, ws } = loopWith('silent');

    const first = l.startNewChat({ timeoutMs: 60000 });
    const second = l.startNewChat({ timeoutMs: 50 });

    // The hang this ack exists to remove must not be reintroduced by the ack.
    assert.equal(await first, false, 'the superseded call answers rather than waiting');
    assert.equal(await second, false);
    rmSync(ws, { recursive: true, force: true });
  });

  /*
   * The timeout lives here rather than in the compaction tests above, because
   * this is what owns it: `_compactHistory` only has to do the right thing
   * with `false`, and a refused ack already exercises that. A browser that
   * never answers reaches the same `false` by the path that has no answer.
   */
  test('a browser that never answers resolves false rather than hanging', async () => {
    const { l, ws } = loopWith('silent');
    const answered = await Promise.race([
      l.startNewChat({ timeoutMs: 40 }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('hung')), 3000)),
    ]);
    assert.equal(answered, false);
    rmSync(ws, { recursive: true, force: true });
  });

  test('an ack with no request outstanding is ignored, not thrown', () => {
    const { l, ws } = loopWith('ok');
    assert.doesNotThrow(() => l.handleChatStarted({ ok: true }));
    rmSync(ws, { recursive: true, force: true });
  });
});
