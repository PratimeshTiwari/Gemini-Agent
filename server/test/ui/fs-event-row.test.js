/**
 * The file-change row said the same thing the summary above it said.
 *
 * `TranscriptTurn` draws a summary line — `Worked for 8.1s · 2 actions · 3
 * files changed on disk` — and then, a few rows below it, `∙ 3 files changed
 * on disk — a.js, b.js, c.js`. The count appears twice; only the paths appear
 * once, and they are what the row is for.
 *
 * The count belongs to the summary, which aggregates every group in the turn.
 * The row keeps the names.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fsEventRow } from '../../src/ui/format.js';

test('the row names the files and leaves the counting to the summary', () => {
  const row = fsEventRow(['a.js', 'b.js', 'c.js']);
  assert.match(row, /a\.js, b\.js, c\.js/);
  // The negative control: this is exactly what it used to say.
  assert.doesNotMatch(row, /\b3\b/);
  assert.doesNotMatch(row, /files changed on disk/);
});

test('one file reads the same way as three', () => {
  const row = fsEventRow(['server/src/main.js']);
  assert.match(row, /server\/src\/main\.js/);
  assert.doesNotMatch(row, /\b1\b file/);
});

/*
 * `touched` in the summary counts paths, not events, so a group whose path
 * could not be parsed shows nothing up there at all. This row is then the
 * only thing saying the tree moved, and has to say it unaided.
 */
test('with no path parsed the row still says what happened', () => {
  for (const empty of [[], null, undefined, [null], ['']]) {
    assert.equal(fsEventRow(empty), '∙ a file changed on disk', JSON.stringify(empty));
  }
});

test('it stays one row: no newline, whatever it is given', () => {
  assert.doesNotMatch(fsEventRow(Array.from({ length: 40 }, (_, i) => `f${i}.js`)), /\n/);
});
