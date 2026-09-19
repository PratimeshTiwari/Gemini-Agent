/**
 * The shared ceiling, and the two decisions inside it.
 *
 * `buildToolResultBatch` capped nothing, and the per-tool caps do not compose:
 * `run_command` allows 50 KB **each**, and `_executeToolCalls` runs calls in
 * parallel, so five commands is 250 KB typed into a browser composer.
 *
 * Two things are easy to get wrong and both are tested here rather than
 * described:
 *
 * - **Fair, not first-come.** Spending the budget in order means one enormous
 *   result at position 0 starves four small ones that would each have fitted.
 * - **Head *and* tail.** A failing command's value is in its last lines. Cutting
 *   from the end throws away the reason it failed, and a model handed the first
 *   40 lines of a stack trace will diagnose the wrong thing confidently.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { allocate, headAndTail, planSpoolPruning, KEEP_SPOOLS } from '../../src/core/result-budget.js';

const sum = (a) => a.reduce((x, y) => x + y, 0);

describe('allocate', () => {
  test('when everything fits, nothing is touched', () => {
    assert.deepEqual(allocate([100, 200, 50], 1000), [100, 200, 50]);
  });

  test('it never spends more than the budget', () => {
    for (const sizes of [[5000, 20], [900, 900, 900], [1, 1, 99999], [10000]]) {
      assert.ok(sum(allocate(sizes, 1000)) <= 1000, `overspent on ${sizes}`);
    }
  });

  /*
   * The case the whole module exists for. First-come would give the 9,000 the
   * entire 1,000 and leave the four 50s with nothing; fair division lets all
   * four through untouched and cuts only the one that is actually the problem.
   */
  test('one huge result does not starve four small ones', () => {
    const got = allocate([9000, 50, 50, 50, 50], 1000);

    assert.deepEqual(got.slice(1), [50, 50, 50, 50], 'the small results were cut');
    assert.equal(got[0], 800, 'the large one gets everything left over');
  });

  test('order does not change the outcome', () => {
    const a = allocate([9000, 50, 50, 50, 50], 1000);
    const b = allocate([50, 50, 9000, 50, 50], 1000);
    assert.deepEqual([...a].sort(), [...b].sort());
  });

  test('several large results share what is left equally', () => {
    const got = allocate([5000, 5000, 100], 1000);
    assert.equal(got[2], 100, 'the one that fits still fits');
    assert.equal(got[0], got[1], 'the two that do not are treated alike');
    assert.ok(sum(got) <= 1000);
  });

  test('a result exactly at its share is not cut', () => {
    assert.deepEqual(allocate([500, 500], 1000), [500, 500]);
  });

  test('degenerate inputs do not throw or invent room', () => {
    assert.deepEqual(allocate([], 1000), []);
    assert.deepEqual(allocate([100, 100], 0), [0, 0]);
    assert.deepEqual(allocate([100, 100], -5), [0, 0]);
    assert.deepEqual(allocate([0, 0], 100), [0, 0]);
  });

  // More results than characters. Every share rounds to zero, and the answer
  // has to be "nothing fits" rather than a crash or a negative allowance.
  test('a budget smaller than the number of results', () => {
    const got = allocate(new Array(20).fill(100), 10);
    assert.ok(got.every((x) => x >= 0));
    assert.ok(sum(got) <= 10);
  });
});

describe('headAndTail', () => {
  const lines = (n, w = 20) => Array.from({ length: n }, (_, i) => `line ${i}`.padEnd(w, '.')).join('\n');

  test('something that fits is returned unchanged', () => {
    const text = lines(3);
    assert.equal(headAndTail(text, 10000), text);
  });

  test('it stays within its allowance', () => {
    const text = lines(500);
    for (const room of [200, 800, 2000]) {
      assert.ok(headAndTail(text, room).length <= room, `overflowed at ${room}`);
    }
  });

  /*
   * The decision worth pinning. The end of a failing command is where the
   * error is, and this is the assertion that fails if someone simplifies the
   * function to a `slice(0, n)`.
   */
  test('the end survives, because that is where the error is', () => {
    const text = `${lines(400)}\nError: ENOENT, the thing that actually went wrong`;
    const cut = headAndTail(text, 600);

    assert.match(cut, /line 0/, 'the head is gone');
    assert.match(cut, /the thing that actually went wrong/, 'the tail is gone');
  });

  test('it says how much it removed', () => {
    const cut = headAndTail(lines(500), 600);
    assert.match(cut, /characters cut/);
  });

  test('and where the rest went, when told', () => {
    const cut = headAndTail(lines(500), 600, 'full output: .agent/tmp/x.txt');
    assert.match(cut, /\.agent\/tmp\/x\.txt/);
  });

  // A marker longer than the excerpt it introduces is worse than no excerpt.
  test('an allowance too small for an excerpt says only that it was cut', () => {
    const cut = headAndTail(lines(500), 30);
    assert.ok(cut.length <= 60, `got ${cut.length} characters for a 30 allowance`);
    assert.match(cut, /cut/);
  });

  test('non-strings and empties are returned as they came', () => {
    assert.equal(headAndTail('', 10), '');
    assert.equal(headAndTail(null, 10), null);
    assert.equal(headAndTail(undefined, 10), undefined);
  });
});

describe('planSpoolPruning', () => {
  const spool = (stamp) => `run_command-${stamp.toString(36)}-abc123.txt`;

  test('nothing to do below the limit', () => {
    assert.deepEqual(planSpoolPruning([spool(1), spool(2)]), []);
    assert.deepEqual(planSpoolPruning([]), []);
  });

  test('the oldest go, the newest stay', () => {
    const names = Array.from({ length: KEEP_SPOOLS + 5 }, (_, i) => spool(1000 + i));
    const doomed = planSpoolPruning(names);

    assert.equal(doomed.length, 5);
    assert.deepEqual(doomed, [0, 1, 2, 3, 4].map((i) => spool(1000 + i)));
  });

  /*
   * `.agent/tmp/` also holds clipboard images. A pruner that deletes what it
   * does not recognise is one nobody can safely put a file beside — and the
   * file it would eat is the screenshot the user just pasted.
   */
  test('it never touches a file that is not its own', () => {
    const mine = Array.from({ length: KEEP_SPOOLS + 3 }, (_, i) => spool(1000 + i));
    const theirs = ['clipboard-1758240000000.png', 'notes.txt', 'clipboard-image.png'];
    const doomed = planSpoolPruning([...theirs, ...mine]);

    for (const name of theirs) assert.ok(!doomed.includes(name), `would have deleted ${name}`);
    assert.equal(doomed.length, 3);
  });

  // The timestamp is read from the name, not from mtime, because a checkout or
  // a copy rewrites mtime — the lesson backup-pruner already encodes.
  test('order comes from the name, whatever order it is given in', () => {
    const names = [spool(3000), spool(1000), spool(2000)];
    assert.deepEqual(planSpoolPruning(names, { keep: 1 }), [spool(1000), spool(2000)]);
  });
});
