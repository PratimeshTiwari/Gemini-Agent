/**
 * Which tools the model actually reaches for — recorded, so the claim can be
 * checked rather than remembered.
 *
 * CLAUDE.md measured this once by hand: 41 sessions, 529 calls, **eight of the
 * eighteen tools never called once**. It draws a real conclusion from that —
 * *"the lever for an unused tool is never 'name it again' — it is a trigger at
 * the moment of relevance"* — and the decisions resting on it have stayed
 * gated for days because the measurement was not repeatable.
 *
 * It could not be recovered afterwards either. `_extractToolCalls` strips the
 * calls out of a reply before the cleaned text reaches the session history, so
 * counting them from `history.jsonl` finds nothing: a probe that tried
 * returned `0 of 2790`, and every one of those 2790 was a `"name"` key inside
 * a tool *result*. The data was only ever in flight.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logToolUsage, summariseToolUsage } from '../../src/core/tool-usage.js';

const ws = () => mkdtempSync(join(tmpdir(), 'tool-usage-'));
const CATALOG = ['read_file', 'grep_search', 'ask_subagent', 'find_symbol', 'manage_task'];

test('a turn is one row, whatever it called', () => {
  const w = ws();
  logToolUsage(w, new Map([['read_file', 3], ['grep_search', 1]]));
  logToolUsage(w, new Map([['read_file', 1]]));

  const u = summariseToolUsage(w, CATALOG);
  assert.equal(u.turns, 2);
  assert.equal(u.calls, 5);
  assert.equal(u.rows[0].name, 'read_file');
  assert.equal(u.rows[0].count, 4);
});

/*
 * The whole point of the feature. A list derived from what was *seen* cannot
 * contain what was never seen, so `neverCalled` is taken from the catalog.
 */
test('the tools nobody called are named, from the catalog', () => {
  const w = ws();
  logToolUsage(w, new Map([['read_file', 1]]));

  const u = summariseToolUsage(w, CATALOG);
  assert.deepEqual(u.neverCalled, ['ask_subagent', 'find_symbol', 'grep_search', 'manage_task']);
});

test('and none are claimed unused when all were called', () => {
  const w = ws();
  logToolUsage(w, new Map(CATALOG.map((n) => [n, 1])));
  assert.deepEqual(summariseToolUsage(w, CATALOG).neverCalled, []);
});

/*
 * A turn that called nothing is data, not a gap — it is exactly what
 * `turn0_no_tools` is about, and skipping it would make the denominator lie.
 */
test('a turn with no tool calls is still a turn', () => {
  const w = ws();
  logToolUsage(w, new Map());
  logToolUsage(w, new Map([['read_file', 1]]));

  const u = summariseToolUsage(w, CATALOG);
  assert.equal(u.turns, 2, 'the quiet turn vanished, so every share is overstated');
  assert.equal(u.turnsWithNoTools, 1);
  assert.equal(u.calls, 1);
});

test('shares are of calls, and add up', () => {
  const w = ws();
  logToolUsage(w, new Map([['read_file', 3], ['grep_search', 1]]));
  const u = summariseToolUsage(w, CATALOG);
  const total = u.rows.reduce((n, r) => n + r.share, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `shares sum to ${total}`);
  assert.equal(u.rows.find((r) => r.name === 'read_file').share, 0.75);
});

test('reading a workspace that has never recorded anything is empty, not a throw', () => {
  const u = summariseToolUsage(ws(), CATALOG);
  assert.equal(u.turns, 0);
  assert.equal(u.calls, 0);
  assert.deepEqual(u.rows, []);
  assert.deepEqual(u.neverCalled, [...CATALOG].sort(), 'an empty log should indict every tool');
});

/*
 * Instrumentation that can fail a turn is worse than no instrumentation —
 * the same rule `trace-log.js` and `error-log.js` both follow.
 */
test('rubbish in is dropped, and never thrown', () => {
  const w = ws();
  assert.doesNotThrow(() => logToolUsage(w, null));
  assert.doesNotThrow(() => logToolUsage(w, { read_file: 'lots' }));
  assert.doesNotThrow(() => logToolUsage(w, { '': 2, read_file: -1, ok: 2 }));
  assert.doesNotThrow(() => logToolUsage('/nowhere/at/all', new Map([['read_file', 1]])));

  const u = summariseToolUsage(w, CATALOG);
  assert.deepEqual(u.rows.map((r) => r.name), ['ok'], 'a bad name or count was counted');
});

test('a corrupt line does not take the rest of the file with it', () => {
  const w = ws();
  logToolUsage(w, new Map([['read_file', 1]]));
  const file = join(w, '.agent', 'logs', 'tool-usage.jsonl');
  const kept = readFileSync(file, 'utf8');
  // A half-written line is what a crash mid-append leaves behind.
  appendFileSync(file, '{"time":"broken"\n');
  appendFileSync(file, kept);

  const u = summariseToolUsage(w, CATALOG);
  assert.equal(u.turns, 2, 'one unparseable line discarded every row after it');
});
