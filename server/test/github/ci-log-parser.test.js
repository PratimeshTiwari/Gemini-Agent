/**
 * What the CI parser actually does, pinned before anything moves.
 *
 * 198 lines that turn a GitHub Actions log into the report the model is asked
 * to act on, and it has never had a test. These are **characterisation** tests:
 * they describe the shipped behaviour, including the parts that look like
 * accidents, so the restructure in phases 6-8 has something to move against.
 * Where the behaviour is arguably wrong the test says so rather than asserting
 * the improvement — changing it is a separate decision from making it visible.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { CILogParser } from '../../src/github/ci-log-parser.js';

const parse = (logText, over = {}) => new CILogParser().parse({
  logText, workflowName: 'CI', runId: '42', conclusion: 'failure', ...over,
});

describe('steps and errors', () => {
  test('a failed step is named from the group it is inside', () => {
    const r = parse([
      '##[group]Run npm test',
      'some output',
      '##[error]Process completed with exit code 1',
    ].join('\n'));
    assert.deepEqual(r.failedSteps, ['Run npm test']);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].step, 'Run npm test');
  });

  test('a step is listed once however many errors it has', () => {
    const r = parse([
      '##[group]Run lint',
      '##[error]first',
      '##[error]second',
    ].join('\n'));
    assert.deepEqual(r.failedSteps, ['Run lint']);
  });

  test('an error before any group is captured but belongs to no step', () => {
    const r = parse('##[error]something broke early');
    assert.deepEqual(r.failedSteps, [], 'there was no group to attribute it to');
    assert.equal(r.errors.length, 0, 'and the buffer is only flushed for a step');
  });

  test('the error message is capped at twenty lines, with the rest kept', () => {
    const lines = ['##[group]Run build', '##[error]start'];
    for (let i = 0; i < 40; i += 1) lines.push(`line ${i}`);
    const r = parse(lines.join('\n'));
    assert.equal(r.errors[0].message.split('\n').length, 20);
    assert.ok(r.errors[0].fullOutput.split('\n').length > 20, 'the tail is kept for later');
  });
});

describe('lint violations', () => {
  test('the ESLint format is picked apart', () => {
    const r = parse('src/app.js:10:5: error Unexpected console statement (no-console)');
    assert.deepEqual(r.lintViolations, [{
      file: 'src/app.js', line: 10, column: 5,
      severity: 'error', message: 'Unexpected console statement', rule: 'no-console',
    }]);
  });

  test('a warning is kept, not only errors', () => {
    const r = parse('a.js:1:1: warning Prefer const (prefer-const)');
    assert.equal(r.lintViolations[0].severity, 'warning');
  });

  test('the Prettier line is matched loosely, and that is worth knowing', () => {
    // The pattern is `<anything> ... error`, which is broad enough to catch
    // ordinary log prose. Characterised rather than fixed: narrowing it is a
    // behaviour change and belongs to whoever is looking at this on purpose.
    const r = parse('Checking src/a.js ... error');
    assert.equal(r.lintViolations[0].rule, 'prettier');

    const collateral = parse('Waiting for deploy ... error');
    assert.equal(collateral.lintViolations.length, 1,
      'a sentence that is not about a file is read as a formatting violation');
  });
});

describe('test failures', () => {
  test('a failing suite is captured with its assertions', () => {
    const r = parse([
      'FAIL src/thing.test.js',
      '● Thing › does the thing',
      '● Thing › does the other thing',
    ].join('\n'));
    assert.equal(r.testFailures.length, 1);
    assert.equal(r.testFailures[0].file, 'src/thing.test.js');
    assert.deepEqual(r.testFailures[0].details, ['Thing › does the thing', 'Thing › does the other thing']);
  });

  test('an assertion with no suite above it is dropped', () => {
    // `report.testFailures.length > 0` gates it, so a bullet before any FAIL
    // line has nowhere to attach and is lost.
    const r = parse('● orphan assertion');
    assert.equal(r.testFailures.length, 0);
  });

  test('an AssertionError is recorded with surrounding context', () => {
    const r = parse(['before', 'AssertionError: 1 !== 2', 'after'].join('\n'));
    assert.equal(r.errors[0].type, 'assertion_error');
    assert.match(r.errors[0].context, /before/);
    assert.match(r.errors[0].context, /after/);
  });

  test('a stack trace attaches to the error above it', () => {
    const r = parse(['AssertionError: boom', '    at go (file.js:1:1)'].join('\n'));
    assert.deepEqual(r.errors[0].stackTrace, ['at go (file.js:1:1)']);
  });
});

describe('the summary is what the model reads first', () => {
  test('it names each category that has anything in it', () => {
    const r = parse([
      '##[group]Run test',
      '##[error]failed',
      'a.js:1:1: error Bad (rule)',
      'FAIL b.test.js',
    ].join('\n'));
    assert.match(r.summary, /Failed Steps/);
    assert.match(r.summary, /Lint Violations/);
    assert.match(r.summary, /Test Failures/);
    assert.match(r.summary, /Errors/);
  });

  test('a clean log says so rather than being empty', () => {
    assert.equal(parse('everything was fine').summary, 'No specific failures parsed');
  });

  test('an empty log does not throw', () => {
    const r = parse('');
    assert.equal(r.summary, 'No specific failures parsed');
    assert.deepEqual(r.failedSteps, []);
  });
});

describe('parseCompact — when the log could not be fetched', () => {
  test('it reports the jobs it was given', () => {
    const r = new CILogParser().parseCompact({
      workflowName: 'CI', runId: '7', conclusion: 'failure', failedJobs: ['build', 'test'],
    });
    assert.deepEqual(r.failedSteps, ['build', 'test']);
    assert.match(r.summary, /build, test/);
  });

  test('with no jobs it says unknown rather than nothing', () => {
    const r = new CILogParser().parseCompact({ workflowName: 'CI', runId: '7', conclusion: 'failure' });
    assert.match(r.summary, /unknown/);
    assert.deepEqual(r.failedSteps, []);
  });

  test('the shape matches parse(), so callers need not care which ran', () => {
    const full = parse('');
    const compact = new CILogParser().parseCompact({ workflowName: 'CI', runId: '1', conclusion: 'failure' });
    assert.deepEqual(Object.keys(full).sort(), Object.keys(compact).sort());
  });
});
