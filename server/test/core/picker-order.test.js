/**
 * Matching by the picker's order, anchored on the one name that does not drift.
 *
 * Reported by the owner, 2026-09-26: *"Pro is the main identifier — Flash-Lite
 * and Flash change across different Google accounts, only Pro is constant, even
 * the versions change."* That is a fact about Google's naming rather than about
 * this code, and it undercuts `INTENT`'s word lists for two rungs out of three:
 * `lite` reaches for `fastest`/`lite`, `flash` for `thinking`/`flash`, and
 * neither word is promised to anyone.
 *
 * What is stable is the order, verified against the live picker by cycling it
 * with Gemini's own `⌘⇧M` shortcut — which walks the models and nothing else:
 *
 *     Flash-Lite → Flash → Pro → Flash-Lite (wraps)
 *
 * Lightest first, Pro last, and **Extended thinking is not in the rotation**:
 * it is a mode, not a rung, which is what `avoid: ['extended','complex']` has
 * always encoded by hand.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickModelFor } from '../../src/core/model-match.js';

const P = (label, description = '') => ({ label, description });
const pick = (rung, opts) => pickModelFor(rung, opts, null)?.model?.label ?? null;

/**
 * A model and a mode, as the extension reports them.
 *
 * `isMode` comes from the rule the picker draws between the two — a real
 * `<mat-divider>`, verified against the live menu. Every fixture below says
 * which it means rather than relying on a word, which is the whole point.
 */
const M = (label, description = '') => ({ label, description, isMode: false });
const MODE = (label, description = '') => ({ label, description, isMode: true });

const LIVE = [
  P('3.5 Flash-Lite', 'Fastest answers'),
  P('3.8 Flash', 'All-around help'),
  P('3.1 Pro', 'Advanced reasoning'),
  P('Extended thinking', 'Complex problem solving'),
];

test('the picker as it is today', () => {
  assert.equal(pick('low', LIVE), '3.5 Flash-Lite');
  assert.equal(pick('medium', LIVE), '3.8 Flash');
  assert.equal(pick('high', LIVE), '3.1 Pro');
});

/*
 * The case the whole change exists for. Every word the old lists match on is
 * gone — no "low", no "medium", no "fastest" in a label — and only the order
 * and the word Pro remain.
 */
test('a plan that has renamed everything except Pro', () => {
  const renamed = [
    P('4.0 Nano', 'Fastest answers'),
    P('4.0 Swift', 'All-around help'),
    P('4.0 Pro', 'Advanced reasoning'),
    P('Extended thinking', 'Complex problem solving'),
  ];
  assert.equal(pick('low', renamed), '4.0 Nano');
  assert.equal(pick('medium', renamed), '4.0 Swift');
  assert.equal(pick('high', renamed), '4.0 Pro');
});

test('version numbers moving, or going away entirely', () => {
  const bare = [P('Nano'), P('Swift'), P('Pro'), P('Extended thinking', 'Complex problem solving')];
  assert.equal(pick('low', bare), 'Nano');
  assert.equal(pick('medium', bare), 'Swift');
  assert.equal(pick('high', bare), 'Pro');
});

/*
 * Extended thinking is dropped before positions are counted, so where it sits
 * in the list cannot shift the answer. It used to be excluded by a word veto
 * applied per candidate; here it would otherwise *be* a position.
 */
test('a mode listed among the models does not shift the positions', () => {
  const interleaved = [
    P('Nano', 'Fastest'),
    P('Extended thinking', 'Complex problem solving'),
    P('Swift', 'All-around'),
    P('Pro', 'Advanced reasoning'),
  ];
  assert.equal(pick('low', interleaved), 'Nano');
  assert.equal(pick('medium', interleaved), 'Swift');
  assert.equal(pick('high', interleaved), 'Pro');
});

/*
 * Clamped, not wrapped. On a two-entry plan the middle rung collapses onto the
 * lightest, which is the honest answer; wrapping would send it to Pro, and a
 * pro-weight tab for a flash-weight prompt is the pairing CLAUDE.md names as
 * the worst available.
 */
test('a two-model plan puts the middle rung on the lighter one, never Pro', () => {
  const two = [P('Lite', 'Fastest'), P('Pro', 'Advanced reasoning')];
  assert.equal(pick('low', two), 'Lite');
  assert.equal(pick('medium', two), 'Lite');
  assert.equal(pick('high', two), 'Pro');
});

/*
 * There are no word lists any more, and no `\bpro\b` anchor either.
 *
 * Both were strategies for reading a picker by vocabulary, and both went on
 * 2026-09-26 once the page started saying which entries are models. Position
 * answers every case they answered and several they could not — a plan that
 * renames Pro, a mode called `Agent mode`, a version number that moves.
 *
 * What is left is two strategies: a config pin, then structure.
 */
test('a picker with no Pro in it still resolves, by position', () => {
  const noPro = [M('Swift', 'Fastest answers'), M('Deep', 'Advanced reasoning')];
  assert.equal(pick('low', noPro), 'Swift');
  assert.equal(pick('high', noPro), 'Deep',
    'the heaviest rung needed the word "Pro" to find the heaviest model');
});

test('a name that merely starts with p-r-o is not treated as special', () => {
  // `Prometheus` used to trip the substring half of the old word match. Under
  // position it is simply the first entry, which is what it looks like.
  const decoys = [M('Prometheus', 'Fastest answers'), M('Proxy Mode', 'All-around help')];
  assert.equal(pick('low', decoys), 'Prometheus');
  assert.equal(pick('high', decoys), 'Proxy Mode');
});

test('an empty picker is still nothing', () => {
  assert.equal(pickModelFor('high', [], null), null);
  assert.equal(pickModelFor('high', null, null), null);
});

// A config pin still outranks all of this: it is the user naming the label
// themselves, and it is checked against the live list before anything here.
test('a pin still wins', () => {
  const picked = pickModelFor('high', LIVE, '3.8 Flash');
  assert.equal(picked.model.label, '3.8 Flash');
  assert.equal(picked.pinned, true);
});
