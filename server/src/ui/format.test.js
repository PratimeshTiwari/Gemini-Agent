/**
 * format — Unit Tests
 */

import { describe, it, test } from 'node:test';
import assert from 'node:assert';
import { oneLine, summarizeResult, clampForDisplay, formatCommandResult, formatTokenExpiry } from './format.js';

describe('oneLine', () => {
  it('collapses whitespace to a single line', () => {
    assert.strictEqual(oneLine('a\n  b\t c'), 'a b c');
  });

  it('truncates past the limit with an ellipsis', () => {
    const out = oneLine('abcdefghij', 5);
    assert.strictEqual(out, 'abcd…');
    assert.strictEqual(out.length, 5);
  });

  it('stringifies non-strings', () => {
    assert.strictEqual(oneLine({ a: 1 }), '{"a":1}');
    assert.strictEqual(oneLine(null), '{}');
  });
});

describe('summarizeResult', () => {
  it('counts directory entries', () => {
    assert.strictEqual(summarizeResult('list_directory', { totalDirs: 2, totalFiles: 1 }), '2 dirs, 1 file');
    assert.strictEqual(summarizeResult('list_directory', { children: [1, 2] }), '2 entries');
  });

  it('reports file size in lines', () => {
    assert.strictEqual(summarizeResult('read_file', { totalLines: 1, size: '2kb' }), '1 line · 2kb');
  });

  it('counts matches across the search tools', () => {
    assert.strictEqual(summarizeResult('grep_search', { matchCount: 3 }), '3 matches');
    assert.strictEqual(summarizeResult('search_files', { files: ['a'] }), '1 match');
  });

  it('takes the first line of command output', () => {
    assert.strictEqual(summarizeResult('run_command', { stdout: 'first\nsecond' }), 'first');
  });

  it('names the edited file and its hunks', () => {
    assert.strictEqual(summarizeResult('edit_file', { filePath: '/a/b/c.js', hunkCount: 2 }), '2 hunks in c.js');
    assert.strictEqual(summarizeResult('create_file', { filePath: '/a/b/c.js' }), 'c.js');
  });

  it('falls back to a compact snippet for anything else', () => {
    assert.strictEqual(summarizeResult('unknown_tool', { z: 1 }), '{"z":1}');
  });
});

describe('clampForDisplay', () => {
  it('leaves short output alone', () => {
    assert.strictEqual(clampForDisplay('one\ntwo'), 'one\ntwo');
  });

  it('clamps by line count', () => {
    const out = clampForDisplay('a\nb\nc\nd', 2);
    assert.strictEqual(out, 'a\nb\n... [truncated]');
  });

  it('clamps by character count — one long line is what actually tears the terminal', () => {
    const out = clampForDisplay('x'.repeat(50), 15, 10);
    assert.strictEqual(out, `${'x'.repeat(10)}\n... [truncated]`);
  });

  it('pretty-prints non-strings', () => {
    assert.ok(clampForDisplay({ a: 1 }).includes('"a": 1'));
  });
});


describe('formatCommandResult — a shell result should look like a shell', () => {
  test('shows the command, its output and a non-zero exit', () => {
    const out = formatCommandResult({
      command: 'npm run build',
      exitCode: 1,
      stdout: 'building...',
      stderr: 'Error: Cannot find module ./config',
    });
    assert.match(out, /^\$ npm run build/);
    assert.match(out, /Cannot find module/);
    assert.match(out, /✗ exit 1/);
  });

  test('does not shout about a successful command', () => {
    const out = formatCommandResult({ command: 'git add -A', exitCode: 0, stdout: '', stderr: '' });
    assert.ok(!out.includes('exit'), 'exit 0 is the expected case and needs no marker');
    assert.match(out, /\(no output\)/);
  });

  test('says so when the command timed out', () => {
    const out = formatCommandResult({ command: 'sleep 99', exitCode: -1, stdout: '', timedOut: true });
    assert.match(out, /timed out/);
    assert.ok(!out.includes('(no output)'), 'a timeout explains itself');
  });

  test('clamps a wall of output', () => {
    const out = formatCommandResult({ command: 'cat big', exitCode: 0, stdout: 'line\n'.repeat(500) }, 5);
    assert.ok(out.split('\n').length < 12, 'must not paste 500 lines into the frame');
    assert.match(out, /truncated/);
  });

  test('returns null for anything that is not a shell result', () => {
    // The caller falls back to the generic renderer, so this must not guess.
    assert.equal(formatCommandResult({ path: '.', totalFiles: 8 }), null);
    assert.equal(formatCommandResult('plain string'), null);
    assert.equal(formatCommandResult(null), null);
  });
});

describe('formatTokenExpiry', () => {
  const now = Date.parse('2026-09-10T12:00:00Z');
  const inDays = (n) => new Date(now + n * 86400000).toISOString();

  it('says ok when GitHub reports no expiry at all', () => {
    assert.deepEqual(formatTokenExpiry(null, false, now), { label: 'token ok', tone: 'green' });
  });

  it('says ok while the expiry is comfortably far off', () => {
    assert.deepEqual(formatTokenExpiry(inDays(60), false, now), { label: 'token ok', tone: 'green' });
  });

  it('counts down inside the last week, when it becomes a task', () => {
    assert.deepEqual(formatTokenExpiry(inDays(3), false, now), {
      label: 'token expires in 3d', tone: 'yellow',
    });
  });

  it('calls out the last day', () => {
    assert.equal(formatTokenExpiry(inDays(0.5), false, now).label, 'token expires today');
  });

  it('says expired once the date has passed', () => {
    assert.deepEqual(formatTokenExpiry(inDays(-1), false, now), {
      label: 'token expired', tone: 'red',
    });
  });

  // A revoked token and a lapsed one both come back as 401. Only the date can
  // tell them apart, and once the token is refused the date is beside the point.
  it('a refused token outranks whatever the date said', () => {
    assert.deepEqual(formatTokenExpiry(inDays(60), true, now), {
      label: 'token rejected', tone: 'red',
    });
  });

  it('survives a date it cannot parse', () => {
    assert.equal(formatTokenExpiry('not a date', false, now).tone, 'green');
  });
});
