/**
 * One subagent task, one tab, incremental prompts.
 *
 * It used to be one tab per *round*: every pass re-serialised the whole
 * accumulated history and called `_executeSubagent` with no session, so the
 * extension opened a fresh tab, typed everything again and closed it. Six
 * rounds meant six tabs and six copies of a history that only grew — the same
 * waste `CLAUDE.md` measured for batch tasks at **81% of characters resent
 * over ten turns**, and the reason a subagent has never been cheaper than
 * doing the work inline. It is the blocker under "route cheap work to a Flash
 * tab": on the old shape a Flash gatherer is slower than Pro inline.
 *
 * `turn-runner.js` already solved this and this file predates it. The
 * mechanics are lifted from there deliberately, so the tests below are the
 * same three properties: one session, only-what-is-unseen, and a `sessionLost`
 * re-send that says it all again once.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runSubAgentSession } from '../../src/core/subagent-session.js';

/**
 * A loop whose `_executeSubagent` is scripted, recording every call.
 * `replies` is consumed in order; anything past the end ends the run.
 */
const stub = (replies) => {
  const calls = [];
  const ended = [];
  const loop = {
    workspace: '/tmp/ws',
    promptBuilder: { buildSubagentWrapper: () => '<role>tester</role>' },
    callbacks: { sendToPanel() {} },
    mcpServer: { executeTool: async () => ({ success: true, result: 'FILE BODY' }) },
    editor: null,
    taskManager: null,
    _sendEndSession: (id) => ended.push(id),
    _extractToolCalls: (text) => {
      const m = text.match(/```json\n([\s\S]*?)\n```/);
      if (!m) return { toolCalls: [], cleanContent: text };
      return { toolCalls: [JSON.parse(m[1])], cleanContent: text.replace(m[0], '').trim() };
    },
    _executeSubagent: async (model, prompt, opts = {}) => {
      calls.push({ prompt, ...opts });
      const next = replies[calls.length - 1];
      return next ?? { success: true, result: 'done, no tools' };
    },
  };
  return { loop, calls, ended };
};

const READ = '```json\n{"name": "read_file", "args": {"path": "a.js"}}\n```';
const DONE = '```json\n{"name": "return_result", "args": {"result": "ok"}}\n```';

describe('a subagent task holds one tab', () => {
  test('every round carries the same session id', async () => {
    const { loop, calls } = stub([
      { success: true, result: READ },
      { success: true, result: DONE },
    ]);
    await runSubAgentSession(loop, 'research', 'find the thing', 'gemini');

    assert.equal(calls.length, 2);
    assert.ok(calls[0].session, 'the first round opens a session');
    assert.equal(calls[1].session, calls[0].session, 'and the second reuses it');
  });

  test('the first round is whole, the rest are only what the tab has not seen', async () => {
    const { loop, calls } = stub([
      { success: true, result: READ },
      { success: true, result: DONE },
    ]);
    await runSubAgentSession(loop, 'research', 'find the thing', 'gemini');

    assert.equal(calls[0].continuing, false);
    assert.match(calls[0].prompt, /find the thing/, 'the task is in the opening prompt');

    assert.equal(calls[1].continuing, true);
    assert.match(calls[1].prompt, /FILE BODY/, 'the tool result is what is new');
    assert.doesNotMatch(calls[1].prompt, /find the thing/, 'the tab already holds the task');
    // The model wrote this itself; typing it back is the waste being removed.
    // Matched on the serialiser's own marker, not on the tool name — the tool
    // *result* legitimately names the tool that produced it.
    assert.doesNotMatch(calls[1].prompt, /\[Your Previous Output\]/,
      'its own reply is already in the thread');
    assert.ok(calls[1].prompt.length < calls[0].prompt.length, 'incremental is smaller');
  });

  /*
   * The tab was closed under us. The extension refuses an incremental prompt
   * rather than opening a fresh one, because a continuation typed into an empty
   * conversation gets a confident answer to a question the model never saw.
   */
  test('a lost session is recovered by saying it all again, once', async () => {
    const { loop, calls } = stub([
      { success: true, result: READ },
      { success: false, sessionLost: true },
      { success: true, result: DONE },
    ]);
    await runSubAgentSession(loop, 'research', 'find the thing', 'gemini');

    assert.equal(calls[1].continuing, true, 'the attempt that was refused');
    assert.equal(calls[2].continuing, false, 'the recovery starts over');
    assert.match(calls[2].prompt, /find the thing/, 'and carries the whole history again');
  });

  test('the session is ended however the run finishes', async () => {
    for (const replies of [
      [{ success: true, result: DONE }],                      // return_result
      [{ success: true, result: 'answered in prose' }],        // the fallback
      [{ success: false, error: 'nope' }],                     // a failure
    ]) {
      const { loop, calls, ended } = stub(replies);
      await runSubAgentSession(loop, 'research', 'x', 'gemini');
      assert.equal(ended.length, 1, 'exactly one end_session');
      assert.equal(ended[0], calls[0].session, 'for the session that was opened');
    }
  });
});
