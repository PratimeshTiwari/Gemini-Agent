/**
 * Did the prompt actually go? Observe the composer; do not infer it.
 *
 * Proposed by the owner, 2026-09-26: *"are we checking whether the prompt we
 * typed was sent? We can simply check whether Gemini's input box still has our
 * pasted text — if the text is there it was not sent, so retry."*
 *
 * The timeout path answered this with `!isGenerating && !sawGenerating`, which
 * is an inference and is wrong in one direction that costs real damage: it is
 * equally true when generation *did* start and a changed selector stopped us
 * seeing it. A resend there asks a thread that already holds the answer, and
 * CLAUDE.md records that double-answer as the reason several repairs were
 * deliberately not built.
 *
 * Gemini clears the composer when it accepts a prompt. So:
 *
 *   text still there  -> the submit did not happen. Retry is the first attempt.
 *   composer empty    -> the text went somewhere. Never retry.
 *
 * The second line is the valuable one. It is a brake, not an accelerator.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { loadFunction } from '../load-content-script.js';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '../../content-scripts/gemini-bridge.js');

const PROMPT = 'You are in PLAN MODE. Call edit_file, create_file and run_command exactly as you normally would.';
const prefixOf = (s, n = 120) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

/** The function under test, with the composer it should be reading. */
function probe({ composerText, prefix = prefixOf(PROMPT), hasInput = true }) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const { document } = dom.window;
  let input = null;
  if (hasInput) {
    input = document.createElement('div');
    input.textContent = composerText ?? '';
    // jsdom has no layout, so innerText is undefined — the function falls back
    // to textContent, which is the path this exercises.
    document.body.appendChild(input);
  }
  return loadFunction(SCRIPT, 'composerStillHoldsPrompt', {
    lastTypedPrefix: prefix,
    findInputResilient: () => input,
  })();
}

test('our text still sitting there means it was never sent', () => {
  assert.equal(probe({ composerText: PROMPT }), true);
});

/*
 * The brake. An empty composer is the state after Gemini accepts a prompt, and
 * it must veto a resend however the other signals read.
 */
test('an empty composer means it went — never resend', () => {
  assert.equal(probe({ composerText: '' }), false);
  assert.equal(probe({ composerText: '   \n  ' }), false);
});

test('someone else typing in the box is not our prompt', () => {
  assert.equal(probe({ composerText: 'what is the weather' }), false);
});

/*
 * The editor rewrites what it holds — pasted text is split into paragraphs and
 * whitespace is normalised — so the whole string rarely compares equal while
 * the opening survives. That is why this is a prefix test and why both sides
 * are whitespace-collapsed.
 */
test('the editor reflowing our text still counts as holding it', () => {
  const reflowed = PROMPT.replace(/ /g, '\n  ');
  assert.equal(probe({ composerText: reflowed }), true);
});

test('our prompt with the model already typing after it still counts', () => {
  assert.equal(probe({ composerText: `${PROMPT} and some more the user added` }), true);
});

/*
 * Unknowable is null, not false — null hands the decision back to
 * `sawGenerating`, where false would assert "it was sent" and suppress a
 * legitimate retry. A missing composer is the case a changed selector produces,
 * which is exactly when the inference should be trusted instead.
 */
test('no composer found is unknowable, not a denial', () => {
  assert.equal(probe({ composerText: PROMPT, hasInput: false }), null);
});

test('and nothing recorded as typed is unknowable too', () => {
  assert.equal(probe({ composerText: PROMPT, prefix: '' }), null);
});

/*
 * The wiring: the observation must win over the inference, and fall back to it
 * rather than replacing it outright.
 */
test('the timeout report prefers the observation and falls back to the inference', () => {
  const src = readFileSync(SCRIPT, 'utf8');
  assert.match(src, /neverSubmitted:\s*composerStillHoldsPrompt\(\)\s*\?\?\s*\(!isGenerating && !sawGenerating\)/,
    'the composer check is not wired in, or it replaced the fallback instead of preceding it');
});

