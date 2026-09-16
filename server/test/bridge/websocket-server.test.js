import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer as WS } from 'ws';
import { WebSocket } from 'ws';
import { isAllowedOrigin, WebSocketServer as WebSocketServerClass } from '../../src/bridge/websocket-server.js';

test('isAllowedOrigin — who may open a socket', async (t) => {
  await t.test('the browser extension may', () => {
    assert.equal(isAllowedOrigin('chrome-extension://abcdefghijklmnop'), true);
    assert.equal(isAllowedOrigin('moz-extension://1234'), true);
    assert.equal(isAllowedOrigin('safari-web-extension://x'), true);
  });

  // A page can open ws://127.0.0.1:7777 from the user's own browser, and it
  // arrives over loopback like anything else. Browsers cannot forge Origin,
  // so this is the only thing standing between a website and a shell.
  await t.test('a web page may not', () => {
    for (const origin of ['https://evil.com', 'http://localhost:3000', 'null', 'file://']) {
      assert.equal(isAllowedOrigin(origin), false, origin);
    }
  });

  // Only a browser sends Origin. Everything else — curl, a test, the CLI's own
  // tooling — is a process that already had to be on this machine.
  await t.test('a non-browser client may', () => {
    assert.equal(isAllowedOrigin(undefined), true);
    assert.equal(isAllowedOrigin(''), true);
  });

  await t.test('a lookalike scheme does not slip through', () => {
    assert.equal(isAllowedOrigin('https://chrome-extension.evil.com'), false);
    assert.equal(isAllowedOrigin('chrome-extensionx://abc'), false);
  });
});

/** Bind a throwaway server the same way start() does, and report its address. */
function listen(opts) {
  return new Promise((resolve) => {
    const wss = new WS({ port: 0, ...opts });
    wss.on('listening', () => resolve(wss));
  });
}

test('the bridge is reachable only from this machine', async (t) => {
  // `new WS({ port })` binds to `::` — every interface, including the LAN.
  // This is the regression guard for the thing that was actually shipped.
  await t.test('binding without a host would listen on every interface', async () => {
    const wss = await listen({});
    assert.equal(wss.address().address, '::', 'ws default — this is what we must not do');
    wss.close();
  });

  await t.test('the bridge binds to loopback', async () => {
    const wss = await listen({ host: '127.0.0.1' });
    assert.equal(wss.address().address, '127.0.0.1');
    wss.close();
  });
});

test('verifyClient refuses a page and admits the extension', async (t) => {
  const wss = await listen({
    host: '127.0.0.1',
    verifyClient: ({ origin }, done) =>
      (isAllowedOrigin(origin) ? done(true) : done(false, 403, 'nope')),
  });
  const url = `ws://127.0.0.1:${wss.address().port}`;

  const connect = (origin) => new Promise((resolve) => {
    const ws = new WebSocket(url, origin ? { origin } : undefined);
    ws.on('open', () => { ws.close(); resolve('open'); });
    ws.on('error', () => resolve('refused'));
  });

  await t.test('a website is refused', async () => {
    assert.equal(await connect('https://evil.com'), 'refused');
  });

  await t.test('the extension gets through', async () => {
    assert.equal(await connect('chrome-extension://abcdefghijklmnop'), 'open');
  });

  wss.close();
});

/**
 * The side panel answering a turn that is parked.
 *
 * `ask_question` and a risky `run_command` both `await new Promise(...)` in the
 * agent loop with no timeout, and send the prompt out through `sendToPanel`.
 * The CLI drew those and answered them; the panel had no renderer and — more
 * to the point — there was no inbound message type it could have answered
 * with, so a turn driven from the panel stopped at the first question and
 * never resumed. The panel's own send button stays disabled behind
 * `isWaitingForResponse`, so the visible symptom is a panel that has stopped
 * accepting prompts entirely.
 *
 * These pin the way back in. The resolvers themselves were already there.
 */
test('a parked turn can be answered from the side panel', async (t) => {
  /** Enough of the server to run `_handleMessage`, with a recording loop. */
  const bridge = () => {
    const calls = [];
    const server = Object.create(WebSocketServerClass.prototype);
    server.clients = new Map([['c1', { type: 'extension', ws: {} }]]);
    server.agentLoop = {
      answerQuestion: (a) => calls.push(['answerQuestion', a]),
      cancelQuestion: () => calls.push(['cancelQuestion']),
      answerCommandApproval: (action, command) => calls.push(['answerCommandApproval', action, command]),
    };
    return { server, calls };
  };

  await t.test('an answer resolves the question', async () => {
    const { server, calls } = bridge();
    await server._handleMessage('c1', { type: 'question_response', payload: { answer: 'Postgres' } });
    assert.deepEqual(calls, [['answerQuestion', 'Postgres']]);
  });

  await t.test('a batch answer is passed through as the array', async () => {
    const { server, calls } = bridge();
    const answer = [{ question: 'Which db?', answer: 'Postgres' }, { question: 'Port?', answer: '5432' }];
    await server._handleMessage('c1', { type: 'question_response', payload: { answer } });
    assert.deepEqual(calls[0][1], answer);
  });

  // Dismissing must still resolve. `cancelQuestion` answers the model with an
  // instruction to assume and continue, because rejecting or doing nothing
  // leaves the promise pending — which is the hang this whole test is about.
  await t.test('dismissing cancels rather than answering', async () => {
    const { server, calls } = bridge();
    await server._handleMessage('c1', { type: 'question_response', payload: { cancelled: true } });
    assert.deepEqual(calls, [['cancelQuestion']]);
  });

  await t.test('a command approval carries its action and the command', async () => {
    const { server, calls } = bridge();
    await server._handleMessage('c1', {
      type: 'command_approval_response',
      payload: { action: 'allow_always', command: 'npm test' },
    });
    // The command rides along because `allow_always` writes it into the
    // persistent rules and the server keeps no copy of what was asked.
    assert.deepEqual(calls, [['answerCommandApproval', 'allow_always', 'npm test']]);
  });

  await t.test('a malformed payload does not throw', async () => {
    const { server } = bridge();
    await server._handleMessage('c1', { type: 'question_response' });
    await server._handleMessage('c1', { type: 'command_approval_response' });
  });
});
