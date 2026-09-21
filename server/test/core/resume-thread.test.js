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

/**
 * The other half: a thread we walked away from.
 *
 * The stored chat id could only move forward. `setThread(null)` is a no-op by
 * design, `startNewChat()` nulled memory and never touched disk, and a brand-new
 * chat is `/app` with no id until its first exchange — so nothing could record
 * "we left that conversation" even by accident. Between a handover and the next
 * reply, memory said "no thread" and `session-meta.json` still named the
 * abandoned one, and both resume paths read the disk.
 *
 * `/compact` and `/new` call `startNewChat()` today, so this was live before any
 * bootstrap ladder existed to make it common.
 */
import { SessionStore } from '../../src/storage/session-store.js';
import { planResume } from '../../src/core/chat-thread.js';

const OLD = { model: 'gemini', id: 'OLD_abandoned_chat' };
const NEW = { model: 'gemini', id: 'NEW_live_chat' };

function store(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thread-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new SessionStore(dir);
}

test('the stored chat id', async (t) => {
  await t.test('clearThread forgets the id and remembers that we left it', (t) => {
    const s = store(t);
    s.setThread(OLD);
    assert.deepEqual(s.getThread(), OLD);

    s.clearThread(OLD);
    assert.equal(s.getThread(), null, 'the abandoned id is still being reported as current');
    assert.deepEqual(s.getLeftThread(), OLD, 'the handover cannot be looked back from');
  });

  // The guard is load-bearing: a brand-new chat's URL has no id, and letting
  // that wipe a good record is the opposite bug. Clearing must be asked for.
  await t.test('setThread(null) is still a no-op', (t) => {
    const s = store(t);
    s.setThread(OLD);
    s.setThread(null);
    s.setThread({ model: 'gemini' });          // a /app URL, no id
    s.setThread(undefined);
    assert.deepEqual(s.getThread(), OLD, 'the guard was weakened');
  });

  await t.test('a new id supersedes the left one', (t) => {
    const s = store(t);
    s.setThread(OLD);
    s.clearThread(OLD);
    s.setThread(NEW);
    assert.deepEqual(s.getThread(), NEW);
    assert.equal(s.getLeftThread(), null, 'left is only meaningful while there is no current thread');
  });

  await t.test('a session that never had one reports neither', (t) => {
    const s = store(t);
    assert.equal(s.getThread(), null);
    assert.equal(s.getLeftThread(), null);
  });
});

test('startNewChat keeps disk and memory in step', async (t) => {
  await t.test('the abandoned id is cleared before the handover is attempted', (t) => {
    const s = store(t);
    s.setThread(OLD);

    const loop = Object.create(AgentLoop.prototype);
    Object.assign(loop, {
      chatThread: { ...OLD },
      sessionStore: s,
      _toExtension() {},
      _pendingNewChat: null,
    });
    loop.startNewChat({ timeoutMs: 10 });

    assert.equal(loop.chatThread, null);
    assert.equal(s.getThread(), null, 'disk still named the conversation we just left');
    assert.deepEqual(s.getLeftThread(), OLD);
    assert.deepEqual(loop.previousThread, OLD);
  });

  /*
   * The assertion that would have caught the whole thing.
   *
   * A handover, then the process ends before any reply carries a new id back.
   * Resuming must not point the tab at the conversation that was abandoned —
   * and it must still reach the model, by recap.
   */
  await t.test('resuming after a handover with no reply does not reopen it', (t) => {
    const s = store(t);
    s.setThread(OLD);
    s.clearThread(OLD);

    const sent = [];
    const loop = Object.create(AgentLoop.prototype);
    Object.assign(loop, {
      _resumeOnConnect: true,
      conversationHistory: TURNS,
      chatThread: s.getThread(),          // what the constructor reads
      promptBuilder: { pendingRecap: null },
      callbacks: null,
      _backgroundCallbacks: { sendToPanel: (m) => sent.push(m) },
    });

    assert.equal(loop.resumeThreadOnConnect(), 'recap');
    assert.equal(sent.filter((m) => m.type === 'open_thread').length, 0,
      'reopened a conversation the session had deliberately left');
    assert.deepEqual(loop.promptBuilder.pendingRecap, TURNS,
      'left the model with no idea what happened either');
  });
});

test('planResume tells the two empty states apart', async (t) => {
  await t.test('left is a replay, never a view', () => {
    const r = planResume(null, null, OLD);
    assert.equal(r.action, 'replay');
    assert.match(r.reason, /OLD_abandoned_chat/);
  });

  await t.test('never reached one is still a view', () => {
    assert.equal(planResume(null, null, null).action, 'view');
  });

  // The regression that matters most: matching ids must not out-rank the fact
  // that we walked away, or resume answers `continue` into a dead conversation
  // and suppresses the recap as well.
  await t.test('a live tab on the abandoned thread is not a continue', () => {
    assert.equal(planResume(null, OLD, OLD).action, 'replay');
  });

  await t.test('an unchanged thread is still a continue', () => {
    assert.equal(planResume(OLD, OLD, null).action, 'continue');
  });
});
