/**
 * The three the loop answers itself, and the gap the extraction opened.
 *
 * `_executeToolCalls` ends in an `else` that sends everything to
 * `mcpServer.executeTool`. So a tool declared `dispatch: 'loop'` in the catalog
 * with no arm in `dispatchLoopTool` does not fail — it falls through to a server
 * that has no handler for it, and the model is told the tool it was just given
 * does not exist. That is the `run_background` shape again: the catalog knows,
 * the dispatch chain has its own copy of the list, and the two drift.
 *
 * `tool-catalog.test.js` guards the other direction (an arm here with no
 * catalog entry, so a tool runs that the prompt never describes). This guards
 * the one the split introduced.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { LOOP_TOOLS, dispatchLoopTool } from '../../src/core/loop-tools.js';
import { TOOL_CATALOG } from '../../src/core/tool-catalog.js';

/** A loop with just enough on it for one of these to run. */
function stubLoop(over = {}) {
  const panel = [];
  return {
    panel,
    callbacks: { sendToPanel: (m) => panel.push(m) },
    promptBuilder: { resetPromptState() {} },
    mainModel: 'gemini',
    ...over,
  };
}

describe('the set comes from the catalog', () => {
  test('it is exactly what the catalog declares', () => {
    assert.deepEqual([...LOOP_TOOLS].sort(),
      TOOL_CATALOG.filter((t) => t.dispatch === 'loop').map((t) => t.name).sort());
  });

  /*
   * The one that matters. Every member must actually be implemented — the
   * default arm exists so this comes back as an error rather than `undefined`,
   * but reaching it at all is the bug.
   */
  test('every tool in the set has an implementation', async () => {
    for (const name of LOOP_TOOLS) {
      const loop = stubLoop({
        memoryManager: { isMemoryEnabled: () => true, addMemory: () => true, removeMemory: () => true },
        _runSubAgentSession: async () => ({ success: true, result: 'ok' }),
      });
      // `ask_question` never settles by design, so race it against a tick: what
      // is being asserted is that it did not fall through, not that it answered.
      const call = { name, args: { action: 'add', fact: 'x', role: 'task', prompt: 'p', question: 'q' } };
      const got = await Promise.race([
        dispatchLoopTool(loop, call),
        new Promise((r) => setImmediate(() => r({ parked: true }))),
      ]);
      assert.doesNotMatch(String(got?.error ?? ''), /has no implementation/,
        `${name} is declared dispatch:'loop' and nothing here runs it`);
    }
  });

  // The negative control: the default arm does report an unimplemented tool,
  // rather than returning undefined for the caller to read `.success` off.
  test('an undeclared name is reported, not returned empty', async () => {
    const got = await dispatchLoopTool(stubLoop(), { name: 'invented_tool', args: {} });
    assert.match(got.error, /no implementation/);
  });
});

