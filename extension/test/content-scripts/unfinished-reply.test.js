/**
 * A reply that stops mid-construct is a pause, not an ending.
 *
 * The quiet rule watches the *page*: no Stop button, and text unchanged for
 * 1.5s, twice over. A code block starting to render looks exactly like that —
 * the Stop button flickers while the composer re-renders, and the text pauses
 * while the fence is built.
 *
 * Observed in real use: one question produced **three** replies in a single
 * turn, each ending at a backtick, each followed by the model carrying on into
 * a `stale_response`. The scrape was not losing text; it was declaring victory
 * three times while Gemini was still writing.
 *
 * So the content gets a veto the page cannot give. Deliberately narrow: prose
 * that merely stops abruptly is undetectable and is not claimed — this catches
 * only the case where the markup itself says the text is incomplete, which is
 * the case that was happening.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(here, '../../content-scripts/gemini-bridge.js'), 'utf8');

/** Lift the pure function out of the shipped source, as the scrape tests do. */
const looksUnfinished = (() => {
  const start = src.indexOf('function looksUnfinished(');
  let depth = 0, end = -1;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  // eslint-disable-next-line no-new-func
  return new Function(`${src.slice(start, end)}\nreturn looksUnfinished;`)();
})();

describe('looksUnfinished', () => {
  test('an open code fence is unfinished', () => {
    assert.equal(looksUnfinished('Here is the shape:\n```json\n{"name":'), true);
  });

  test('a closed code fence is finished', () => {
    assert.equal(looksUnfinished('Here it is:\n```json\n{"a":1}\n```\nDone.'), false);
  });

  // The reported shape, exactly: the reply stopped at an inline backtick while
  // Gemini was about to render the block after it.
  test('a trailing inline backtick is unfinished', () => {
    assert.equal(looksUnfinished('Strict thought formatting: Demanding exact `'), true);
  });

  test('balanced inline code is finished', () => {
    assert.equal(looksUnfinished('Call `edit_file` to change it.'), false);
  });

  /*
   * The controls. A veto that fires on ordinary prose would hold every turn
   * open for the full grace period, turning a latency fix into a latency bug.
   */
  test('ordinary prose is finished', () => {
    for (const t of [
      'That is the whole answer.',
      'Two things changed: the parser and the cap.',
      'A list:\n- one\n- two\n',
      '',
    ]) assert.equal(looksUnfinished(t), false, JSON.stringify(t));
  });

  test('a backtick closed on an earlier line does not linger', () => {
    assert.equal(looksUnfinished('Use `npm test` first.\nThen read the output.'), false);
  });

  test('nullish input is not unfinished', () => {
    assert.equal(looksUnfinished(null), false);
    assert.equal(looksUnfinished(undefined), false);
  });
});

describe('the hold is bounded', () => {
  // A reply that genuinely ends on an unclosed backtick must still arrive,
  // rather than waiting out the five-minute cap — the failure this would
  // otherwise introduce.
  test('there is a grace limit, not an indefinite wait', () => {
    assert.match(src, /UNFINISHED_GRACE_CHECKS\s*=\s*\d+/);
    assert.match(src, /unfinishedHolds <= UNFINISHED_GRACE_CHECKS/);
  });
});
