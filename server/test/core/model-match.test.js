import { test, describe } from 'node:test';
import assert from 'node:assert';
import { pickModelFor, planModelSwitch } from '../../src/core/model-match.js';

/** Exactly what the picker showed on the owner's plan, labels and blurbs. */
const OWNER_PLAN = [
  { label: '3.5 Flash-Lite', description: 'Fastest answers' },
  { label: '3.8 Flash', description: 'All-around help', selected: true },
  { label: '3.1 Pro', description: 'Advanced reasoning' },
  { label: 'Extended thinking', description: 'Complex problem solving' },
];

/** A plan without the extended option — the case that must not silently break. */
const LEAN_PLAN = [
  { label: '3.8 Flash', description: 'All-around help', selected: true },
  { label: '3.1 Pro', description: 'Advanced reasoning' },
];

describe('pickModelFor — decide by what an option is for, not what it is called', () => {
  test('the fast rung takes the fastest thing offered', () => {
    assert.equal(pickModelFor('flash', OWNER_PLAN).model.label, '3.5 Flash-Lite');
  });

  test('the deep rung prefers extended thinking over pro', () => {
    assert.equal(pickModelFor('deep', OWNER_PLAN).model.label, 'Extended thinking');
  });

  test('the pro rungs take the reasoning model', () => {
    for (const rung of ['brief', 'standard']) {
      assert.equal(pickModelFor(rung, OWNER_PLAN).model.label, '3.1 Pro', rung);
    }
  });

  test('a plan without extended thinking degrades to pro rather than failing', () => {
    assert.equal(pickModelFor('deep', LEAN_PLAN).model.label, '3.1 Pro');
  });

  test('a plan without a lite option still gives the fast rung something', () => {
    assert.equal(pickModelFor('flash', LEAN_PLAN).model.label, '3.8 Flash');
  });

  /**
   * Version numbers move. The whole reason the list is read from the page is
   * that `3.8 Flash` will not be called that for long.
   */
  test('the version number is not what is matched on', () => {
    const renamed = [
      { label: '4.2 Flash-Lite', description: 'Fastest answers' },
      { label: '4.9 Flash', description: 'All-around help' },
      { label: '4.0 Pro', description: 'Advanced reasoning' },
    ];
    assert.equal(pickModelFor('flash', renamed).model.label, '4.2 Flash-Lite');
    assert.equal(pickModelFor('standard', renamed).model.label, '4.0 Pro');
  });

  test('a description alone is enough when the label says nothing', () => {
    const opaque = [
      { label: 'Model A', description: 'Fastest answers' },
      { label: 'Model B', description: 'Advanced reasoning' },
    ];
    assert.equal(pickModelFor('flash', opaque).model.label, 'Model A');
    assert.equal(pickModelFor('standard', opaque).model.label, 'Model B');
  });

  test('the fast rung refuses a heavy option even when the words overlap', () => {
    const tricky = [
      { label: 'Flash Extended', description: 'Complex problem solving' },
      { label: 'Flash', description: 'Fastest answers' },
    ];
    assert.equal(pickModelFor('flash', tricky).model.label, 'Flash');
  });

  test('nothing to pick from is null, not a guess', () => {
    assert.equal(pickModelFor('flash', []), null);
    assert.equal(pickModelFor('flash', undefined), null);
    assert.equal(pickModelFor('nonsense', OWNER_PLAN), null);
  });

  test('it says why, because a switch you cannot explain reads as a bug', () => {
    assert.match(pickModelFor('deep', OWNER_PLAN).why, /Extended thinking/);
    assert.match(pickModelFor('deep', OWNER_PLAN).why, /deep/);
  });
});

describe('planModelSwitch — the cheapest interaction is the one not performed', () => {
  test('already on the right model means no click', () => {
    const plan = planModelSwitch('flash-thinking', OWNER_PLAN);
    assert.equal(plan.action, 'none');
    assert.match(plan.reason, /already on 3\.8 Flash/);
  });

  test('a different model means switch, and names it', () => {
    const plan = planModelSwitch('deep', OWNER_PLAN);
    assert.equal(plan.action, 'switch');
    assert.equal(plan.model.label, 'Extended thinking');
  });

  test('no list yet is unavailable, not a failure to act on', () => {
    const plan = planModelSwitch('deep', []);
    assert.equal(plan.action, 'unavailable');
    assert.match(plan.reason, /not reported a model list/);
  });

  test('a plan that offers nothing suitable says what it does offer', () => {
    const odd = [{ label: 'Canvas', description: 'Drawing' }];
    const plan = planModelSwitch('deep', odd);
    assert.equal(plan.action, 'unavailable');
    assert.match(plan.reason, /Canvas/);
  });
});
