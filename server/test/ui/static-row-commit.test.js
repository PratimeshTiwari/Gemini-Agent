/**
 * `<Static>` is handed rows, and a row never changes.
 *
 * Ink's `<Static>` advances on `items.length` and never re-renders an item —
 * its own doc says it is for "things that don't change after they're
 * rendered". A *turn* changes: rows arrive for as long as the loop runs. While
 * a Static item was a turn, the only repair was remounting `<Static>` so the
 * whole transcript printed again, and Ink cannot un-write what it already
 * wrote — so the second copy landed below the first. Reported from use at
 * 210x64: banner and turn drawn three times, once per tool round.
 *
 * Rows commit as they settle instead. Source assertions, because each mistake
 * below is invisible in a diff and two of them render *nothing at all*, which
 * no unit test in this repo would notice. The behaviour is measured by the pty
 * harness (`a tall terminal prints the banner once`).
 *
 * This file replaces `committed-turn-reprint.test.js`, which pinned the
 * remount that no longer exists.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../../src/ui/App.jsx'), 'utf8');

test('the growth reprint is gone, and nothing bumps the epoch but a deliberate clear', () => {
  assert.doesNotMatch(src, /grewInPlace/,
    'a committed row cannot grow; reinstating this brings back the duplicate transcript');
  // `resetScreen` is the only remaining bump: ctrl+e and the explicit clears,
  // which pay one ESC[2J on purpose and start the screen over.
  const bumps = [...src.matchAll(/setStaticEpoch\(/g)].length;
  assert.equal(bumps, 1, `staticEpoch should be bumped in exactly one place, found ${bumps}`);
  const reset = src.slice(src.indexOf('const resetScreen'), src.indexOf('const toggleVerbose'));
  assert.match(reset, /setStaticEpoch/, 'and that one place is resetScreen');
});

/*
 * This one rendered an empty terminal — banner included — and measured 2,284
 * bytes for a whole session before anyone noticed the screen was blank.
 * `<Static>` memoises `items.slice(index)` on `[items, index]`, so an array
 * mutated in place is an array it never looks at again.
 */
test('rows are appended into a new array, never pushed into the old one', () => {
  assert.doesNotMatch(src, /staticRowsRef\.current\.push/,
    'pushing in place leaves the reference unchanged and Static renders nothing');
  assert.match(src, /staticRowsRef\.current = \[\.\.\.staticRowsRef\.current/,
    'a fresh identity is what makes Static look again');
});

/*
 * A `tool` item is created by its call and rewritten when its result arrives,
 * and nothing follows it in between — so the newest item of a running turn is
 * exactly the one that can still change. Committing it would freeze a tool row
 * as "running" forever.
 */
test('the newest row of a running turn is not committed', () => {
  assert.match(src, /settled \? parsed\.items : parsed\.items\.slice\(0, -1\)/,
    'the last item of an in-flight turn must be held back');
  assert.match(src, /const settled = !\(i === parsedTurns\.length - 1 && turnInFlight\)/,
    'and only the newest turn is ever unsettled');
});

/*
 * `resetScreen` remounts Static, which starts from index 0 again. Rows we
 * still believe are emitted would then never be printed — a blank transcript
 * after ctrl+e, and no way back to it.
 */
test('a deliberate clear forgets which rows were emitted', () => {
  const reset = src.slice(src.indexOf('const resetScreen'), src.indexOf('const toggleVerbose'));
  assert.match(reset, /emittedRef\.current = new Map\(\)/);
  assert.match(reset, /staticRowsRef\.current = \[\{ id: 'app-banner'/);
});

/*
 * The summary counts the rows above it, so it cannot be written before them.
 * Above the rows and append-only are not both available.
 */
test('the summary is committed only once the turn has settled', () => {
  assert.match(src, /if \(settled && !seen\.summary/,
    'a summary written mid-turn would report a count that is still rising');
});
