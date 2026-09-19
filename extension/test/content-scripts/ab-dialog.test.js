/**
 * Answering Gemini's "Which response is more helpful?" modal.
 *
 * The modal holds two complete replies and resolves to neither until a button
 * is pressed, so a turn that meets it never finishes — it waits out the
 * five-minute cap and reports a timeout. The dismissal existed and **never
 * fired**, for two reasons this pins:
 *
 *  - it read `document.querySelector('h2, .title')`, the first such node in
 *    the whole document rather than the dialog's own heading;
 *  - it hunted for a button reading `Choice A`, when the real control says
 *    **"This response is more helpful"** with its text in a nested span.
 *
 * The DOM below is the shape from a real screenshot of the modal, nested
 * spans and all, because that is the thing the old selectors missed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadFunction } from '../load-content-script.js';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '../../content-scripts/gemini-bridge.js');

/** @returns {{dismiss: Function, clicks: string[], window: object}} */
function build(html) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
  const clicks = [];
  for (const b of dom.window.document.querySelectorAll('button')) {
    b.addEventListener('click', () => clicks.push(b.dataset.name || b.textContent.trim()));
  }
  const dismiss = loadFunction(SCRIPT, 'dismissChoiceDialog', {
    document: dom.window.document,
    console: { warn() {} },
  });
  return { dismiss, clicks };
}

/** The real markup: label buried two spans deep inside the button. */
const CHOICE_BUTTON = (name) => `
  <button data-name="${name}">
    <span class="mdc-button__label"><span class="gds-label-l">This response is more helpful</span></span>
  </button>`;

const REAL_MODAL = `
  <h1>Gemini</h1>
  <div class="conversation">Some earlier heading text</div>
  <h2>Which response is more helpful?</h2>
  <div class="choices">
    <div>Choice A body ${CHOICE_BUTTON('A')}</div>
    <div>Choice B body ${CHOICE_BUTTON('B')}</div>
  </div>`;

test('answers the real modal, taking the first choice', () => {
  const { dismiss, clicks } = build(REAL_MODAL);
  assert.equal(dismiss(), true);
  assert.deepEqual(clicks, ['A'], 'DOM order is left to right, so the first match is Choice A');
});

test('finds the heading even when it is not the first on the page', () => {
  // This is the exact fault: `querySelector('h2, .title')` answered with the
  // page's own heading and the check failed before it began.
  const { dismiss, clicks } = build(`
    <h2>Gemini Advanced</h2>
    <div class="title">A sidebar title</div>
    ${REAL_MODAL}`);
  assert.equal(dismiss(), true);
  assert.deepEqual(clicks, ['A']);
});

test('does nothing when there is no modal', () => {
  const { dismiss, clicks } = build(`
    <h2>Some ordinary heading</h2>
    <button data-name="send">Send</button>`);
  assert.equal(dismiss(), false);
  assert.deepEqual(clicks, [], 'clicking anything here would submit something the user did not ask for');
});

test('does not click when the modal is there but its buttons are not', () => {
  // Mid-render, or markup changed again. Reporting no is better than clicking
  // whatever button happens to be nearby.
  const { dismiss, clicks } = build(`<h2>Which response is more helpful?</h2><button data-name="mic">Mic</button>`);
  assert.equal(dismiss(), false);
  assert.deepEqual(clicks, []);
});

test('still handles the older aria-labelled variant', () => {
  const { dismiss, clicks } = build(`
    <h2>Which response is more helpful?</h2>
    <button data-name="A" aria-label="Choice A">Pick</button>
    <button data-name="B" aria-label="Choice B">Pick</button>`);
  assert.equal(dismiss(), true);
  assert.deepEqual(clicks, ['A']);
});
