/**
 * The connection dot, and the argument preview — both reported from a
 * screenshot showing two panels of the same build disagreeing.
 *
 * `connection_status` is broadcast only when the socket *transitions*. A panel
 * opened while the socket is already up therefore receives nothing, and has
 * exactly one sample to go on: `get_status` at load. One sample is wrong by
 * construction — MV3 recycles the service worker constantly, and a worker woken
 * *by that very message* has no socket yet — so the floating window sat on
 * "Disconnected" over a working bridge with no way to find out otherwise.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const PANEL = resolve(dirname(fileURLToPath(import.meta.url)), '../../side-panel/panel.js');

function lift(names, extra = {}, prelude = '') {
  const src = readFileSync(PANEL, 'utf8');
  const take = (name) => {
    // The async form first: `indexOf('function x(')` also matches *inside*
    // `async function x(`, and slicing from there drops the keyword — the
    // lifted source then fails to parse on its own `await`.
    const asyncAt = src.indexOf(`async function ${name}(`);
    const from = asyncAt !== -1 ? asyncAt : src.indexOf(`function ${name}(`);
    if (from === -1) throw new Error(`${name} not found`);
    let depth = 0;
    for (let i = src.indexOf('{', from); i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) return src.slice(from, i + 1);
    }
    throw new Error(`${name} never closed`);
  };
  const dom = new JSDOM('<body><div id="stream"></div></body>');
  const sandbox = {
    document: dom.window.document,
    messageStream: dom.window.document.getElementById('stream'),
    scrollToBottom() {},
    ...extra,
  };
  // Module-level `let`s the lifted functions close over are not functions,
  // so they cannot be lifted — the caller declares them.
  const body = `${prelude}\n${names.map(take).join('\n')}\nreturn { ${names.join(', ')} };`;
  return { api: new Function(...Object.keys(sandbox), body)(...Object.values(sandbox)), dom };
}

describe('the connection dot reads the worker, not its own memory', () => {
  const build = (reply) => {
    const seen = [];
    const shown = [];
    const { api } = lift(['checkConnectionStatus'], {
      chrome: { runtime: { sendMessage: async (m) => { seen.push(m.type); return reply(m); } } },
      updateConnectionUI: (c) => shown.push(c),
    });
    return { api, seen, shown };
  };

  test('a connected worker shows connected', async () => {
    const { api, shown } = build(() => ({ success: true, connected: true }));
    await api.checkConnectionStatus();
    assert.deepEqual(shown, [true]);
  });

  test('a disconnected worker shows disconnected', async () => {
    const { api, shown } = build(() => ({ success: true, connected: false }));
    await api.checkConnectionStatus();
    assert.deepEqual(shown, [false]);
  });

  // The first check may be the thing that wakes the worker, so it asks for a
  // connection. Later checks must not — repeating it would restart the retry
  // ladder every few seconds and pin the backoff at its first rung forever.
  test('only the first check asks the worker to connect', async () => {
    const { api, seen } = build(() => ({ connected: false }));
    await api.checkConnectionStatus(true);
    assert.deepEqual(seen, ['get_status', 'connect']);

    const later = build(() => ({ connected: false }));
    await later.api.checkConnectionStatus();
    assert.deepEqual(later.seen, ['get_status'], 'a poll restarted the retry ladder');
  });

  test('an unreachable worker is disconnected, not a crash', async () => {
    const { api, shown } = build(() => { throw new Error('no receiving end'); });
    await api.checkConnectionStatus();
    assert.deepEqual(shown, [false]);
  });

  test('a reply with no connected field is not read as connected', async () => {
    const { api, shown } = build(() => ({ success: true }));
    await api.checkConnectionStatus();
    assert.deepEqual(shown, [false]);
  });
});

describe('the one-line argument preview', () => {
  const previewOf = (args) => {
    const { api, dom } = lift(['appendToolCall', 'escapeHtml']);
    api.appendToolCall('ask_question', args);
    return dom.window.document.querySelector('.tool-args')?.textContent
      ?? dom.window.document.getElementById('stream').textContent;
  };

  // What the screenshot showed: `questions: [object Object],[object Object]`.
  test('an array of objects is counted, never stringified', () => {
    const text = previewOf({ questions: [{ question: 'a' }, { question: 'b' }] });
    assert.doesNotMatch(text, /\[object Object\]/);
    assert.match(text, /questions: 2 items/);
  });

  test('one item reads as one item', () => {
    assert.match(previewOf({ questions: [{ question: 'a' }] }), /questions: 1 item\b/);
  });

  test('an object falls back to the field a reader recognises', () => {
    assert.match(previewOf({ target: { path: 'src/main.js' } }), /target: src\/main\.js/);
  });

  test('a long string is cut, not dropped', () => {
    const text = previewOf({ prompt: 'x'.repeat(200) });
    assert.match(text, /…/);
    assert.ok(text.length < 160, 'the whole prompt went into a one-line preview');
  });

  test('strings and numbers are unchanged', () => {
    assert.match(previewOf({ path: 'a.js', line: 12 }), /path: a\.js, line: 12/);
  });
});

/**
 * A panel that narrates its own connection state.
 *
 * The retry ladder fires repeatedly by design while the agent is not running,
 * and every tick appended "🔴 Disconnected from agent server" to the
 * transcript. A screenshot showed sixteen identical rows and no conversation
 * left on screen. The dot in the status bar had been saying the same thing the
 * whole time, quietly and in one row.
 */
describe('the connection is shown, not narrated', () => {
  const build = () => {
    const shown = [];
    const { api, dom } = lift(['appendStatus', 'escapeHtml', 'renderMarkdownish'], {
      scrollToBottom() {},
    }, 'let lastStatusText = "";');
    return { api, dom, shown };
  };

  test('the same status twice in a row is one row', () => {
    const { api, dom } = build();
    for (let i = 0; i < 16; i++) api.appendStatus('Disconnected from agent server');
    assert.equal(dom.window.document.querySelectorAll('.message-status').length, 1,
      'the panel filled with one repeated sentence');
  });

  test('a different status still gets its own row', () => {
    const { api, dom } = build();
    api.appendStatus('one');
    api.appendStatus('two');
    api.appendStatus('one');
    assert.equal(dom.window.document.querySelectorAll('.message-status').length, 3);
  });

  test('connection_status writes no row at all', () => {
    // Read the shipped switch rather than re-implementing it: the point is
    // that the case no longer calls appendStatus.
    const src = readFileSync(PANEL, 'utf8');
    const start = src.indexOf("case 'connection_status':");
    const body = src.slice(start, src.indexOf('break;', start));
    assert.doesNotMatch(body, /appendStatus/,
      'the transcript is narrating what the dot already says');
    assert.match(body, /updateConnectionUI/);
  });
});

describe('what a disconnected panel says when you try to use it', () => {
  test('it names both causes, because the panel cannot tell them apart', () => {
    const src = readFileSync(PANEL, 'utf8');
    const start = src.indexOf('function explainDisconnected(');
    const body = src.slice(start, src.indexOf('\n}', start));
    assert.match(body, /`agent`/, 'it should say how to start the agent');
    assert.match(body, /chrome:\/\/extensions/, 'it should say how to refresh a stale bridge');
    assert.match(body, /hard-refresh/i);
  });

  test('sending while disconnected explains instead of silently failing', () => {
    const src = readFileSync(PANEL, 'utf8');
    const start = src.indexOf('function sendMessage(');
    const body = src.slice(start, src.indexOf('\n}', start));
    assert.match(body, /if \(!isConnected\)/);
    assert.match(body, /explainDisconnected\(\)/);
  });
});
