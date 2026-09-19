import test from 'node:test';
import assert from 'node:assert/strict';
import { EFFORT_LEVELS, DEFAULT_EFFORT, resolveEffort, isEffort, effortFromConfig } from '../../src/core/effort.js';

test('the ladder', async (t) => {
  await t.test('has exactly the three states that mean something', () => {
    assert.deepEqual(EFFORT_LEVELS.map((e) => e.id), ['flash', 'flash-thinking', 'pro']);
  });

  // The old shape was 3 tiers x 3 levels. Six of those nine combinations either
  // duplicated another or asked a profile with no reasoning section to reason
  // harder. That became five rungs, and five became three when measurement said
  // `standard` was already carrying nearly everything `deep` had.
  await t.test('every rung names a tier the prompt builder branches on', () => {
    for (const e of EFFORT_LEVELS) {
      assert.ok(['flash', 'flash-thinking', 'pro'].includes(e.tier), e.id);
      assert.equal(e.level === null, e.tier !== 'pro',
        `${e.id}: a reasoning level only means something on pro`);
    }
  });

  await t.test('every rung names the browser tab it is written for', () => {
    for (const e of EFFORT_LEVELS) assert.match(e.browser, /^Gemini /);
  });

  await t.test('one pro rung, and it is the old `standard` profile', () => {
    const pro = EFFORT_LEVELS.filter((e) => e.tier === 'pro');
    assert.equal(pro.length, 1);
    // `level` is what `_getReasoningInstructions` branches on. Pointing it at
    // 'deep' would silently add the critical-analysis phase and the assumption
    // ledger, which were declined on output cost, not prompt cost.
    assert.equal(pro[0].level, 'standard');
  });

  await t.test('the id and the tier agree, so `/effort pro` is not a near-miss', () => {
    assert.equal(resolveEffort('pro').tier, 'pro');
    assert.equal(isEffort('pro'), true);
  });
});

test('resolveEffort never leaves you without a profile', async (t) => {
  await t.test('a real id comes back', () => {
    assert.equal(resolveEffort('pro').id, 'pro');
    assert.equal(resolveEffort('  PRO  ').id, 'pro');
    assert.equal(resolveEffort('flash-thinking').id, 'flash-thinking');
  });

  await t.test('anything else falls back rather than returning nothing', () => {
    for (const bad of [undefined, null, '', 'ultra', 42, {}, []]) {
      assert.equal(resolveEffort(bad).id, DEFAULT_EFFORT, `${JSON.stringify(bad)}`);
    }
  });

  /*
   * A retired rung is not a rung. `resolveEffort('deep')` falling back to the
   * default is correct *here* — but it is not enough on its own, which is what
   * `effortFromConfig` is for below: a stored config must land on `pro` by
   * decision rather than by fallback, or a disagreeing `modelTier` would win.
   */
  await t.test('isEffort tells a rung from a near-miss and from a retired one', () => {
    assert.equal(isEffort('pro'), true);
    assert.equal(isEffort('prro'), false);
    for (const gone of ['brief', 'standard', 'deep']) {
      assert.equal(isEffort(gone), false, `${gone} is not a rung any more`);
    }
  });
});

test('reading a config written before the ladder shrank', async (t) => {
  // All three were the pro tier, so all three are `pro`. This is the assertion
  // that matters most: these are configs sitting on disk right now.
  await t.test('the retired rungs fold to pro', () => {
    for (const gone of ['brief', 'standard', 'deep']) {
      assert.equal(effortFromConfig({ effort: gone }), 'pro', gone);
    }
  });

  // The negative control for the fold: it must be a decision, not a fallback.
  // Without `RETIRED_RUNGS` the lookup drops through to `modelTier`, and this
  // config would answer 'flash' — quietly putting a pro user on the terse
  // profile because of a key written by a version that no longer exists.
  await t.test('a retired rung outranks a stale modelTier', () => {
    assert.equal(effortFromConfig({ effort: 'deep', modelTier: 'flash' }), 'pro');
  });

  await t.test('the new key wins when it is there', () => {
    assert.equal(effortFromConfig({ effort: 'flash', modelTier: 'pro' }), 'flash');
  });

  await t.test('a nonsense new key does not shadow the old ones', () => {
    assert.equal(effortFromConfig({ effort: 'turbo', modelTier: 'flash' }), 'flash');
  });

  await t.test('modelTier alone', () => {
    assert.equal(effortFromConfig({ modelTier: 'flash' }), 'flash');
    assert.equal(effortFromConfig({ modelTier: 'flash-thinking' }), 'flash-thinking');
    assert.equal(effortFromConfig({ modelTier: 'pro' }), 'pro');
  });

  await t.test('reasoningEffort, the legacy alias for the same thing', () => {
    assert.equal(effortFromConfig({ reasoningEffort: 'low' }), 'flash');
    assert.equal(effortFromConfig({ reasoningEffort: 'medium' }), 'flash-thinking');
    assert.equal(effortFromConfig({ reasoningEffort: 'high' }), 'pro');
  });

  await t.test('tier and level together, which is the common case', () => {
    assert.equal(effortFromConfig({ modelTier: 'pro', reasoningLevel: 'brief' }), 'pro');
    assert.equal(effortFromConfig({ modelTier: 'pro', reasoningLevel: 'deep' }), 'pro');
  });

  // A level set while on a flash tier was a setting with no effect. The tier is
  // what the prompt actually branched on, so it is the half that survives.
  await t.test('a level that never applied is dropped, not promoted', () => {
    assert.equal(effortFromConfig({ modelTier: 'flash', reasoningLevel: 'deep' }), 'flash');
    assert.equal(effortFromConfig({ modelTier: 'flash-thinking', reasoningLevel: 'brief' }), 'flash-thinking');
  });

  await t.test('a bare reasoningLevel implies the pro tier it only ever applied to', () => {
    assert.equal(effortFromConfig({ reasoningLevel: 'deep' }), 'pro');
  });

  await t.test('an empty or absent config lands on the default', () => {
    assert.equal(effortFromConfig({}), DEFAULT_EFFORT);
    assert.equal(effortFromConfig(), DEFAULT_EFFORT);
  });

  await t.test('folding is idempotent — reading back what it produced', () => {
    for (const e of EFFORT_LEVELS) {
      assert.equal(effortFromConfig({ effort: effortFromConfig({ effort: e.id }) }), e.id);
    }
    // And a retired rung is stable once folded, rather than oscillating.
    assert.equal(effortFromConfig({ effort: effortFromConfig({ effort: 'deep' }) }), 'pro');
  });
});
