/**
 * The extension, reduced to: connect, identify, answer prompts from a script.
 *
 * `verifyClient` requires a chrome-extension:// Origin, and the identify
 * payload must use `clientType` — not `client`, which is the mistake that has
 * cost this harness time before.
 */
const WebSocket = require(require('path').join(__dirname, '..', 'node_modules', 'ws'));

const port = Number(process.argv[2]);
const replies = JSON.parse(process.argv[3]); // array of strings, in order
const delay = Number(process.argv[4] || 300); // how long the 'model' takes
let n = 0;

const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
  origin: 'chrome-extension://fakefakefakefakefakefakefakefake',
  headers: { Origin: 'chrome-extension://fakefakefakefakefakefakefakefake' },
});

ws.on('open', () => {
  ws.send(JSON.stringify({
    id: 'id-1', type: 'identify',
    payload: { clientType: 'extension' }, timestamp: Date.now(),
  }));
  ws.send(JSON.stringify({
    id: 'id-2', type: 'tab_status',
    payload: { connectedModels: ['gemini'] }, timestamp: Date.now(),
  }));
  console.error('[fake] connected');
});

ws.on('message', (raw) => {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  if (msg.type !== 'inject_prompt') return;

  const content = replies[Math.min(n, replies.length - 1)];
  n += 1;
  console.error(`[fake] answering prompt #${n} with ${content.length} chars`);

  // A real reply lands after a beat, and the loop must see `complete`.
  setTimeout(() => {
    ws.send(JSON.stringify({
      id: `r-${n}`, type: 'gemini_response',
      payload: {
        content,
        complete: true,
        requestId: msg.payload?.requestId,
        isSubagent: Boolean(msg.payload?.isSubagent),
        tabUrl: 'https://gemini.google.com/app/fakethread01',
      },
      timestamp: Date.now(),
    }));
  }, delay);
});

ws.on('error', (e) => console.error('[fake] error', e.message));
