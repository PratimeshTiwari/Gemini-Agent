import test from 'node:test';
import assert from 'node:assert/strict';
import { EFFORT_LEVELS, DEFAULT_EFFORT, resolveEffort, isEffort, effortFromConfig, foldEffort } from '../../src/core/effort.js';

test('the ladder', async (t) => {
  await t.test('has exactly the three states that mean something', () => {
    assert.deepEqual(EFFORT_LEVELS.map((e) => e.id), ['low', 'medium', 'high']);
  });

  // The old shape was 3 tiers x 3 levels. Six of those nine combinations either
  // duplicated another or asked a profile with no reasoning section to reason
  // harder. That became five rungs, and five became three when measurement said
  // `standard` was already carrying nearly everything `deep` had.
  await t.test('every rung names a tier the prompt builder branches on', () => {
    for (const e of EFFORT_LEVELS) {
      assert.ok(['lite', 'flash', 'pro'].includes(e.tier), e.id);
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
    assert.equal(resolveEffort('high').tier, 'pro');
    assert.equal(isEffort('high'), true);
  });
});

test('resolveEffort never leaves you without a profile', async (t) => {
  await t.test('a real id comes back', () => {
    assert.equal(resolveEffort('high').id, 'high');
    assert.equal(resolveEffort('  PRO  ').id, 'high');
    assert.equal(resolveEffort('medium').id, 'medium');
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
    assert.equal(isEffort('high'), true);
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
      assert.equal(effortFromConfig({ effort: gone }), 'high', gone);
    }
  });

  // The negative control for the fold: it must be a decision, not a fallback.
  // Without `RETIRED_RUNGS` the lookup drops through to `modelTier`, and this
  // config would answer 'low' — quietly putting a pro user on the terse
  // profile because of a key written by a version that no longer exists.
  await t.test('a retired rung outranks a stale modelTier', () => {
    assert.equal(effortFromConfig({ effort: 'deep', modelTier: 'lite' }), 'high');
  });

  await t.test('the new key wins when it is there', () => {
    assert.equal(effortFromConfig({ effort: 'low', modelTier: 'pro' }), 'low');
  });

  await t.test('a nonsense new key does not shadow the old ones', () => {
    assert.equal(effortFromConfig({ effort: 'turbo', modelTier: 'lite' }), 'low');
  });

  await t.test('modelTier alone', () => {
    assert.equal(effortFromConfig({ modelTier: 'lite' }), 'low');
    assert.equal(effortFromConfig({ modelTier: 'flash' }), 'medium');
    assert.equal(effortFromConfig({ modelTier: 'pro' }), 'high');
  });

  await t.test('reasoningEffort, the legacy alias for the same thing', () => {
    assert.equal(effortFromConfig({ reasoningEffort: 'low' }), 'low');
    assert.equal(effortFromConfig({ reasoningEffort: 'medium' }), 'medium');
    assert.equal(effortFromConfig({ reasoningEffort: 'high' }), 'high');
  });

  await t.test('tier and level together, which is the common case', () => {
    assert.equal(effortFromConfig({ modelTier: 'pro', reasoningLevel: 'brief' }), 'high');
    assert.equal(effortFromConfig({ modelTier: 'pro', reasoningLevel: 'deep' }), 'high');
  });

  // A level set while on a flash tier was a setting with no effect. The tier is
  // what the prompt actually branched on, so it is the half that survives.
  await t.test('a level that never applied is dropped, not promoted', () => {
    assert.equal(effortFromConfig({ modelTier: 'lite', reasoningLevel: 'deep' }), 'low');
    assert.equal(effortFromConfig({ modelTier: 'flash', reasoningLevel: 'brief' }), 'medium');
  });

  await t.test('a bare reasoningLevel implies the pro tier it only ever applied to', () => {
    assert.equal(effortFromConfig({ reasoningLevel: 'deep' }), 'high');
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
    assert.equal(effortFromConfig({ effort: effortFromConfig({ effort: 'deep' }) }), 'high');
  });
});

/**
 * The 2026-09-26 rename: `lite`/`flash`/`pro` became `low`/`medium`/`high`.
 *
 * Owner's call — *"internally for effort selection lets simplify the names,
 * low medium high"* — and it undoes a collision this ladder created for
 * itself. Naming our rungs after Google's models meant `flash` was our terse
 * rung before 2026-09-20 and the middle one after, and the mismatch warning
 * would have said "flash" about two different things. The effort is **ours**;
 * the model is the **browser's**. They no longer share a vocabulary.
 *
 * Every hazard below was a real defect during the rename, not a hypothetical.
 */
test('the rename away from the browser’s vocabulary', async (t) => {
  await t.test('the three words fold to the rungs they always meant', () => {
    assert.equal(resolveEffort('lite').id, 'low');
    assert.equal(resolveEffort('flash').id, 'medium');
    assert.equal(resolveEffort('pro').id, 'high');
  });

  /*
   * The defect this caught. `resolveEffort` used to fall through to
   * `DEFAULT_EFFORT` for an unknown word — so `lite` answered `high`, the
   * *opposite* rung, while `pro` answered `high` correctly by pure luck
   * because `pro` and the default coincide. One word silently inverted and its
   * neighbour silently worked, which is the worst pairing for noticing.
   */
  await t.test('a retired word never resolves to the default by accident', () => {
    assert.notEqual(resolveEffort('lite').id, DEFAULT_EFFORT,
      'the terse rung resolved to the heaviest one');
  });

  await t.test('nonsense still gets the default, which is the point of the fallback', () => {
    assert.equal(resolveEffort('turbo').id, DEFAULT_EFFORT);
    assert.equal(resolveEffort(undefined).id, DEFAULT_EFFORT);
  });

  /*
   * `tier` deliberately did NOT move. It names the prompt *profile*, the
   * prompt files are named after it (`reasoning-lite.md`), and
   * `prompt-builder` branches on it. Renaming it would have been a second,
   * much larger change wearing the same clothes.
   */
  await t.test('the tier keeps the browser-shaped word, on purpose', () => {
    assert.equal(resolveEffort('low').tier, 'lite');
    assert.equal(resolveEffort('medium').tier, 'flash');
    assert.equal(resolveEffort('high').tier, 'pro');
  });

  await t.test('and the id no longer equals the tier, which is the whole change', () => {
    for (const e of EFFORT_LEVELS) {
      assert.notEqual(e.id, e.tier, `${e.id} is still named after a browser model`);
    }
  });

  // `reasoningEffort` held low/medium/high for exactly these three rungs before
  // 2026-09-20. The rename returns to that vocabulary rather than inventing one.
  await t.test('the oldest key of all needs no translation now', () => {
    assert.equal(effortFromConfig({ reasoningEffort: 'low' }), 'low');
    assert.equal(effortFromConfig({ reasoningEffort: 'medium' }), 'medium');
    assert.equal(effortFromConfig({ reasoningEffort: 'high' }), 'high');
  });

  await t.test('foldEffort tells a rung from a typo, where resolveEffort cannot', () => {
    assert.equal(foldEffort('pro'), 'high');
    assert.equal(foldEffort('HIGH'), 'high');
    assert.equal(foldEffort('deeep'), null, 'a typo must not read as a confirmation');
    assert.equal(foldEffort(''), null);
  });
});
