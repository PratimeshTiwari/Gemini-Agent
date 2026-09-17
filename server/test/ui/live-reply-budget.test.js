/**
 * The agent's reply is a row too, and it was the one nobody budgeted.
 *
 * `frame-budget.test.js` covers the furniture and the floor. This covers the
 * row those numbers were being spent on: while a turn is live, its reply sits
 * inside Ink's repainted frame, and a frame taller than the viewport makes Ink
 * write `ESC[2J ESC[3J` and repaint on every render — deleting the scrollback.
 *
 * `TranscriptTurn` carefully caps the *action* rows at `liveBudget` and then
 * rendered the reply underneath in full, at whatever height it happened to be.
 *
 * Reported as "it gave me much more output but I received only a portion of
 * it": a 5,090-character answer, ~85 rendered rows, in a terminal about 30
 * rows tall. Nothing was lost — `history.jsonl` held the whole reply and
 * `renderMarkdown` returned all of it — but the frame blew past the viewport
 * and what survived the repaint was its top, cut mid-sentence.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { liveMessageText } from "../../src/ui/format.js";

const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');
const count = (s) => String(s).split('\n').length;

test('a reply taller than the budget is cut down to it', () => {
  const out = liveMessageText(lines(85), 20);
  assert.ok(count(out) <= 20, `expected <= 20 rows, got ${count(out)}`);
});

test('it says what it held back, rather than just stopping', () => {
  // A reply that simply stops mid-sentence is indistinguishable from a
  // truncated scrape, which is exactly how this was first reported.
  const out = liveMessageText(lines(85), 20);
  assert.match(out, /… \+\d+ more lines$/);
  assert.ok(out.startsWith('line 1'), 'the beginning is what you keep');
});

test('a short reply is untouched', () => {
  const short = lines(4);
  assert.equal(liveMessageText(short, 20), short);
});

test('it never collapses to nothing, however small the budget', () => {
  // `liveBudget` has a floor of 1, and a reply clamped to zero rows would be
  // a turn that appears to produce no answer at all.
  for (const budget of [1, 2, 3, 0, -5]) {
    const out = liveMessageText(lines(50), budget);
    assert.ok(count(out) >= 2, `budget ${budget} produced ${count(out)} rows`);
    assert.ok(out.startsWith('line 1'));
  }
});

test('the committed copy is not this function\'s business', () => {
  // Static is written once and never repainted, so it carries the whole
  // reply. This helper is only ever reached on the live path.
  const whole = lines(85);
  assert.notEqual(liveMessageText(whole, 20), whole);
  assert.equal(count(whole), 85, 'the source text itself is never mutated');
});

/**
 * The budget is spent in *wrapped* rows, not newlines.
 *
 * The first version of this clamp counted `\n`, which is the same bug it was
 * written to fix. The real reply that provoked it is 1,450 characters over 18
 * source lines — and 26 rendered rows at 100 columns. An 18-line clamp against
 * a 14-row budget passed untouched while the frame still overflowed by twelve
 * rows, so the terminal cleared and the user saw the top of the answer and
 * nothing else. This file's own rule: a row that wraps is two.
 */
const wrapped = (s, cols) => String(s).split('\n')
  .reduce((n, l) => n + Math.max(1, Math.ceil(l.length / cols)), 0);

test('a few long lines that wrap are clamped, though there are few of them', () => {
  // Six source lines, each three rows wide at 40 columns: 18 rows in 6 lines.
  const text = Array.from({ length: 6 }, () => 'x'.repeat(115)).join('\n');
  assert.equal(text.split('\n').length, 6, 'only six newlines');
  assert.ok(wrapped(text, 40) >= 18, 'but far more rows');

  const out = liveMessageText(text, 12, 40);
  assert.ok(wrapped(out, 40) <= 12, `must fit the budget in rows, got ${wrapped(out, 40)}`);
  assert.match(out, /… \+\d+ more lines$/);
});

test('the same text is left alone when the terminal is wide enough', () => {
  // Nothing wraps at 200 columns, so six lines is six rows and fits.
  const text = Array.from({ length: 6 }, () => 'x'.repeat(115)).join('\n');
  assert.equal(liveMessageText(text, 12, 200), text);
});

test('a single line far wider than the budget still yields something', () => {
  const out = liveMessageText('y'.repeat(5000), 6, 40);
  assert.ok(out.length > 0);
  assert.ok(out.startsWith('y'));
});
