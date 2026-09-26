import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, existsSync, appendFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { logTrace, readTraces, summariseTraces, percentile, formatMs } from '../../src/core/trace-log.js';

let ws;
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'trace-')); });
after(() => { try { rmSync(ws, { recursive: true, force: true }); } catch {} });

describe('percentile — a reported number is one that really happened', () => {
  test('nearest-rank, so nothing is interpolated into existence', () => {
    const v = [10, 20, 30, 40, 50];
    assert.equal(percentile(v, 50), 30);
    assert.equal(percentile(v, 90), 50);
    assert.equal(percentile(v, 100), 50);
    // Every answer is a member of the input.
    for (const p of [10, 25, 50, 75, 90]) assert.ok(v.includes(percentile(v, p)));
  });

  test('order does not matter', () => {
    assert.equal(percentile([50, 10, 40, 20, 30], 50), 30);
  });

  test('nothing measured is null, not zero', () => {
    assert.equal(percentile([], 50), null);
    assert.equal(percentile(undefined, 50), null);
  });

  test('one sample is its own median and tail', () => {
    assert.equal(percentile([7], 50), 7);
    assert.equal(percentile([7], 90), 7);
  });
});

describe('logTrace / summariseTraces', () => {
  test('nothing logged summarises to nothing', () => {
    const s = summariseTraces(ws);
    assert.equal(s.samples, 0);
    assert.deepEqual(s.stages, []);
  });

  test('records stages and reports the distribution per stage', () => {
    for (const ms of [100, 200, 300, 400, 900]) {
      logTrace(ws, { stages: { find_input: ms, complete: ms * 10 } });
    }
    const s = summariseTraces(ws);
    assert.equal(s.samples, 5);
    const find = s.stages.find((x) => x.stage === 'find_input');
    assert.equal(find.n, 5);
    assert.equal(find.median, 300);
    assert.equal(find.p90, 900, 'the tail is the part people notice');
  });

  test('stages come back in the order they happen, not alphabetically', () => {
    logTrace(ws, { stages: { complete: 5, find_input: 1, send: 3, type: 2, first_token: 4 } });
    assert.deepEqual(
      summariseTraces(ws).stages.map((s) => s.stage),
      ['find_input', 'type', 'send', 'first_token', 'complete'],
    );
  });

  test('an unknown stage is kept, and sorts last rather than being dropped', () => {
    logTrace(ws, { stages: { find_input: 1, paste_image: 9 } });
    const stages = summariseTraces(ws).stages.map((s) => s.stage);
    assert.deepEqual(stages, ['find_input', 'paste_image']);
  });

  /** Instrumentation that can fail a turn is worse than no instrumentation. */
  test('rubbish is ignored rather than thrown', () => {
    for (const bad of [null, undefined, {}, { stages: {} }, { stages: { a: 'x' } },
      { stages: { a: -1 } }, { stages: { a: NaN } }, 'nope', 42]) {
      assert.doesNotThrow(() => logTrace(ws, bad), JSON.stringify(bad));
    }
    assert.equal(summariseTraces(ws).samples, 0);
  });

  test('an unwritable workspace does not throw', () => {
    assert.doesNotThrow(() => logTrace('/proc/nope/nowhere', { stages: { find_input: 1 } }));
  });

  test('a half-written line does not lose the rest of the file', () => {
    logTrace(ws, { stages: { find_input: 10 } });
    const file = join(ws, '.agent', 'logs', 'traces.jsonl');
    assert.ok(existsSync(file));
    appendFileSync(file, '{"time":"broken\n');
    logTrace(ws, { stages: { find_input: 20 } });
    assert.equal(readTraces(ws).length, 2);
  });

  test('only the most recent are read, so the file cannot grow into the report', () => {
    for (let i = 0; i < 60; i++) logTrace(ws, { stages: { find_input: i } });
    assert.equal(readTraces(ws, { limit: 10 }).length, 10);
    assert.equal(summariseTraces(ws, { limit: 10 }).samples, 10);
  });
});

describe('formatMs — the unit people would say out loud', () => {
  test('milliseconds below a second, seconds above', () => {
    assert.equal(formatMs(340), '340ms');
    assert.equal(formatMs(999), '999ms');
    assert.equal(formatMs(1000), '1.0s');
    assert.equal(formatMs(2145), '2.1s');
  });
  test('nothing measured says so', () => {
    assert.equal(formatMs(null), '—');
    assert.equal(formatMs(undefined), '—');
  });
});

/**
 * The rung rides on the record, and is read back.
 *
 * Asked on 2026-09-24 as the basis for routing cheap work to a Flash tab: is
 * Flash actually cheaper per round trip than Pro? The trace log had every other
 * part of the answer — `first_token`, `complete`, one row per turn — and could
 * not be split by which model in the picker ran, because the only identifying
 * field was `model`, and `model` is always `gemini`.
 *
 * Recorded **and** summarised in one change. This repo has twice shipped a
 * value that was written and never carried back (`getAllMemories` with no
 * callers, `task.md` that no prompt returned), and both times the work was
 * spent for nothing. A per-rung field with no per-rung view is the third.
 */
describe('traces carry the effort rung', () => {
  test('it is written when known', () => {
    logTrace(ws, { model: 'gemini', effort: 'high', stages: { complete: 4000 } });
    assert.equal(readTraces(ws)[0].effort, 'high');
  });

  // Old rows have no rung and must stay valid — the field is new.
  test('and left off entirely when it is not', () => {
    logTrace(ws, { model: 'gemini', stages: { complete: 4000 } });
    assert.ok(!('effort' in readTraces(ws)[0]), 'absent, not null or ""');
  });

  test('the split reports the two stages the model decides', () => {
    logTrace(ws, { effort: 'low', stages: { first_token: 1000, complete: 2000, send: 70 } });
    logTrace(ws, { effort: 'low', stages: { first_token: 3000, complete: 4000, send: 70 } });
    logTrace(ws, { effort: 'high', stages: { first_token: 9000, complete: 8000, send: 70 } });

    const { efforts } = summariseTraces(ws);
    const lite = efforts.find((e) => e.effort === 'low');
    const pro = efforts.find((e) => e.effort === 'high');

    assert.equal(lite.n, 2);
    // Nearest-rank: ceil(0.5 * 2) = 1, so the median of two samples is the
    // lower one. Every reported number is one that really happened, which is
    // the property `percentile` is tested for above.
    assert.equal(lite.firstToken, 1000, 'nearest-rank median of [1000, 3000]');
    assert.equal(pro.n, 1);
    assert.equal(pro.firstToken, 9000);
    // Busiest rung first: with one rung the row is noise, and the caller hides
    // the whole block below two.
    assert.equal(efforts[0].effort, 'low');
  });

  test('a log with no rungs at all offers an empty split, not a crash', () => {
    logTrace(ws, { stages: { complete: 1000 } });
    const { efforts, samples } = summariseTraces(ws);
    assert.equal(samples, 1);
    assert.deepEqual(efforts, []);
  });
});
