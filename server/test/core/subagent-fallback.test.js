/**
 * A missing `return_result` is not a missing answer.
 *
 * Observed on `deep` + `duo`, 2026-09-19: `ask_reviewer` produced a complete,
 * well-formed adversarial review, ended it in prose rather than a tool call,
 * and the transcript row read `✗ ask_reviewer · Subagent failed to use the
 * return_result tool. Raw output: …` followed by the review itself. The answer
 * was in the payload and was discarded on a protocol technicality — in the one
 * step whose whole purpose is catching what the author's own assumptions hide.
 *
 * The mechanism was `if (toolCalls.length === 0) break;` dropping straight
 * through to a hard failure, with `lastCleanContent` already holding the text.
 *
 * Fail open, the same trade as `looksLikeCapabilityDenial`. The three negative
 * controls below are the point of the file: a fallback that fires when it
 * should not is worse than the bug, because it would report an empty review as
 * a successful one.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { AgentLoop } from '../../src/core/agent-loop.js';

describe('_runSubAgentSession falls back to prose', () => {
  let ws;
  before(() => {
    ws = mkdtempSync(join(tmpdir(), 'subagent-'));
    mkdirSync(join(ws, '.agent'), { recursive: true });
  });
  after(() => rmSync(ws, { recursive: true, force: true }));

  /**
   * `replies` is what the browser tab would have said, one per turn. Nothing
   * here stubs `_extractToolCalls` — that is the parser the whole text channel
   * stands on, and a fake one would make this test agree with itself.
   */
  const loopWith = (replies) => {
    const loop = Object.create(AgentLoop.prototype);
    loop.workspace = ws;
    loop.modelConfig = { main: 'gemini', reviewer: 'gemini' };
    loop.promptBuilder = { buildSubagentWrapper: () => 'You are a reviewer.' };
    loop.callbacks = { sendToPanel() {} };
    loop.mcpServer = { executeTool: async () => ({ success: true, result: 'ok' }) };
    let i = 0;
    loop._executeSubagent = async () => ({ success: true, result: replies[i++] ?? '' });
    return loop;
  };

  const REVIEW = '## Review\n\nThe cap is off by one: `i <= max` should be `i < max`.';

  test('a review that ends in prose is used, and marked', async () => {
    const out = await loopWith([REVIEW])._runSubAgentSession('reviewer', 'check this', 'gemini');

    assert.equal(out.success, true, 'the review must not be thrown away');
    assert.equal(out.result, REVIEW);
    assert.equal(out.unstructured, true, 'and the caller must be able to tell');
  });

  test('return_result is still the normal path, and is not marked', async () => {
    const call = JSON.stringify({ name: 'return_result', args: { result: REVIEW } });
    const loop = loopWith([`Here it is.\n\`\`\`json\n${call}\n\`\`\``]);
    const out = await loop._runSubAgentSession('reviewer', 'check this', 'gemini');

    assert.equal(out.success, true);
    assert.equal(out.result, REVIEW);
    assert.equal(out.unstructured, undefined, 'a structured return is not a fallback');
  });

  // The control that matters most. With nothing to fall back to, "success"
  // would hand the caller an empty review to reason from — which is the
  // original bug pointing the other way.
  test('a subagent that said nothing at all still fails', async () => {
    const out = await loopWith(['', '', '', '', '', ''])
      ._runSubAgentSession('reviewer', 'check this', 'gemini');

    assert.equal(out.success, false);
    assert.match(out.error, /no output at all/);
    assert.equal(out.result, undefined);
  });

  // Whitespace is not content. Without this, a reply of three newlines reads
  // as a review.
  test('whitespace is not an answer', async () => {
    const out = await loopWith(['   \n\n  ', '\t'])._runSubAgentSession('reviewer', 'x', 'gemini');
    assert.equal(out.success, false);
  });

  // The observed shape: it worked for a few turns, then ran out of format.
  // The last thing it actually said is the answer, not the first.
  test('after real tool calls, the final prose is what comes back', async () => {
    const read = JSON.stringify({ name: 'read_file', args: { path: 'a.js' } });
    const loop = loopWith([
      `Looking now.\n\`\`\`json\n${read}\n\`\`\``,
      REVIEW,
    ]);
    const out = await loop._runSubAgentSession('reviewer', 'check this', 'gemini');

    assert.equal(out.success, true);
    assert.equal(out.result, REVIEW);
    assert.equal(out.unstructured, true);
  });
});
