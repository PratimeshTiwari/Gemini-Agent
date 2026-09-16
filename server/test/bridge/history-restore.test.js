/**
 * Giving a freshly-opened panel the conversation it cannot read.
 *
 * Reported as "I reopened the panel and the chat got cleared". It never was:
 * `SessionStore` writes every turn to disk twice, on every turn. But the panel
 * is a browser page with no filesystem, so it starts from an empty DOM and
 * nothing had ever offered it the record — the same shape as the task list.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionStore } from '../../src/storage/session-store.js';
import { WebSocketServer } from '../../src/bridge/websocket-server.js';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hist-'));
  process.env.AGENT_CLI_HOME = join(dir, 'home');
});
afterEach(() => {
  delete process.env.AGENT_CLI_HOME;
  rmSync(dir, { recursive: true, force: true });
});

/** The bridge's sender, over a real store, with the socket recorded. */
function send(turns) {
  const store = new SessionStore(dir);
  if (turns) store.saveHistory(turns);
  const server = Object.create(WebSocketServer.prototype);
  server.agentLoop = { sessionStore: store };
  const sent = [];
  server._send = (_ws, m) => sent.push(m);
  server._sendHistory({});
  return sent;
}

describe('_sendHistory', () => {
  test('the conversation comes back', () => {
    const sent = send([
      { role: 'user', content: 'can you list files' },
      { role: 'assistant', content: 'Here they are.' },
    ]);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'history');
    assert.deepEqual(sent[0].payload.turns, [
      { role: 'user', content: 'can you list files' },
      { role: 'assistant', content: 'Here they are.' },
    ]);
  });

  // They are a transcript of machinery, they are most of the bytes, and a
  // restored view of them is a wall of JSON where a conversation should be.
  test('tool calls and results are left on disk', () => {
    const sent = send([
      { role: 'user', content: 'go' },
      { role: 'tool', content: '{"huge":"json"}' },
      { role: 'system', content: 'something internal' },
      { role: 'assistant', content: 'done' },
    ]);
    assert.deepEqual(sent[0].payload.turns.map((t) => t.role), ['user', 'assistant']);
  });

  test('`agent` is normalised to `assistant`, as the panel draws it', () => {
    const sent = send([{ role: 'agent', content: 'hello' }]);
    assert.equal(sent[0].payload.turns[0].role, 'assistant');
  });

  test('empty turns are not turns', () => {
    const sent = send([
      { role: 'user', content: '   ' },
      { role: 'assistant', content: '' },
      { role: 'user', content: 'real' },
    ]);
    assert.deepEqual(sent[0].payload.turns.map((t) => t.content), ['real']);
  });

  // One message across a socket into a page: someone reopening a panel wants
  // to see where they were, not six weeks of it.
  test('only the tail is sent, and it says how much it kept back', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ role: 'user', content: `turn ${i}` }));
    const sent = send(many);
    assert.equal(sent[0].payload.turns.length, 40);
    assert.equal(sent[0].payload.total, 60);
    assert.equal(sent[0].payload.turns[39].content, 'turn 59', 'it kept the oldest, not the newest');
  });

  test('a first run sends nothing at all', () => {
    assert.deepEqual(send(null), []);
    assert.deepEqual(send([]), []);
  });

  // A panel with no history is the ordinary first-run case, not an error.
  test('an unreadable store is silent, not a throw', () => {
    const server = Object.create(WebSocketServer.prototype);
    server.agentLoop = { sessionStore: { loadHistory() { throw new Error('gone'); } } };
    const sent = [];
    server._send = (_ws, m) => sent.push(m);
    assert.doesNotThrow(() => server._sendHistory({}));
    assert.deepEqual(sent, []);
  });

  test('no session store at all is survivable', () => {
    const server = Object.create(WebSocketServer.prototype);
    server.agentLoop = {};
    const sent = [];
    server._send = (_ws, m) => sent.push(m);
    assert.doesNotThrow(() => server._sendHistory({}));
    assert.deepEqual(sent, []);
  });
});

/**
 * A panel that opens *after* the socket is already up.
 *
 * `_sendHistory` runs on connect, and opening the side panel does not
 * reconnect anything — the service worker holds one socket for the whole
 * browser session. So a panel opened afterwards is a fresh page arriving in
 * the middle of an existing connection, and the connect-time send had already
 * happened, to a page that no longer exists.
 *
 * Reported as "opening and closing the sidebar does not persist the chat",
 * which is exactly how it looked: every other reopen showed the welcome screen
 * while the conversation was plainly still running in the Gemini tab.
 */
describe('a panel can ask for the conversation', () => {
  const bridge = (turns) => {
    const store = new SessionStore(dir);
    if (turns) store.saveHistory(turns);
    const server = Object.create(WebSocketServer.prototype);
    server.agentLoop = { sessionStore: store };
    const sent = [];
    const ws = {};
    server.clients = new Map([['c1', { ws, type: 'extension' }]]);
    server._send = (_ws, m) => sent.push(m);
    return { server, sent };
  };

  test('get_history answers with the conversation', async () => {
    const { server, sent } = bridge([
      { role: 'user', content: 'walk me through the bridge' },
      { role: 'assistant', content: 'It types into a tab.' },
    ]);
    await server._handleMessage('c1', { type: 'get_history' });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'history');
    assert.equal(sent[0].payload.turns.length, 2);
  });

  test('asking twice answers twice — the panel decides what to do with it', async () => {
    // A reopened panel and a resumed session both need an answer; suppressing
    // the second here would make the panel's own guard the only one, in the
    // one place that cannot see why it was asked.
    const { server, sent } = bridge([{ role: 'user', content: 'hi' }]);
    await server._handleMessage('c1', { type: 'get_history' });
    await server._handleMessage('c1', { type: 'get_history' });
    assert.equal(sent.length, 2);
  });

  test('a first run answers with nothing rather than an empty shell', async () => {
    const { server, sent } = bridge(null);
    await server._handleMessage('c1', { type: 'get_history' });
    assert.deepEqual(sent, []);
  });

  test('an unknown client is not a crash', async () => {
    const { server, sent } = bridge([{ role: 'user', content: 'hi' }]);
    await server._handleMessage('nobody', { type: 'get_history' });
    assert.deepEqual(sent, []);
  });
});
