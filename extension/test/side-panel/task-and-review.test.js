/**
 * The plan and the review, where the person can actually see them.
 *
 * The terminal draws the checklist above the prompt because it reads
 * `.agent/artifacts/task.md` off disk every second. The side panel is a
 * browser page and cannot, so the panel was the one surface where the agent's
 * own plan was invisible — the half of the feature the user is meant to watch.
 * The server pushes it at turn boundaries instead.
 *
 * Both of these are *collapsed by default* on purpose. The value is "2 of 4,
 * and this is next" at a glance; the full list is a click away and must not
 * push the conversation off screen to show a plan already read.
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
  const dom = new JSDOM('<body><div id="stream"></div><footer id="input-area"></footer></body>');
  const doc = dom.window.document;
  const sandbox = {
    document: doc,
    messageStream: doc.getElementById('stream'),
    inputArea: doc.getElementById('input-area'),
    scrollToBottom() {},
  };
  const names = ['escapeHtml', 'renderMarkdownish', 'renderTaskList', 'splitReview', 'appendReview'];
  const api = new Function(...Object.keys(sandbox),
    `${names.map(take).join('\n')}\nreturn { ${names.join(', ')} };`)(...Object.values(sandbox));
  return { api, doc, window: dom.window };
}

let panel;
beforeEach(() => { panel = load(); });

const list = (items) => ({
  items,
  done: items.filter((i) => i.done).length,
  total: items.length,
});

describe('the checklist', () => {
  const FOUR = [
    { done: true, text: 'Read the bridge' },
    { done: true, text: 'Add the message type' },
    { done: false, text: 'Render it in the panel' },
    { done: false, text: 'Write the tests' },
  ];

  test('collapses to the count and the next unfinished item', () => {
    panel.api.renderTaskList(list(FOUR));
    const summary = panel.doc.querySelector('.task-summary').textContent.replace(/\s+/g, ' ').trim();
    assert.match(summary, /2\/4/);
    assert.match(summary, /Render it in the panel/, 'the next item is the one worth seeing');
  });

  test('the items are hidden until it is opened', () => {
    panel.api.renderTaskList(list(FOUR));
    const el = panel.doc.getElementById('task-list');
    assert.equal(el.classList.contains('open'), false);
    el.querySelector('.task-summary').dispatchEvent(new panel.window.Event('click'));
    assert.equal(el.classList.contains('open'), true);
    assert.equal(el.querySelector('.task-caret').textContent, '▾');
  });

  // A checklist is current state, not an event. Appending each version would
  // repeat the mistake the connection rows already made once.
  test('a second push replaces the row rather than adding one', () => {
    panel.api.renderTaskList(list(FOUR));
    panel.api.renderTaskList(list(FOUR.map((i) => ({ ...i, done: true }))));
    assert.equal(panel.doc.querySelectorAll('.task-list').length, 1);
    assert.match(panel.doc.querySelector('.task-summary').textContent, /4\/4/);
  });

  test('being open survives the next push', () => {
    panel.api.renderTaskList(list(FOUR));
    panel.doc.querySelector('.task-summary').dispatchEvent(new panel.window.Event('click'));
    panel.api.renderTaskList(list(FOUR));
    assert.equal(panel.doc.getElementById('task-list').classList.contains('open'), true,
      'it closed itself under someone reading it');
  });

  test('all done says so instead of naming a next item', () => {
    panel.api.renderTaskList(list(FOUR.map((i) => ({ ...i, done: true }))));
    assert.match(panel.doc.querySelector('.task-summary').textContent, /all done/);
  });

  // An empty row reads as "the agent has no plan" when it means "the agent
  // did not write one".
  test('nothing to show draws nothing', () => {
    panel.api.renderTaskList({ items: [], done: 0, total: 0 });
    panel.api.renderTaskList({});
    panel.api.renderTaskList(undefined);
    assert.equal(panel.doc.getElementById('task-list'), null);
  });

  test('it sits above the input, not in the transcript', () => {
    panel.api.renderTaskList(list(FOUR));
    assert.equal(panel.doc.getElementById('task-list').nextElementSibling.id, 'input-area');
    assert.equal(panel.doc.getElementById('stream').children.length, 0, 'it would scroll away');
  });

  test('item text is escaped', () => {
    panel.api.renderTaskList(list([{ done: false, text: '<img src=x onerror=alert(1)>' }]));
    assert.equal(panel.doc.querySelector('.task-items img'), null);
  });
});

describe('the handover review', () => {
  const REPLY = 'Done — the bridge relays it now.\n\n## Review\n'
    + '- Checklist: 4/4 done\n- Ran: npm test → 1124 pass\n- Not done: nothing';

  test('it is split off the reply, not left in the prose', () => {
    const { body, review } = panel.api.splitReview(REPLY);
    assert.equal(body, 'Done — the bridge relays it now.');
    assert.match(review, /^## Review/);
  });

  test('a reply without one is untouched', () => {
    const { body, review } = panel.api.splitReview('Just an answer.');
    assert.equal(body, 'Just an answer.');
    assert.equal(review, '');
  });

  test('it collapses to its first fact', () => {
    panel.api.appendReview(panel.api.splitReview(REPLY).review);
    const summary = panel.doc.querySelector('.review-summary').textContent.replace(/\s+/g, ' ').trim();
    assert.match(summary, /Review/);
    assert.match(summary, /Checklist: 4\/4 done/);
  });

  test('the rest is a click away', () => {
    panel.api.appendReview(panel.api.splitReview(REPLY).review);
    const block = panel.doc.querySelector('.review-block');
    assert.equal(block.classList.contains('open'), false);
    block.querySelector('.review-summary').dispatchEvent(new panel.window.Event('click'));
    assert.equal(block.classList.contains('open'), true);
    assert.match(block.querySelector('.review-body').textContent, /Not done: nothing/);
  });

  // Matched on shape, not wording, so rephrasing the prompt does not silently
  // stop this working.
  test('the heading is matched by shape at any level', () => {
    for (const heading of ['# Review', '## Review', '###  review']) {
      const { review } = panel.api.splitReview(`text\n\n${heading}\n- Ran: yes`);
      assert.notEqual(review, '', heading);
    }
  });
});
