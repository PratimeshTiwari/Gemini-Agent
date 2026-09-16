/**
 * Past conversations, reachable from the panel.
 *
 * The storage and the `--sessions` flag landed before there was any way to
 * reach them from here, which is the same as not having them — reported as "I
 * reopened the sidebar and there is no option to continue".
 *
 * Each row says whether resuming would **continue** or need a **recap**,
 * because those are different promises. The model's memory is the browser chat
 * thread, not our transcript: if the tab has moved on, the model was never part
 * of that conversation, and saying "resumed" without saying so produces
 * confident answers about work it never did.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const PANEL = resolve(dirname(fileURLToPath(import.meta.url)), '../../side-panel/panel.js');

function load() {
  const src = readFileSync(PANEL, 'utf8');
  const take = (name) => {
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
  const dom = new JSDOM('<body><div id="sessions-list"></div><div id="sessions-drawer"></div></body>');
  const sent = [];
  const sandbox = {
    document: dom.window.document,
    chrome: { runtime: { sendMessage: (m) => sent.push(m) } },
  };
  const names = ['escapeHtml', 'renderSessions'];
  const api = new Function(...Object.keys(sandbox),
    `${names.map(take).join('\n')}\nreturn { ${names.join(', ')} };`)(...Object.values(sandbox));
  return { api, doc: dom.window.document, window: dom.window, sent };
}

let panel;
beforeEach(() => { panel = load(); });

const session = (over = {}) => ({
  id: 'abc', title: 'why is the poller re-reading comments',
  turns: 12, updated: Date.parse('2026-09-16T10:00:00Z'), resume: 'replay', ...over,
});

describe('the drawer', () => {
  test('a row carries the title, the size and when', () => {
    panel.api.renderSessions({ sessions: [session()] });
    const row = panel.doc.querySelector('.sess').textContent.replace(/\s+/g, ' ');
    assert.match(row, /why is the poller re-reading comments/);
    assert.match(row, /12 turns/);
  });

  // The whole reason the thread id is recorded.
  test('it says which kind of resume this would be', () => {
    panel.api.renderSessions({
      sessions: [session({ id: 'a', resume: 'continue' }), session({ id: 'b', resume: 'replay' })],
    });
    const rows = [...panel.doc.querySelectorAll('.sess')].map((r) => r.textContent);
    assert.match(rows[0], /tab still holds this/);
    assert.match(rows[1], /needs a recap/);
  });

  test('clicking one asks the server to resume it, by id', () => {
    panel.api.renderSessions({ sessions: [session({ id: 'the-one' })] });
    panel.doc.querySelector('.sess').dispatchEvent(new panel.window.Event('click'));
    assert.deepEqual(panel.sent, [{ type: 'resume_session', payload: { id: 'the-one' } }]);
  });

  // "None yet" and "something went wrong" must not look the same.
  test('no sessions says so, and says how one is made', () => {
    panel.api.renderSessions({ sessions: [] });
    const text = panel.doc.querySelector('.drawer-empty').textContent;
    assert.match(text, /No past conversations/);
    assert.match(text, /\/new|restart/);
    assert.equal(panel.doc.querySelector('.sess'), null);
  });

  test('a malformed payload draws the empty state rather than throwing', () => {
    assert.doesNotThrow(() => panel.api.renderSessions(undefined));
    assert.doesNotThrow(() => panel.api.renderSessions({}));
    assert.ok(panel.doc.querySelector('.drawer-empty'));
  });

  test('a title is escaped, not rendered', () => {
    panel.api.renderSessions({ sessions: [session({ title: '<img src=x onerror=alert(1)>' })] });
    assert.equal(panel.doc.querySelector('.sess img'), null);
    assert.match(panel.doc.querySelector('.sess-title').textContent, /<img/);
  });

  test('a quote in an id cannot break out of the data attribute', () => {
    panel.api.renderSessions({ sessions: [session({ id: '" onmouseover="X' })] });
    const row = panel.doc.querySelector('.sess');
    assert.equal(row.hasAttribute('onmouseover'), false);
    assert.equal(row.dataset.id, '" onmouseover="X');
  });
});

/**
 * The two controls, and what they promise.
 *
 * `+` and `↺` rather than words: the header is narrow and both shapes are
 * already what people reach for. Neither is destructive — `+` **files** the
 * conversation it replaces, and `↺` is where it went — which is what makes a
 * one-click button reasonable at all.
 */
describe('the header controls', () => {
  const markup = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../side-panel/panel.html'), 'utf8');

  test('a new-chat button and a history button both exist', () => {
    assert.match(markup, /id="new-btn"[^>]*>\+</);
    assert.match(markup, /id="sessions-btn"/);
  });

  test('new chat asks for /new rather than clearing anything locally', () => {
    // Clearing the panel without telling the agent would leave the two
    // disagreeing about what conversation is open.
    const src = readFileSync(PANEL, 'utf8');
    const fn = src.slice(src.indexOf('function setupNewChat('));
    assert.match(fn, /command: 'new'/);
    assert.doesNotMatch(fn.slice(0, fn.indexOf('\n}')), /innerHTML\s*=\s*''/);
  });

  test('neither does anything while disconnected', () => {
    const src = readFileSync(PANEL, 'utf8');
    for (const name of ['setupNewChat', 'setupSessions']) {
      const fn = src.slice(src.indexOf(`function ${name}(`));
      assert.match(fn.slice(0, fn.indexOf('\n}\n')), /isConnected/, name);
    }
  });
});
