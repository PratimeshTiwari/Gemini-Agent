import { test, describe } from 'node:test';
import assert from 'node:assert';
import { rowsFromPatch } from '../../src/ui/diff-preview.js';

describe('rowsFromPatch — the transcript only has the patch string', () => {
  const patch = [
    'Index: x.js',
    '===================================================================',
    '--- x.js\toriginal',
    '+++ x.js\tmodified',
    '@@ -1,4 +1,4 @@',
    ' const a = 1;',
    '-const b = 2;',
    '+const b = 22;',
    ' const c = 3;',
    ' const d = 4;',
    '',
  ].join('\n');

  test('classifies each line and numbers both sides', () => {
    const rows = rowsFromPatch(patch);
    assert.deepEqual(
      rows.map((r) => [r.type, r.oldNo, r.newNo]),
      [
        ['header', null, null],
        ['ctx', 1, 1],
        ['del', 2, null],
        ['add', null, 2],
        ['ctx', 3, 3],
        ['ctx', 4, 4],
      ],
    );
  });

  test('drops the file headers, which the tool row already said', () => {
    const text = rowsFromPatch(patch).map((r) => r.text).join('\n');
    assert.doesNotMatch(text, /^---/m);
    assert.doesNotMatch(text, /^\+\+\+/m);
    assert.doesNotMatch(text, /^Index:/m);
  });

  test('a removed line advances only the old side, an added line only the new', () => {
    const rows = rowsFromPatch(patch);
    const del = rows.find((r) => r.type === 'del');
    const add = rows.find((r) => r.type === 'add');
    assert.equal(del.newNo, null);
    assert.equal(add.oldNo, null);
  });

  test('caps at maxLines and says how many it dropped', () => {
    const big = ['@@ -1,20 +1,20 @@', ...Array.from({ length: 20 }, (_, i) => `+line ${i}`)].join('\n');
    const rows = rowsFromPatch(big, { maxLines: 5 });
    assert.equal(rows.filter((r) => r.type === 'add').length, 5);
    assert.equal(rows[rows.length - 1].type, 'more');
    assert.match(rows[rows.length - 1].text, /15 more lines/);
  });

  test('a second hunk restarts the numbering from its own header', () => {
    const two = [
      '@@ -1,1 +1,1 @@', '-a', '+A',
      '@@ -50,1 +60,1 @@', '-b', '+B',
    ].join('\n');
    const rows = rowsFromPatch(two);
    const dels = rows.filter((r) => r.type === 'del');
    assert.deepEqual(dels.map((r) => r.oldNo), [1, 50]);
    const adds = rows.filter((r) => r.type === 'add');
    assert.deepEqual(adds.map((r) => r.newNo), [1, 60]);
  });

  test('is quiet about nothing to show', () => {
    assert.deepEqual(rowsFromPatch(''), []);
    assert.deepEqual(rowsFromPatch(undefined), []);
    assert.deepEqual(rowsFromPatch(null), []);
  });

  test('ignores the no-newline-at-eof marker', () => {
    const rows = rowsFromPatch('@@ -1,1 +1,1 @@\n-a\n\\ No newline at end of file\n+b');
    assert.deepEqual(rows.map((r) => r.type), ['header', 'del', 'add']);
  });
});
