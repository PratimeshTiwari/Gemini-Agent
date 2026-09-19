/**
 * A committed turn that grows must be reprinted.
 *
 * A turn is committed to `<Static>` when `isProcessing` goes false, and
 * `agent_response` clears that even when the reply carried tool calls — so a
 * turn reaches the scrollback while the loop is still working on it. The tool
 * result, the diff approval and the closing reply then land in a group Ink
 * will never repaint. Reported as "file created, diff showed, then nothing".
 *
 * Keeping the turn live instead was measured and is far worse: 15KB and 0 full
 * clears became **6.8MB and 1,228**. So the turn still commits early, and the
 * rare case where it grows afterwards is paid for by remounting `<Static>` —
 * which measured 18.5KB and 0 clears across three runs.
 *
 * This is a source assertion because the behaviour needs a live turn under the
 * pty harness to observe, and because the mistake it guards is invisible:
 * the first version counted `t.messages`, a field `groupTurns` does not
 * return. The shape never changed, the epoch never bumped, and the fix
 * measured a clean 0 clears **while doing nothing at all**.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { groupTurns } from '../../src/ui/transcript.js';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../../src/ui/App.jsx'), 'utf8');

test('groupTurns returns `steps`, which is what the shape must count', () => {
  const [turn] = groupTurns([
    { role: 'user', content: 'q' },
    { role: 'agent', content: 'first' },
    { role: 'agent', content: 'after the approval' },
  ]);
  assert.ok(Array.isArray(turn.steps), 'the field is `steps`');
  assert.equal(turn.messages, undefined, '`messages` does not exist — counting it is a no-op');
  assert.equal(turn.steps.length, 2, 'and a turn really can hold two replies');
});

test('the committed shape is measured from `steps`', () => {
  const line = src.split('\n').find((l) => l.includes('const committedShape'));
  assert.ok(line, 'committedShape should still exist');
  assert.match(line, /t\.steps\?\.length/,
    'counting any other field makes the reprint inert while still measuring 0 clears');
});

test('the reprint fires only when a committed turn grows in place', () => {
  // Not when a new turn is committed — that is ordinary appending, and
  // remounting Static for it would reprint the transcript on every turn.
  const body = src.slice(src.indexOf('const committedShape'));
  assert.match(body, /staticCount === lastCountRef\.current/,
    'the turn count must be unchanged for this to be a growth rather than an append');
  assert.match(body, /committedShape > lastShapeRef\.current/);
});
