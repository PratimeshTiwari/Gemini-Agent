import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer as WS } from 'ws';
import { WebSocket } from 'ws';
import { isAllowedOrigin } from './websocket-server.js';

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
