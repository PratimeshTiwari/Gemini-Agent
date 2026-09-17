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
