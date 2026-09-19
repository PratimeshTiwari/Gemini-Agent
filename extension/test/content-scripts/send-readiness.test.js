/**
 * The send path waits for readiness, not for a clock.
 *
 * `waitForSendButton` used to open with `setTimeout(check, 500)` — an
 * unconditional half-second on **every round of every turn**, spent waiting for
 * a button that is usually already enabled. Measured across 237 recorded turns,
 * the `send` stage was 698ms median and 1,383ms p90; roughly 500ms of that was
 * that one line.
 *
 * It was not pointless. The empty-composer test means "the user pressed send
 * themselves", and that reading is only valid once our text has been seen in
 * the composer — before then, empty just means the paste has not been processed.
 * The delay was a guess that 500ms is long enough for that. `sawText` answers
 * the same question directly and cannot be wrong in either direction.
 *
 * Source assertions, because `waitForSendButton` closes over `findElement`,
 * `SELECTORS` and `reportDrift`, so the brace-matching loader cannot lift it —
 * and because the regression is invisible: putting the delay back reads as
 * caution and costs half a second a round with nothing failing.
 *
 * This is the same trade `CLAUDE.md` records for tabs: "fixed sleeps became a
 * readiness handshake", 6.5s of unconditional waiting per new tab removed.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(here, '../../content-scripts/gemini-bridge.js'), 'utf8');

/** Just the body of `waitForSendButton`, so a delay elsewhere is not read as this one. */
const body = (() => {
  const start = src.indexOf('function waitForSendButton(');
  assert.ok(start > 0, 'waitForSendButton should still exist');
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('unbalanced braces');
})()
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '');

describe('waitForSendButton', () => {
  test('checks immediately rather than sleeping first', () => {
    assert.doesNotMatch(body, /setTimeout\(check,\s*500\)/,
      'the unconditional 500ms is half a second on every round of every turn');
    assert.match(body, /\n\s*check\(\);/, 'the first check should be a direct call');
  });

  test('and polls faster than the old 200ms', () => {
    const poll = body.match(/setTimeout\(check,\s*(\d+)\)/);
    assert.ok(poll, 'it still polls');
    assert.ok(Number(poll[1]) <= 100, `poll interval ${poll[1]}ms should be <= 100ms`);
  });

  /*
   * The negative control for removing the delay. Without `sawText`, the very
   * first check runs before the paste is processed, sees an empty composer, and
   * resolves `'submitted'` — reporting a send that never happened, on every
   * turn. That is strictly worse than the half second it saves.
   */
  test('an empty composer only means "sent" once the text has been seen', () => {
    assert.match(body, /let sawText = false/);
    assert.match(body, /if \(!empty\) sawText = true/);
    assert.match(body, /if \(sawText && empty\)/,
      'the manual-submission branch must require having seen the text');
  });

  test('the timeout is still bounded', () => {
    assert.match(body, /Date\.now\(\) - startTime >= maxWait/);
  });
});
