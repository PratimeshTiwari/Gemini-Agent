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

const LIVE = [
  P('3.5 Flash-Lite', 'Fastest answers'),
  P('3.8 Flash', 'All-around help'),
  P('3.1 Pro', 'Advanced reasoning'),
  P('Extended thinking', 'Complex problem solving'),
];

test('the picker as it is today', () => {
  assert.equal(pick('lite', LIVE), '3.5 Flash-Lite');
  assert.equal(pick('flash', LIVE), '3.8 Flash');
  assert.equal(pick('pro', LIVE), '3.1 Pro');
});

/*
 * The case the whole change exists for. Every word the old lists match on is
 * gone — no "lite", no "flash", no "fastest" in a label — and only the order
 * and the word Pro remain.
 */
test('a plan that has renamed everything except Pro', () => {
  const renamed = [
    P('4.0 Nano', 'Fastest answers'),
    P('4.0 Swift', 'All-around help'),
    P('4.0 Pro', 'Advanced reasoning'),
    P('Extended thinking', 'Complex problem solving'),
  ];
  assert.equal(pick('lite', renamed), '4.0 Nano');
  assert.equal(pick('flash', renamed), '4.0 Swift');
  assert.equal(pick('pro', renamed), '4.0 Pro');
});

test('version numbers moving, or going away entirely', () => {
  const bare = [P('Nano'), P('Swift'), P('Pro'), P('Extended thinking', 'Complex problem solving')];
  assert.equal(pick('lite', bare), 'Nano');
  assert.equal(pick('flash', bare), 'Swift');
  assert.equal(pick('pro', bare), 'Pro');
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
  assert.equal(pick('lite', interleaved), 'Nano');
  assert.equal(pick('flash', interleaved), 'Swift');
  assert.equal(pick('pro', interleaved), 'Pro');
});

/*
 * Clamped, not wrapped. On a two-entry plan the middle rung collapses onto the
 * lightest, which is the honest answer; wrapping would send it to Pro, and a
 * pro-weight tab for a flash-weight prompt is the pairing CLAUDE.md names as
 * the worst available.
 */
test('a two-model plan puts the middle rung on the lighter one, never Pro', () => {
  const two = [P('Lite', 'Fastest'), P('Pro', 'Advanced reasoning')];
  assert.equal(pick('lite', two), 'Lite');
  assert.equal(pick('flash', two), 'Lite');
  assert.equal(pick('pro', two), 'Pro');
});

/*
 * The negative control, and the reason the word lists are kept rather than
 * deleted: a plan with no entry named Pro is exactly what they were written
 * for, and they are the only thing that can read a vocabulary nobody has seen.
 */
test('with no Pro at all, the word lists still run', () => {
  const noPro = [P('3.5 Flash-Lite', 'Fastest answers'), P('3.8 Flash', 'All-around help')];
  assert.equal(pick('lite', noPro), '3.5 Flash-Lite');
  assert.equal(pick('flash', noPro), '3.8 Flash');
  assert.equal(pick('pro', noPro), null, 'it invented a Pro out of a plan that has none');
});

/*
 * The anchor is `\bpro\b`, so "Prometheus" does not make a plan Pro-shaped and
 * the order logic declines rather than counting positions from a decoy.
 *
 * What happens next is the word list's business, and it is looser — it asks
 * `text.includes('pro')`, so it *does* answer "Prometheus". That is a
 * pre-existing weakness of the fallback rather than of the anchor, and this
 * test deliberately asserts the boundary between them rather than the outcome:
 * the first draft asserted `null` here, which is behaviour the system has never
 * had, and it failed for the right reason.
 */
test('“Pro” inside another word does not anchor the order', () => {
  const decoys = [P('Prometheus', 'Fastest answers'), P('Proxy Mode', 'All-around help')];
  const picked = pickModelFor('pro', decoys, null);

  assert.ok(!/picker's order/.test(picked?.why ?? ''),
    'positions were counted from a model that merely starts with the letters p-r-o');
});

test('an empty picker is still nothing', () => {
  assert.equal(pickModelFor('pro', [], null), null);
  assert.equal(pickModelFor('pro', null, null), null);
});

// A config pin still outranks all of this: it is the user naming the label
// themselves, and it is checked against the live list before anything here.
test('a pin still wins', () => {
  const picked = pickModelFor('pro', LIVE, '3.8 Flash');
  assert.equal(picked.model.label, '3.8 Flash');
  assert.equal(picked.pinned, true);
});
