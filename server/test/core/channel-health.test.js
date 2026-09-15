/**
 * How often the text channel fails, as a rate rather than a list.
 *
 * There is no tool-call API here — tool calls are parsed out of prose — and
 * `CLAUDE.md` records whether to add an API backend as a fork, then says the
 * honest thing about it: any claim about how far behind the text channel is
 * stays an estimate until this view exists. Every number has been logged for
 * months and nobody has read them.
 *
 * Two things have to be right or the number is worse than none: the
 * **denominator**, which is turns the browser answered and not turns attempted;
 * and the **weighting**, because `errors.jsonl` collapses repeats inside a 60s
 * window and counting lines reports a storm of 500 as 1.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { channelHealth, formatRate, MIN_TURNS_FOR_RATE, CHANNEL_OPS } from '../../src/core/channel-health.js';

let ws;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'ch-'));
  mkdirSync(join(ws, '.agent', 'logs'), { recursive: true });
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

const writeErrors = (records) => writeFileSync(
  join(ws, '.agent', 'logs', 'errors.jsonl'),
  records.map((r) => JSON.stringify({ time: new Date().toISOString(), flow: 'agent', ...r })).join('\n') + '\n',
);

const writeTurns = (n) => writeFileSync(
  join(ws, '.agent', 'logs', 'traces.jsonl'),
  Array.from({ length: n }, () => JSON.stringify({ time: Date.now(), model: 'gemini', stages: { complete: 1000 } })).join('\n') + '\n',
);

describe('the rate needs a denominator worth dividing by', () => {
  test('an empty log is zeros, not a crash', () => {
    const h = channelHealth(ws);
    assert.equal(h.turns, 0);
    assert.equal(h.total, 0);
    assert.equal(h.rows.length, CHANNEL_OPS.length);
    assert.equal(h.rows[0].rate, null);
  });

  test('too few turns gives counts and withholds the percentage', () => {
    writeTurns(3);
    writeErrors([{ op: 'parse_tool_calls', message: 'x' }]);
    const h = channelHealth(ws);
    assert.equal(h.enough, false);
    const row = h.rows.find((r) => r.op === 'parse_tool_calls');
    assert.equal(row.count, 1, 'the count is real and is still shown');
    assert.equal(row.rate, null, '1 in 3 is 33% and means nothing');
  });

  test('past the floor, the rate appears', () => {
    writeTurns(MIN_TURNS_FOR_RATE);
    writeErrors([{ op: 'provider_error', message: 'x' }]);
    const h = channelHealth(ws);
    assert.equal(h.enough, true);
    assert.equal(h.rows.find((r) => r.op === 'provider_error').rate, 1 / MIN_TURNS_FOR_RATE);
  });
});

describe('collapsed repeats are counted, not lost', () => {
  test('a tally line stands for its repeats', () => {
    writeTurns(100);
    writeErrors([
      { op: 'provider_error', message: 'boom' },
      { op: 'provider_error', message: 'boom', tally: true, repeatedSince: 499 },
    ]);
    const h = channelHealth(ws);
    assert.equal(h.rows.find((r) => r.op === 'provider_error').count, 500,
      'a storm of 500 was reported as 2');
  });
});

describe('only the channel\'s own failures count', () => {
  test('a poller failure is not a text-channel failure', () => {
    writeTurns(100);
    writeErrors([
      { op: 'poll', flow: 'github', message: '401' },
      { op: 'tool_amnesia', message: 'I cannot run commands' },
    ]);
    const h = channelHealth(ws);
    assert.equal(h.total, 1);
    assert.equal(h.rows.find((r) => r.op === 'tool_amnesia').count, 1);
  });

  test('every op named is one the code actually logs', () => {
    // A row for an op nothing writes reads as "this never happens", which is
    // exactly the shape of the bug it would be hiding — and renaming an op in
    // `agent-loop.js` is how that happens without anyone deciding to.
    const src = readFileSync(new URL('../../src/core/agent-loop.js', import.meta.url), 'utf8');
    for (const { op } of CHANNEL_OPS) {
      assert.ok(src.includes(`op: '${op}'`),
        `channel-health reports "${op}" and nothing in agent-loop.js writes it`);
    }
  });
});

describe('formatRate', () => {
  test('no rate is a dash, not a zero', () => {
    assert.equal(formatRate(null), '—');
    assert.equal(formatRate(undefined), '—');
  });

  test('a real zero is a zero', () => {
    assert.equal(formatRate(0), '0%');
  });

  test('a tiny rate does not round to nothing', () => {
    assert.equal(formatRate(0.0001), '<0.1%', '1 in 10,000 reading as 0.0% looks like none');
    assert.equal(formatRate(0.05), '5.0%');
  });
});
