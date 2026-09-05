/**
 * format — Unit Tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { oneLine, summarizeResult, clampForDisplay } from './format.js';

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