describe('manage_memory', () => {
  /*
   * The facts ride inside `<memory>` in the system prompt, so a changed set is
   * invisible to the model until that prompt is rebuilt. This call is what
   * rebuilds it, and it sits *after* the result is computed — a refactor that
   * turns `result = x` into `return x` drops it silently, which is exactly what
   * a mechanical extraction of this block tried to do.
   */
  test('adding a fact resets the prompt state', () => {
    let reset = 0;
    const loop = stubLoop({
      promptBuilder: { resetPromptState: () => { reset++; } },
      memoryManager: { isMemoryEnabled: () => true, addMemory: () => true },
    });

    const got = dispatchLoopTool(loop, { name: 'manage_memory', args: { action: 'add', fact: 'x' } });
    assert.equal(reset, 1, 'the new fact would not reach the model until something else reset it');
    return got.then?.((r) => assert.match(r.result, /Remembered/)) ?? assert.match(got.result, /Remembered/);
  });

  test('removing one resets it too', async () => {
    let reset = 0;
    const loop = stubLoop({
      promptBuilder: { resetPromptState: () => { reset++; } },
      memoryManager: { removeMemory: () => true },
    });

    const got = await dispatchLoopTool(loop, { name: 'manage_memory', args: { action: 'remove', index: 2 } });
    assert.equal(reset, 1);
    assert.match(got.result, /Forgot #2/);
  });

  // And the control: a rejected action must not spend a full turn-0 payload to
  // change nothing.
  test('an invalid action resets nothing', async () => {
    let reset = 0;
    const loop = stubLoop({ promptBuilder: { resetPromptState: () => { reset++; } } });

    const got = await dispatchLoopTool(loop, { name: 'manage_memory', args: { action: 'sideways' } });
    assert.equal(reset, 0, 'a rejected action rebuilt the system prompt for nothing');
    assert.match(got.error, /Use "add" or "remove"/);
  });

  // Memory being off is a decision, not a transient error: "failed" made the
  // model retry the same call.
  test('memory turned off says so plainly', async () => {
    const loop = stubLoop({ memoryManager: { isMemoryEnabled: () => false } });
    const got = await dispatchLoopTool(loop, { name: 'manage_memory', args: { action: 'add', fact: 'x' } });

    assert.equal(got.error, undefined, 'an off switch was reported as a failure');
    assert.match(got.result, /turned off/);
  });
});

describe('ask_subagent falls back rather than losing the work', () => {
  test('a failed subagent hands the task back, carrying the task', async () => {
    const loop = stubLoop({ _runSubAgentSession: async () => ({ success: false, error: 'no tab' }) });
    const got = await dispatchLoopTool(loop,
      { name: 'ask_subagent', args: { role: 'task', prompt: 'count the lines' } });

    assert.equal(got.success, true, 'the turn was failed instead of the work being handed back');
    assert.equal(got.fellBack, true);
    assert.match(got.result, /count the lines/, 'the task itself was lost');
    assert.match(got.result, /no tab/, 'the reason it fell back is not in the handover');
  });

  /*
   * The label is the whole difficulty. A failed `review` that quietly becomes
   * the author reviewing their own diff has lost the one thing a reviewer was
   * for, and nothing on screen would say so.
   */
  test('a failed review says it is now self-review', async () => {
    const loop = stubLoop({ _runSubAgentSession: async () => ({ success: false, error: 'no tab' }) });
    const got = await dispatchLoopTool(loop,
      { name: 'ask_subagent', args: { role: 'review', prompt: 'check the diff' } });

    assert.match(got.result, /reviewing your own work/);
    assert.match(got.result, /say in your answer that this review is your own/);
  });

  test('a task role gets no such warning', async () => {
    const loop = stubLoop({ _runSubAgentSession: async () => ({ success: false, error: 'no tab' }) });
    const got = await dispatchLoopTool(loop,
      { name: 'ask_subagent', args: { role: 'task', prompt: 'x' } });

    assert.doesNotMatch(got.result, /reviewing your own work/);
  });

  test('a subagent that worked is passed straight through', async () => {
    const loop = stubLoop({ _runSubAgentSession: async () => ({ success: true, result: 'the answer' }) });
    const got = await dispatchLoopTool(loop,
      { name: 'ask_subagent', args: { role: 'review', prompt: 'x' } });

    assert.equal(got.result, 'the answer');
    assert.equal(got.fellBack, undefined, 'a working subagent was labelled a fallback');
  });
});

describe('ask_question', () => {
  /*
   * The loop parks on this promise until a front-end resolves it, so a surface
   * handed a malformed payload hangs the turn. Normalising here rather than in
   * each front-end is what stops the side panel needing its own copy of rules
   * it cannot import.
   */
  test('the payload is normalised before any surface sees it', async () => {
    const loop = stubLoop();
    dispatchLoopTool(loop, {
      name: 'ask_question',
      args: { question: 'which?', options: ['a', 'b'] },
    });
    await new Promise((r) => setImmediate(r));

    const sent = loop.panel.find((m) => m.type === 'ask_question');
    assert.ok(sent, 'nothing was asked');
    assert.ok(Array.isArray(sent.payload.questions), 'the normalised set is missing');
    assert.equal(sent.payload.question, 'which?', 'the flat shape older surfaces read is missing');
    assert.ok(sent.payload.options.every((o) => typeof o === 'object' && 'label' in o),
      `options were not normalised: ${JSON.stringify(sent.payload.options)}`);
  });

  test('it parks the turn on a resolver the UI can reach', async () => {
    const loop = stubLoop();
    const pending = dispatchLoopTool(loop, { name: 'ask_question', args: { question: 'q' } });
    await new Promise((r) => setImmediate(r));

    assert.equal(typeof loop.pendingQuestionResolve, 'function',
      'nothing can answer this, so the turn would hang forever');
    loop.pendingQuestionResolve({ result: 'a' });
    assert.deepEqual(await pending, { result: 'a' });
  });
});
