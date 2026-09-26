/**
 * Gathering is not reasoning, so it should not cost a reasoning model.
 *
 * `ask_subagent` already gets its own tab on its own lane, and the picker in
 * that tab is its own — the only thing missing was saying which entry to
 * choose, before the first prompt is typed. A switch after round 1 has already
 * paid full price for round 1.
 *
 * Two properties matter more than the routing itself:
 *
 * **A rung, never a model name.** The caller asks for `lite`/`flash`/`pro` and
 * `pickModelFor` turns that into a label the picker is offering *right now* —
 * `3.1 Pro` becomes `3.2 Pro` and the list differs by subscription, which is
 * the whole thesis of `model-match.js`.
 *
 * **Its failure mode is the old behaviour.** No picker list, no suitable
 * option, no rung — all mean "leave the tab on whatever it opens with". A
 * routing feature that strands a subagent on no model at all would be worse
 * than not routing.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runSubAgentSession } from '../../src/core/subagent-session.js';
import { subagentEffort } from '../../src/core/loop-tools.js';

const PLAN = [
  { label: '3.5 Flash-Lite', description: 'Fastest answers' },
  { label: '3.8 Flash', description: 'All-around help', selected: true },
  { label: '3.1 Pro', description: 'Advanced reasoning' },
];

const stub = (modelOptions, modelConfig = {}) => {
  const calls = [];
  const loop = {
    workspace: '/tmp/ws',
    modelOptions,
    modelConfig,
    promptBuilder: { buildSubagentWrapper: () => '<role>x</role>' },
    callbacks: { sendToPanel() {} },
    mcpServer: { executeTool: async () => ({ success: true, result: 'r' }) },
    _sendEndSession() {},
    _extractToolCalls: (t) => ({ toolCalls: [], cleanContent: t }),
    _executeSubagent: async (_m, _p, opts = {}) => {
      calls.push(opts);
      return { success: true, result: 'done' };
    },
  };
  return { loop, calls };
};

describe('subagentEffort — where a delegated job runs', () => {
  test('research and task go to a fast model by default', () => {
    assert.equal(subagentEffort(undefined, 'research', 'high'), 'medium');
    assert.equal(subagentEffort(undefined, 'task', 'high'), 'medium');
  });

  /*
   * Review is the one step whose purpose is a reader who does not share the
   * author's assumptions. Quietly downgrading it would be the `unstructured`
   * failure again: degrading without saying so.
   */
  test('review keeps the session rung rather than being downgraded', () => {
    assert.equal(subagentEffort(undefined, 'review', 'high'), 'high');
    assert.equal(subagentEffort(undefined, 'review', 'low'), 'low');
  });

  test('an explicit rung always wins, including on review', () => {
    assert.equal(subagentEffort('high', 'research', 'low'), 'high');
    assert.equal(subagentEffort('low', 'review', 'high'), 'low');
    assert.equal(subagentEffort('FLASH', 'task', 'high'), 'medium');
  });

  test('a word that is not a rung falls back to the rule, not to itself', () => {
    assert.equal(subagentEffort('cheap', 'research', 'high'), 'medium');
    assert.equal(subagentEffort('deep', 'review', 'high'), 'high');
  });
});

describe('the rung reaches the tab that is opened', () => {
  test('it is resolved against the live picker and rides the first prompt', async () => {
    const { loop, calls } = stub(PLAN);
    await runSubAgentSession(loop, 'research', 'find it', 'gemini', 'low');
    assert.equal(calls[0].model, '3.5 Flash-Lite', 'the rung became a real label');
  });

  test('a browserModels pin wins over the intent match', async () => {
    const { loop, calls } = stub(PLAN, { browserModels: { low: '3.8 Flash' } });
    await runSubAgentSession(loop, 'research', 'find it', 'gemini', 'low');
    assert.equal(calls[0].model, '3.8 Flash');
  });

  // Every one of these means "leave the tab on whatever it opens with".
  test('no rung, no list and nothing suitable all fall back to the default tab', async () => {
    for (const [options, effort] of [[PLAN, null], [[], 'low'], [PLAN, 'nonsense']]) {
      const { loop, calls } = stub(options);
      await runSubAgentSession(loop, 'research', 'find it', 'gemini', effort);
      // Falsy, not strictly undefined: the session passes `model: null` and
      // `_executeSubagent` spreads it onto the wire only when truthy, so the
      // extension never sees the key. Either way the tab keeps its default.
      assert.ok(!calls[0].model, `expected no model for ${effort}, got ${calls[0].model}`);
    }
  });
});
