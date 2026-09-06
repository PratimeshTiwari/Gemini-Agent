import { test, describe } from 'node:test';
import assert from 'node:assert';
import { planBackupPruning, KEEP_PER_FILE } from './backup-pruner.js';

const backup = (name, stamp) => `${name}.${stamp}.bak`;

describe('planBackupPruning', () => {
  test('keeps the newest N of a file and marks the rest', () => {
    const names = [1, 2, 3, 4, 5, 6, 7].map((i) => backup('App.jsx', 1788676487000 + i));
    const doomed = planBackupPruning(names, { keep: 3 });
    assert.strictEqual(doomed.length, 4);
    // the three highest timestamps survive
    for (const kept of [5, 6, 7]) {
      assert.ok(!doomed.includes(backup('App.jsx', 1788676487000 + kept)));
    }
  });

  test('a file at or under the limit loses nothing', () => {
    const names = [1, 2, 3].map((i) => backup('App.jsx', 1788676487000 + i));
    assert.deepStrictEqual(planBackupPruning(names, { keep: 3 }), []);
    assert.deepStrictEqual(planBackupPruning(names, { keep: 5 }), []);
  });

  test('each source file is counted on its own', () => {
    const names = [
      ...[1, 2, 3].map((i) => backup('App.jsx', 1788676487000 + i)),
      ...[1, 2, 3].map((i) => backup('main.js', 1788676487000 + i)),
    ];
    assert.deepStrictEqual(planBackupPruning(names, { keep: 3 }), []);
    assert.strictEqual(planBackupPruning(names, { keep: 1 }).length, 4);
  });

  test('ordering comes from the name, not the order listed', () => {
    // readdir order is arbitrary, and mtime is rewritten by a checkout or copy.
    const names = [
      backup('App.jsx', 1788676487003),
      backup('App.jsx', 1788676487001),
      backup('App.jsx', 1788676487002),
    ];
    assert.deepStrictEqual(planBackupPruning(names, { keep: 1 }), [
      backup('App.jsx', 1788676487002),
      backup('App.jsx', 1788676487001),
    ]);
  });

  test('files that are not ours are never touched', () => {
    const names = ['notes.md', 'App.jsx.bak', 'App.jsx.12.bak', '.DS_Store'];
    assert.deepStrictEqual(planBackupPruning(names, { keep: 0 }), []);
  });

  test('a source name containing dots still groups correctly', () => {
    const names = [1, 2, 3].map((i) => backup('use-key-bindings.test.js', 1788676487000 + i));
    assert.strictEqual(planBackupPruning(names, { keep: 1 }).length, 2);
  });

  test('empty input is not an error', () => {
    assert.deepStrictEqual(planBackupPruning(), []);
    assert.deepStrictEqual(planBackupPruning([]), []);
  });

  test('the default keeps a useful number', () => {
    assert.ok(KEEP_PER_FILE >= 3, 'fewer than three would make the net useless');
  });
});
