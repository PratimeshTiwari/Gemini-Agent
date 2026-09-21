import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { AgentLoop } from '../../src/core/agent-loop.js';

/**
 * Resuming has to reach the browser, and from the launch flags it did not.
 *
 * `/history` and the side panel both ran `resumeSessionById`, which restores
 * the transcript, sets `chatThread`, sends `open_thread` and — only if there is
 * no thread — arms a recap. `--resume` and `--continue` called the *storage*
 * method and stopped, so the transcript came back while the tab opened a fresh
 * conversation and the model was told nothing about either. Reported from use
 * with the tab on `/app/9120588e72a0b099` receiving a turn-0 system prompt.
 *
 * The invariant these pin is the one that was broken: a resumed session ends up
 * with **either** a reopened thread **or** a recap. Never neither.
 */

/** The method under test, on a bare prototype — it touches no collaborators. */
function loopWith(state) {
  const loop = Object.create(AgentLoop.prototype);
  const sent = [];
  Object.assign(loop, {
    conversationHistory: [],
    chatThread: null,
    promptBuilder: { pendingRecap: null },
    _backgroundCallbacks: { sendToPanel: (m) => sent.push(m) },
    callbacks: null,
    ...state,
  });
  return { loop, sent };
}

const TURNS = [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }];
const THREAD = { model: 'gemini', id: '9120588e72a0b099' };

test('resumeThreadOnConnect', async (t) => {
  await t.test('a resumed session with a thread reopens it', () => {
    const { loop, sent } = loopWith({
      _resumeOnConnect: true, conversationHistory: TURNS, chatThread: THREAD,
    });
    assert.equal(loop.resumeThreadOnConnect(), 'thread');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'open_thread');
    assert.deepEqual(sent[0].payload.thread, THREAD);
    assert.equal(loop.promptBuilder.pendingRecap, null,
      'the thread holds the real history; a recap beside it is noise');
  });

  await t.test('a resumed session with no thread arms a recap instead', () => {
    const { loop, sent } = loopWith({
      _resumeOnConnect: true, conversationHistory: TURNS, chatThread: null,
    });
    assert.equal(loop.resumeThreadOnConnect(), 'recap');
    assert.equal(sent.length, 0);
    assert.deepEqual(loop.promptBuilder.pendingRecap, TURNS);
  });

  // The bug itself, as an assertion: one or the other, never neither.
  await t.test('it is never silently neither', () => {
    for (const chatThread of [THREAD, null]) {
      const { loop, sent } = loopWith({
        _resumeOnConnect: true, conversationHistory: TURNS, chatThread,
      });
      loop.resumeThreadOnConnect();
      const opened = sent.some((m) => m.type === 'open_thread');
      const recapped = Boolean(loop.promptBuilder.pendingRecap);
      assert.ok(opened !== recapped, 'exactly one of open_thread / recap must happen');
      assert.ok(opened || recapped, 'a resumed session reached the model in neither way');
    }
  });

  await t.test('a fresh session does nothing at all', () => {
    const { loop, sent } = loopWith({ conversationHistory: TURNS, chatThread: THREAD });
    assert.equal(loop.resumeThreadOnConnect(), null);
    assert.equal(sent.length, 0);
    assert.equal(loop.promptBuilder.pendingRecap, null);
  });

  await t.test('an empty transcript is not resumed into', () => {
    const { loop, sent } = loopWith({ _resumeOnConnect: true, chatThread: THREAD });
    assert.equal(loop.resumeThreadOnConnect(), null);
    assert.equal(sent.length, 0);
  });

  // The extension reconnects freely. Pulling the tab back to where the session
  // started, mid-session, would discard whatever it had moved on to.
  await t.test('it drains once, however many times a browser identifies', () => {
    const { loop, sent } = loopWith({
      _resumeOnConnect: true, conversationHistory: TURNS, chatThread: THREAD,
    });
    assert.equal(loop.resumeThreadOnConnect(), 'thread');
    assert.equal(loop.resumeThreadOnConnect(), null);
    assert.equal(loop.resumeThreadOnConnect(), null);
    assert.equal(sent.filter((m) => m.type === 'open_thread').length, 1);
  });

  // `_toExtension` drops a message when neither callback set exists, the way
  // `_notify` used to. Clearing the flag there would lose the resume outright.
  await t.test('with nowhere to send yet, the intent is held rather than lost', () => {
    const loop = Object.create(AgentLoop.prototype);
    Object.assign(loop, {
      _resumeOnConnect: true,
      conversationHistory: TURNS,
      chatThread: THREAD,
      promptBuilder: { pendingRecap: null },
      callbacks: null,
      _backgroundCallbacks: null,
    });
    assert.equal(loop.resumeThreadOnConnect(), null);
    assert.equal(loop._resumeOnConnect, true, 'the flag was spent with nobody listening');

    const sent = [];
    loop._backgroundCallbacks = { sendToPanel: (m) => sent.push(m) };
    assert.equal(loop.resumeThreadOnConnect(), 'thread');
    assert.equal(sent.length, 1);
  });
});

test('the launch flags arm it, and a fresh start does not', async (t) => {
  const roots = [];
  const workspace = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-'));
    roots.push(dir);
    return dir;
  };
  t.after(() => roots.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

  const build = (opts) => new AgentLoop({
    workspace: workspace(),
    mcpServer: {}, promptBuilder: null, diffEngine: {}, riskClassifier: {},
    editor: 'true', agentSourceDir: process.cwd(), taskManager: {},
    ...opts,
  });

  await t.test('--continue arms the reopen', () => {
    assert.equal(build({ continueSession: true })._resumeOnConnect, true);
  });

  await t.test('--resume <id> arms the reopen', () => {
    assert.equal(build({ resumeSessionId: 'nope' })._resumeOnConnect, true);
  });

  // A fresh start files the old session deliberately. Adopting its thread would
  // reopen the conversation the user just chose to leave.
  await t.test('a plain start does not, and does not adopt a stored thread', () => {
    const loop = build({});
    assert.ok(!loop._resumeOnConnect);
    assert.equal(loop.chatThread, null);
    assert.equal(loop.resumeThreadOnConnect(), null);
  });
});

test('the bridge is what drains it', () => {
  // Derived from the catalog this would be comparing the code to itself, so it
  // reads the dispatching source — the same shape as LOOP_DISPATCHED. If the
  // call moves, this must move with it.
  const src = fs.readFileSync(
    new URL('../../src/bridge/websocket-server.js', import.meta.url), 'utf-8',
  );
  assert.match(src, /resumeThreadOnConnect\?\.\(\)/,
    'nothing drains the launch resume, so --resume reaches no browser');
  const identify = src.slice(src.indexOf("client.type === 'extension'"));
  assert.ok(
    identify.indexOf('resumeThreadOnConnect') < identify.indexOf('_handleMessage') + 4000,
    'the drain must hang off an extension identifying, not off socket open',
  );
});
