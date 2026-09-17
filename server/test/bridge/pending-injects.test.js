/**
 * A prompt dispatched while the extension is away must not be dropped.
 *
 * `broadcast` returns whether it reached anyone, and every caller ignored that
 * return — so `injectPrompt` with no extension connected wrote to no sockets
 * and vanished. The lane that sent it stayed busy and the loop sat there until
 * its seven-minute watchdog, with the user watching "Thinking…".
 *
 * This is the other half of "the prompt only sends when I open Chrome": the
 * worker gets evicted, the prompt is discarded, and by the time the user comes
 * back and the extension reconnects there is nothing left to deliver.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from '../../src/bridge/websocket-server.js';

/** A server with no socket of its own, so the delivery logic can be driven directly. */
function server() {
  const agentLoop = {
    workspace: '/tmp/nowhere',
    setBackgroundCallbacks() {},
  };
  return new WebSocketServer({ port: 0, agentLoop, githubHandler: null });
}

/** A fake connected client that records what it was sent. */
function attach(srv, type) {
  const received = [];
  srv.clients.set(`c-${type}-${srv.clients.size}`, {
    type,
    ws: { readyState: 1, OPEN: 1, send: (raw) => received.push(JSON.parse(raw)) },
  });
  return received;
}

test('delivers straight through when an extension is connected', () => {
  const srv = server();
  const ext = attach(srv, 'extension');

  assert.equal(srv.sendInjectPrompt({ prompt: 'hello' }), true);
  assert.equal(ext.length, 1);
  assert.equal(ext[0].type, 'inject_prompt');
  assert.equal(ext[0].payload.prompt, 'hello');
  assert.equal(srv.pendingInjects.length, 0, 'nothing to hold when it was delivered');
});

test('holds the prompt when no extension is connected', () => {
  const srv = server();
  // A panel is not an extension. This is the case that used to look like a
  // successful send because *a* client was attached.
  attach(srv, 'cli');

  assert.equal(srv.sendInjectPrompt({ prompt: 'held' }), false);
  assert.equal(srv.pendingInjects.length, 1);
});

test('flushes held prompts when the extension comes back', () => {
  const srv = server();
  srv.sendInjectPrompt({ prompt: 'first' });
  srv.sendInjectPrompt({ prompt: 'second' });
  assert.equal(srv.pendingInjects.length, 2);

  const ext = attach(srv, 'extension');
  assert.equal(srv.flushPendingInjects(), 2);

  assert.deepEqual(ext.map((m) => m.payload.prompt), ['first', 'second'], 'in the order they were queued');
  assert.equal(srv.pendingInjects.length, 0, 'the buffer is drained, not replayed forever');
});

test('drops a prompt whose turn the watchdog has already abandoned', () => {
  const srv = server();
  srv.sendInjectPrompt({ prompt: 'stale' });
  srv.sendInjectPrompt({ prompt: 'fresh' });
  // Older than the lane watchdog: the loop gave up on this turn long ago, and
  // typing it into Gemini now starts a conversation nobody is listening to.
  srv.pendingInjects[0].queuedAt = Date.now() - (8 * 60 * 1000);

  const ext = attach(srv, 'extension');
  assert.equal(srv.flushPendingInjects(), 1);
  assert.deepEqual(ext.map((m) => m.payload.prompt), ['fresh']);
});

test('the buffer is bounded', () => {
  const srv = server();
  for (let i = 0; i < 40; i += 1) srv.sendInjectPrompt({ prompt: `p${i}` });

  assert.ok(srv.pendingInjects.length <= 8, `bounded, got ${srv.pendingInjects.length}`);
  // The oldest go first: they are the ones closest to their watchdog.
  assert.equal(srv.pendingInjects.at(-1).message.payload.prompt, 'p39');
});

test('flushing with nothing held is a no-op', () => {
  const srv = server();
  attach(srv, 'extension');
  assert.equal(srv.flushPendingInjects(), 0);
});
