import { test, describe } from 'node:test';
import assert from 'node:assert';
import { ContextManager } from '../../src/context/context-manager.js';

/**
 * `needsCompaction` had no tests, and that is exactly why auto-compaction never
 * once fired: the call site handed it `conversationHistory` — an array — where
 * it wants a token count. `Number([{…},{…}])` is `NaN`, `NaN > x` is always
 * false, and an empty history gives `0`, which never trips either. There is no
 * history that makes the branch run.
 *
 * So these cover the threshold, and then refuse the argument that broke it.
 */
describe('ContextManager.needsCompaction', () => {
  const cm = new ContextManager('/tmp', null);
  // The budget is an argument now, not a field: it has to track the active
  // rung, and the field that used to hold it never did.
  const at = (budget) => ({
    needsCompaction: (tokens) => cm.needsCompaction(tokens, budget),
  });

  test('compacts past 80% of the budget, leaving room to do the compacting', () => {
    const cm = at(50000);
    assert.equal(cm.needsCompaction(39999), false);
    assert.equal(cm.needsCompaction(40000), false, 'the threshold itself is not past it');
    assert.equal(cm.needsCompaction(40001), true);
  });

  test('an empty thread never trips', () => {
    assert.equal(at(50000).needsCompaction(0), false);
    assert.equal(at(50000).needsCompaction(undefined), false);
    assert.equal(at(50000).needsCompaction(null), false);
  });

  test('a missing budget is refused too — it used to be a stale field', () => {
    assert.throws(() => cm.needsCompaction(1000), /budget/i);
    assert.throws(() => cm.needsCompaction(1000, 0), /budget/i);
  });

  test('the threshold follows the budget the rung is on', () => {
    // 24k is the flash rung; a count that is fine on 96k is not fine here.
    assert.equal(at(24000).needsCompaction(30000), true);
    assert.equal(at(96000).needsCompaction(30000), false);
  });

  /**
   * The regression. Passing the history rather than its size must be loud, not
   * quietly false — a silent `NaN` is what let this sit unnoticed while the
   * meter went past 200% of budget.
   */
  test('handed a history instead of a count, it refuses rather than returning false', () => {
    const history = [{ role: 'user', content: 'x' }, { role: 'agent', content: 'y' }];
    assert.throws(() => at(50000).needsCompaction(history), /history array/i);
    assert.throws(() => at(50000).needsCompaction([]), /history array/i);
  });

  test('a string that is really a number is still a number', () => {
    // Nothing passes one today, but coercing a numeric string is harmless and
    // keeps the guard aimed at the mistake that actually happened.
    assert.equal(at(50000).needsCompaction('40001'), true);
  });
});
