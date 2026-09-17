/**
 * Reopening a past conversation, in both places that can ask for it.
 *
 * Two halves, and only the first is obvious. `history.jsonl` is the human's
 * record; the model's memory is the chat thread in the browser tab, and Gemini
 * keeps that thread's identity in the URL. Restoring the transcript alone
 * hands the model a conversation it has never seen and asks it to carry on —
 * the failure `chat-thread.js` exists to prevent.
 *
 * This lives on the loop rather than in the panel's message handler because
 * the CLI's `/history` needs the same thing, and two copies of "restore a
 * conversation" is how one of them forgets to file what is on screen first.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop } from '../../src/core/agent-loop.js';
import { SessionStore } from '../../src/storage/session-store.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'resume-'));
  const store = new SessionStore(dir);
  const loop = new AgentLoop({
    workspace: dir, mcpServer: {}, promptBuilder: {}, diffEngine: {}, riskClassifier: {},
  });
  const toExtension = [];
  loop._toExtension = (type, payload) => toExtension.push({ type, payload });
  loop.promptBuilder = { resetPromptState: () => {}, pendingRecap: undefined };
  return { dir, store, loop, toExtension };
}

/**
 * File a conversation so there is something to come back to.
 *
 * `rollover()` takes no arguments — it reads the thread off the store, which
 * is where `_recordThread` puts it — so the thread has to be set first. My
 * first version passed it to `rollover(thread)`, which silently did nothing
 * and made the thread assertion below fail for the wrong reason.
 */
function file(store, turns, thread) {
  store.saveHistory(turns);
  if (thread) store.setThread(thread);
  return store.rollover();
}

test('an unknown id is refused rather than silently doing nothing', () => {
  const { loop } = setup();
  const out = loop.resumeSessionById('no-such-session');

  assert.equal(out.ok, false);
  assert.match(out.message, /no session/i);
});

test('restores the transcript', () => {
  const { store, loop } = setup();
  const turns = [{ role: 'user', content: 'first' }, { role: 'agent', content: 'second' }];
  const id = file(store, turns);

  const out = loop.resumeSessionById(id);

  assert.equal(out.ok, true);
  assert.equal(loop.conversationHistory.length, 2);
  assert.equal(loop.conversationHistory[0].content, 'first');
});

test('points the tab back at the thread when there was one', () => {
  const { store, loop, toExtension } = setup();
  const id = file(store, [{ role: 'user', content: 'x' }], { model: 'gemini', id: 'abc123' });

  const out = loop.resumeSessionById(id);

  assert.equal(out.ok, true);
  const opened = toExtension.find((m) => m.type === 'open_thread');
  assert.ok(opened, 'the thread is the memory — reopen it rather than describe it');
  assert.equal(opened.payload.thread.id, 'abc123');
  assert.equal(loop.promptBuilder.pendingRecap, null, 'and no recap, which would be a paraphrase of it');
});

test('falls back to a recap when the session never reached a thread', () => {
  const { store, loop, toExtension } = setup();
  const turns = [{ role: 'user', content: 'x' }];
  const id = file(store, turns);           // no thread recorded

  const out = loop.resumeSessionById(id);

  assert.equal(out.ok, true);
  assert.equal(toExtension.filter((m) => m.type === 'open_thread').length, 0,
    'there is no thread to open');
  assert.ok(Array.isArray(loop.promptBuilder.pendingRecap),
    'so the next message has to carry what happened');
});

test('files what is on screen before restoring, instead of destroying it', () => {
  // The mistake that made `--sessions` useless: resuming used to overwrite the
  // live conversation, so the thing you were in the middle of was gone.
  const { dir, store, loop } = setup();
  const oldId = file(store, [{ role: 'user', content: 'the older one' }]);

  const live = new SessionStore(dir);
  live.saveHistory([{ role: 'user', content: 'what is on screen right now' }]);
  loop.sessionStore = live;

  loop.resumeSessionById(oldId);

  const filed = new SessionStore(dir).listSessions();
  const kept = filed.some((s) => s.id !== oldId);
  assert.ok(kept, 'the conversation that was on screen should have been filed, not lost');
});
