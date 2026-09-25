/**
 * The picker is read when a tab exists, not when a socket opens.
 *
 * `requestModelOptions` was scheduled on a **connection** — 1.5s after the
 * extension identifies — and it depends on a **tab**. An open socket does not
 * imply one. At connect there is usually no owned tab at all, so the ask
 * reached nothing: `modelOptions` stayed empty, `pickModelFor` had no list to
 * resolve a rung against, and routing fell back to whatever the tab was
 * already on.
 *
 * That is the whole of "the effort never changes" — the status bar reads PRO,
 * the tab runs Flash, and nothing in the system can compare the two. It is in
 * `.agent/logs/errors.jsonl` 13 times, verbatim, and every one of them is at
 * connect:
 *
 *     discover_models  "no gemini tab this extension owns"
 *
 * Measured against the live page the same day, every *other* stage was fine:
 * the menu opens in 41.9ms in a hidden tab, a full read takes 27.7ms and
 * returns all four options with `selected` correct, and the real matcher
 * resolves that list to `3.1 Pro` for the pro rung. Only the ask was early.
 *
 * So the fix is placement, not mechanism — which is the lesson this repo keeps
 * relearning, and the reason this test asserts *where* the ask happens.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const WORKER = join(here, '../../src/background/content.js');
const BRIDGE = join(here, '../../content-scripts/gemini-bridge.js');
const worker = readFileSync(WORKER, 'utf8');
const bridge = readFileSync(BRIDGE, 'utf8');

/** The body of one function, by brace matching from its declaration. */
function bodyOf(src, decl) {
  const start = src.indexOf(decl);
  if (start === -1) throw new Error(`${decl} not found`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces reading ${decl}`);
}

const ensureModelTab = bodyOf(worker, 'export async function ensureModelTab(');

test('claiming a tab is what triggers the picker read', () => {
  assert.match(ensureModelTab, /discover_models/,
    'the only moment the extension knows a picker became readable, and it says nothing');
});

test('the ask comes after the tab is claimed, not before', () => {
  const claim = ensureModelTab.indexOf('claimOwnedTab');
  const ask = ensureModelTab.indexOf('discover_models');
  assert.ok(claim > -1 && ask > -1);
  assert.ok(ask > claim,
    'asking before the claim lands means `pickMainTab` cannot find the tab we just made');
});

/*
 * A turn must never wait on a menu. The content script sends the list to the
 * server itself, so there is nothing here worth awaiting — and an `await`
 * would put menu latency in front of every first prompt.
 */
test('and the turn does not wait on it', () => {
  assert.doesNotMatch(ensureModelTab, /await\s+chrome\.tabs\.sendMessage\(\s*newTab\.id,\s*\{\s*type:\s*'discover_models'/,
    'the first prompt of every session now waits for a menu to open and close');
  const ask = ensureModelTab.slice(ensureModelTab.indexOf('discover_models'));
  assert.match(ask, /\.catch\(/,
    'a tab with no listener yet would reject into nothing and kill the turn');
});

/*
 * The hazard this creates, and the guard for it.
 *
 * Discovery now fires closer to an inject than it ever has. An open menu
 * swallows the next click — including the send — which is the documented
 * reason `switch_model` was given its own lane in the first place.
 */
test('discovery declines while a prompt is going in', () => {
  const handler = bridge.slice(bridge.indexOf("case 'discover_models':"), bridge.indexOf("case 'switch_model':"));
  assert.match(handler, /if\s*\(\s*isInjecting\s*\)/,
    'a menu opened over a live composer eats the send, and the turn looks dead');

  const guard = handler.indexOf('isInjecting');
  const read = handler.indexOf('readModelOptions()');
  assert.ok(guard > -1 && read > -1 && guard < read,
    'the guard runs after the menu is already open, which is not a guard');
});

// The negative control: the guard must not have swallowed the feature.
test('and still reads the picker when nothing is being injected', () => {
  const handler = bridge.slice(bridge.indexOf("case 'discover_models':"), bridge.indexOf("case 'switch_model':"));
  assert.match(handler, /readModelOptions\(\)[\s\S]*model_options/,
    'discovery no longer answers at all');
});
