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
