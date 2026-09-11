import test from 'node:test';
import assert from 'node:assert/strict';
import { EFFORT_LEVELS, DEFAULT_EFFORT, resolveEffort, isEffort, effortFromConfig } from '../../src/core/effort.js';

test('the ladder', async (t) => {
  await t.test('has exactly the five states that mean something', () => {
    assert.deepEqual(EFFORT_LEVELS.map((e) => e.id),
      ['flash', 'flash-thinking', 'brief', 'standard', 'deep']);
  });

  // The old shape was 3 tiers x 3 levels. Six of those nine combinations either
  // duplicated another or asked a profile with no reasoning section to reason
  // harder; the UI apologised for them at the point of use instead of
  // preventing them.
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

  await t.test('the three pro rungs are the three reasoning levels, once each', () => {
    const levels = EFFORT_LEVELS.filter((e) => e.tier === 'pro').map((e) => e.level);
    assert.deepEqual(levels, ['brief', 'standard', 'deep']);
  });
});

test('resolveEffort never leaves you without a profile', async (t) => {
  await t.test('a real id comes back', () => {
    assert.equal(resolveEffort('deep').id, 'deep');
    assert.equal(resolveEffort('  DEEP  ').id, 'deep');
  });

  await t.test('anything else falls back rather than returning nothing', () => {
    for (const bad of [undefined, null, '', 'ultra', 42, {}, []]) {
      assert.equal(resolveEffort(bad).id, DEFAULT_EFFORT, `${JSON.stringify(bad)}`);
    }
  });

  await t.test('isEffort tells a rung from a near-miss', () => {
    assert.equal(isEffort('deep'), true);
    assert.equal(isEffort('deeply'), false);
    assert.equal(isEffort('pro'), false); // a tier, not a rung
  });
});

test('reading a config written before /effort existed', async (t) => {
  await t.test('the new key wins when it is there', () => {
    assert.equal(effortFromConfig({ effort: 'brief', modelTier: 'flash' }), 'brief');
  });

  await t.test('a nonsense new key does not shadow the old ones', () => {
    assert.equal(effortFromConfig({ effort: 'turbo', modelTier: 'flash' }), 'flash');
  });

  await t.test('modelTier alone', () => {
    assert.equal(effortFromConfig({ modelTier: 'flash' }), 'flash');
    assert.equal(effortFromConfig({ modelTier: 'flash-thinking' }), 'flash-thinking');
    assert.equal(effortFromConfig({ modelTier: 'pro' }), 'standard');
  });

  await t.test('reasoningEffort, the legacy alias for the same thing', () => {
    assert.equal(effortFromConfig({ reasoningEffort: 'low' }), 'flash');
    assert.equal(effortFromConfig({ reasoningEffort: 'medium' }), 'flash-thinking');
    assert.equal(effortFromConfig({ reasoningEffort: 'high' }), 'standard');
  });

  await t.test('tier and level together, which is the common case', () => {
    assert.equal(effortFromConfig({ modelTier: 'pro', reasoningLevel: 'brief' }), 'brief');
    assert.equal(effortFromConfig({ modelTier: 'pro', reasoningLevel: 'deep' }), 'deep');
  });

  // A level set while on a flash tier was a setting with no effect. The tier is
  // what the prompt actually branched on, so it is the half that survives.
  await t.test('a level that never applied is dropped, not promoted', () => {
    assert.equal(effortFromConfig({ modelTier: 'flash', reasoningLevel: 'deep' }), 'flash');
    assert.equal(effortFromConfig({ modelTier: 'flash-thinking', reasoningLevel: 'brief' }), 'flash-thinking');
  });

  await t.test('a bare reasoningLevel implies the pro tier it only ever applied to', () => {
    assert.equal(effortFromConfig({ reasoningLevel: 'deep' }), 'deep');
  });

  await t.test('an empty or absent config lands on the default', () => {
    assert.equal(effortFromConfig({}), DEFAULT_EFFORT);
    assert.equal(effortFromConfig(), DEFAULT_EFFORT);
  });

  await t.test('folding is idempotent — reading back what it produced', () => {
    for (const e of EFFORT_LEVELS) {
      assert.equal(effortFromConfig({ effort: effortFromConfig({ effort: e.id }) }), e.id);
    }
  });
});
