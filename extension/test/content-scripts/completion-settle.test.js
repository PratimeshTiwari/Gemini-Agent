/**
 * Not calling a reply finished while it is still being written.
 *
 * The turn ended on a single observation: no Stop button, and a second since
 * the observer last saw the text change. That was only ever safe because the
 * check was being throttled — in a hidden tab it ran roughly once a minute,
 * so a transient gap was almost never *sampled*.
 *
 * Moving the clock into the service worker made the cadence reliable at 2s,
 * and the transients started getting caught: a reply arrived truncated
 * mid-token ("…output a single `") while Gemini was still writing the rest.
 * Gemini pauses longer than a second between sections, and the Stop button is
 * briefly absent while the composer re-renders; either alone looks exactly
 * like "finished".
 *
 * So the condition has to hold across consecutive checks. This is that rule,
 * and the reason it is a named function is that putting the threshold back to
 * 1 reads like a harmless tightening.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { loadFunction } from '../load-content-script.js';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '../../content-scripts/gemini-bridge.js');
const src = readFileSync(SCRIPT, 'utf8');

const SETTLE_MS = Number(/const RESPONSE_SETTLE_MS = (\d+);/.exec(src)[1]);
const SETTLE_CHECKS = Number(/const RESPONSE_SETTLE_CHECKS = (\d+);/.exec(src)[1]);
const nextQuietStreak = loadFunction(SCRIPT, 'nextQuietStreak', { RESPONSE_SETTLE_MS: SETTLE_MS });

const quiet = { isGenerating: false, hasText: true, silenceMs: SETTLE_MS };
const writing = { isGenerating: true, hasText: true, silenceMs: SETTLE_MS };
const pausing = { isGenerating: false, hasText: true, silenceMs: SETTLE_MS - 1 };

test('one quiet check is not enough to end the turn', () => {
  assert.ok(nextQuietStreak(0, quiet) < SETTLE_CHECKS,
    'a single sample is the bug: it truncated a reply mid-token');
});

test('consecutive quiet checks do end it', () => {
  let streak = 0;
  for (let i = 0; i < SETTLE_CHECKS; i += 1) streak = nextQuietStreak(streak, quiet);
  assert.ok(streak >= SETTLE_CHECKS);
});

test('a momentary gap in the Stop button resets the count', () => {
  // The composer re-rendering. Without the reset this is indistinguishable
  // from the reply having finished.
  let streak = nextQuietStreak(0, quiet);
  streak = nextQuietStreak(streak, writing);
  assert.equal(streak, 0);
});

test('a pause between sections is not silence enough', () => {
  assert.equal(nextQuietStreak(0, pausing), 0);
});

test('an empty response never settles, however quiet', () => {
  // Nothing scraped is a scrape failure, and it has its own diagnosis path.
  let streak = 0;
  for (let i = 0; i < 10; i += 1) {
    streak = nextQuietStreak(streak, { isGenerating: false, hasText: false, silenceMs: 60_000 });
  }
  assert.equal(streak, 0);
});

test('the tuning itself is pinned, not just the rule', () => {
  // The tests above read both constants out of the source, so they verify the
  // *rule* and adapt to whatever the numbers are — which means a bad number
  // sails through them. These two assertions are the numbers.
  assert.ok(SETTLE_CHECKS > 1, 'one check is what truncated the reply');
  assert.ok(SETTLE_MS >= 1000,
    'Gemini pauses about a second between sections; anything less calls a pause an ending');
});
