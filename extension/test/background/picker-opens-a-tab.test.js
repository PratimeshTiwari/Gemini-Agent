/**
 * A picker operation you asked for may open the tab it needs.
 *
 * This is the root of "the effort never changes", and it survived two fixes
 * aimed at the wrong layer because every *other* stage genuinely works —
 * measured against the live page in a hidden tab: menu open 41.9ms, a full
 * read 27.7ms returning all four options with `selected` correct, and the real
 * matcher resolving that list to `3.1 Pro` for the pro rung.
 *
 * What none of them could do is **get a tab**. `sendToModelTab` uses the lane's
 * existing tab; the inject path has always had `ensureModelTab`, which opens
 * one when there is none. So the picker could only be read *after* the first
 * prompt had already gone out — and `/effort` is typed *before* the first
 * prompt almost every time. It printed "asked the browser for Gemini Pro" and
 * nothing ever followed, which reads like a status rather than a dead end.
 *
 * 1.28.2 moved discovery onto tab *creation*, which fixed the connect-time ask
 * and not this one: tabs are created by injects, so a session that opens with
 * `/effort` still had none. Reported again immediately, with a transcript of
 * three `/effort` commands in a row on a fresh session.
 *
 * `userInitiated` is the whole safety argument. A background poll must never
 * make a window appear to answer a question nobody asked. A command you typed
 * and are waiting on is the opposite case.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const socket = readFileSync(join(here, '../../src/background/socket.js'), 'utf8');
const loop = readFileSync(
  join(here, '../../../server/src/core/agent-loop.js'), 'utf8',
);
const slash = readFileSync(
  join(here, '../../../server/src/core/slash-commands.js'), 'utf8',
);

/**
 * The `discover_models` / `switch_model` arm of the worker's dispatch, **with
 * its comments removed**.
 *
 * The first cut of this file asserted on the raw slice and failed, because the
 * comment above the code names `sendToModelTab` before `ensureModelTab` while
 * the code calls them the other way round. A source-scraping test that reads
 * prose is measuring the wrong thing in both directions: it can fail on
 * correct code, and it can pass on code that only *talks* about the call.
 */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const arm = stripComments(socket.slice(
  socket.indexOf("case 'discover_models':"),
  socket.indexOf("case 'heartbeat_ack':"),
));

test('the worker can open a tab for a picker op you asked for', () => {
  assert.match(arm, /ensureModelTab/,
    'a picker op still cannot get a tab, so /effort before the first prompt does nothing');
});

test('it opens one before trying to send, not after', () => {
  const open = arm.indexOf('ensureModelTab');
  const send = arm.indexOf('sendToModelTab');
  assert.ok(open > -1 && send > -1);
  assert.ok(open < send, 'the send runs first and fails, which is the bug unchanged');
});

/*
 * The negative control, and the reason this is safe to do at all. Without it
 * the same line would make a Gemini window appear during a background poll —
 * once a turn, forever — which is a worse bug than the one being fixed.
 */
test('a background poll never opens one', () => {
  assert.match(arm, /payload\?\.userInitiated\s*&&/,
    'the tab is opened unconditionally; the once-a-turn poll now spawns windows');
});

// A batch task's tab is its own. Opening a main tab for it would answer the
// question about the wrong picker entirely.
test('and a session-scoped ask is left alone', () => {
  assert.match(arm, /!payload\?\.sessionId/,
    'a subagent effort switch would open a main tab and read the wrong picker');
});

test('the server marks the ask, and only /effort sets it', () => {
  assert.match(loop, /requestModelOptions\(userInitiated = false\)/,
    'the flag defaults to true somewhere, which makes every poll a tab-opener');
  assert.match(loop, /_toExtension\('discover_models',\s*\{\s*userInitiated\s*\}\)/);

  // `/effort` is the one caller that asked on your behalf.
  assert.match(slash, /requestModelOptions\?\.\(true\)/,
    'the one command a person waits on is still the one that cannot get a tab');
});

test('the end-of-turn poll stays background', () => {
  // It is the bare call, which takes the `false` default.
  const poll = loop.slice(loop.indexOf('this._lastModelPoll = now'));
  assert.match(poll.slice(0, 200), /this\.requestModelOptions\(\)/,
    'the background poll is passing a flag; check it is not `true`');
});
