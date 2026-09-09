import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { logError, flowLogger, readErrors, summarizeErrors, clearErrors, FLOWS } from './error-log.js';

const fresh = () => fs.mkdtempSync(path.join(os.tmpdir(), 'errlog-'));

test('logError', async (t) => {
  await t.test('writes one line per failure, tagged with its flow', () => {
    const ws = fresh();
    logError(ws, { flow: 'extension', op: 'scrape', message: 'Response block never appeared' });
    const [entry] = readErrors(ws);
    assert.equal(entry.flow, 'extension');
    assert.equal(entry.op, 'scrape');
    assert.match(entry.message, /never appeared/);
  });

  await t.test('collapses identical failures instead of burying everything else', () => {
    // A poller failing every tick wrote the same line hundreds of times.
    const ws = fresh();
    for (let i = 0; i < 50; i++) {
      logError(ws, { flow: 'github', op: 'poll', message: '401 Bad credentials' });
    }
    assert.equal(readErrors(ws).length, 1, 'one line on disk');
    assert.equal(summarizeErrors(ws).total, 50, 'but all 50 are still counted');

    logError(ws, { flow: 'github', op: 'poll', message: 'a different failure' });
    assert.equal(summarizeErrors(ws).total, 51, 'and the first occurrence is not double-counted');
    assert.equal(summarizeErrors(ws).byFlow[0].count, 51);
  });

  await t.test('never throws, whatever it is handed', () => {
    // Every caller is already on a failure path; this must not add another.
    assert.doesNotThrow(() => logError(null, { flow: 'agent', message: 'x' }));
    assert.doesNotThrow(() => logError(fresh(), null));
    assert.doesNotThrow(() => logError(fresh(), { flow: 'agent' }));
    assert.doesNotThrow(() => logError('/root/not-writable-xyz', { flow: 'agent', message: 'x' }));
  });

  await t.test('truncates a detail rather than writing a core dump', () => {
    const ws = fresh();
    logError(ws, { flow: 'tool', op: 'run_command', message: 'boom', detail: 'x'.repeat(9000) });
    const [entry] = readErrors(ws);
    assert.ok(entry.detail.length < 2200);
    assert.match(entry.detail, /\+\d+ chars/);
  });

  await t.test('keeps only the first line of a multi-line message', () => {
    const ws = fresh();
    logError(ws, { flow: 'agent', message: 'headline\nstack line\nstack line' });
    assert.equal(readErrors(ws)[0].message, 'headline');
  });
});

test('summarizeErrors', async (t) => {
  await t.test('answers "what is breaking", worst flow first', () => {
    const ws = fresh();
    logError(ws, { flow: 'tool', op: 'run_command', message: 'a' });
    logError(ws, { flow: 'github', op: 'poll', message: 'b' });
    logError(ws, { flow: 'github', op: 'comments', message: 'c' });
    const summary = summarizeErrors(ws);
    assert.equal(summary.byFlow[0].flow, 'github');
    assert.equal(summary.byFlow[0].count, 2);
    assert.equal(summary.total, 3);
  });

  await t.test('is empty and calm when nothing has failed', () => {
    const summary = summarizeErrors(fresh());
    assert.equal(summary.total, 0);
    assert.deepEqual(summary.byFlow, []);
  });

  await t.test('labels every flow it reports', () => {
    const ws = fresh();
    for (const flow of Object.keys(FLOWS)) logError(ws, { flow, message: `${flow} broke` });
    for (const bucket of summarizeErrors(ws).byFlow) {
      assert.equal(bucket.label, FLOWS[bucket.flow]);
    }
  });
});

test('readErrors and clearErrors', async (t) => {
  await t.test('filters to one flow', () => {
    const ws = fresh();
    logError(ws, { flow: 'tool', message: 'tool one' });
    logError(ws, { flow: 'bridge', message: 'bridge one' });
    const got = readErrors(ws, { flow: 'bridge' });
    assert.equal(got.length, 1);
    assert.equal(got[0].flow, 'bridge');
  });

  await t.test('returns newest first', () => {
    const ws = fresh();
    logError(ws, { flow: 'agent', message: 'older' });
    logError(ws, { flow: 'agent', message: 'newer' });
    assert.equal(readErrors(ws)[0].message, 'newer');
  });

  await t.test('clear empties it and reports how much went', () => {
    const ws = fresh();
    logError(ws, { flow: 'agent', message: 'one' });
    logError(ws, { flow: 'agent', message: 'two' });
    assert.equal(clearErrors(ws), 2);
    assert.deepEqual(readErrors(ws), []);
  });

  await t.test('a bound flowLogger writes the same shape', () => {
    const ws = fresh();
    flowLogger(ws, 'context')('index', 'madge blew up');
    const [entry] = readErrors(ws);
    assert.equal(entry.flow, 'context');
    assert.equal(entry.op, 'index');
  });
});
