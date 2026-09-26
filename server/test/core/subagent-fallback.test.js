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
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'fs';
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

/**
 * A subagent that cannot run hands the work back, labelled.
 *
 * Returning a bare error loses the task: the model reads "that call failed, fix
 * it yourself" as being about the *call* rather than about the work the call was
 * carrying, and the round is spent.
 *
 * The label is the difficulty, not the fallback. If a failed `review` quietly
 * becomes the author reviewing their own diff, the one thing a reviewer was for
 * — not sharing the assumptions that produced the code — is gone, and nothing on
 * screen says so. Degrade, and say you degraded.
 */
describe('a failed subagent falls back in-thread', () => {
  const driven = (subagentResult) => {
    const dir = mkdtempSync(join(tmpdir(), 'fallback-'));
    const l = Object.create(AgentLoop.prototype);
    Object.assign(l, {
      workspace: dir,
      mode: 'auto',
      modelConfig: { main: 'gemini', subagents: true },
      conversationHistory: [],
      commandRules: { enabled: false, allow: [], block: [] },
      sessionStore: { appendTurn() {} },
      riskClassifier: { classify: () => ({ level: 'safe', reason: '' }) },
      mcpServer: { executeTool: async () => ({ success: true }) },
      promptBuilder: { noteMessageSent() {}, buildToolResultBatch: (r) => JSON.stringify(r) },
      callbacks: { sendToPanel() {} },
      _sendToGemini() {},
      _turnEvidence: new Map(),
      _runSubAgentSession: async () => subagentResult,
    });
    return { l, dir };
  };

  const failed = { success: false, error: 'no Gemini tab' };

  test('the task comes back rather than being lost', async () => {
    const { l, dir } = driven(failed);
    await l._executeToolCalls([
      { name: 'ask_subagent', args: { role: 'research', prompt: 'find every caller of _findMatch' } },
    ]);

    const turn = l.conversationHistory.find((t) => t.type === 'tool_result');
    assert.match(turn.result, /could not run/);
    assert.match(turn.result, /find every caller of _findMatch/, 'the task was dropped');
    assert.equal(turn.success, true, 'a recoverable failure must not end the round');
    rmSync(dir, { recursive: true, force: true });
  });

  /*
   * The control that matters. Without this line the user reads a review
   * believing it came from a fresh context, which is the confident-wrong-answer
   * class this whole mechanism exists to avoid.
   */
  test('a fallback review is required to admit it is self-review', async () => {
    const { l, dir } = driven(failed);
    await l._executeToolCalls([
      { name: 'ask_subagent', args: { role: 'review', prompt: 'check this diff' } },
    ]);

    const turn = l.conversationHistory.find((t) => t.type === 'tool_result');
    assert.match(turn.result, /reviewing your own work/);
    assert.match(turn.result, /say in your answer that this review is your own/);
    rmSync(dir, { recursive: true, force: true });
  });

  // Research and errands have no such trap — there is nothing about a fresh
  // context that made the answer trustworthy, so no warning is owed.
  test('only review carries the warning', async () => {
    for (const role of ['research', 'task']) {
      const { l, dir } = driven(failed);
      await l._executeToolCalls([{ name: 'ask_subagent', args: { role, prompt: 'x' } }]);
      const turn = l.conversationHistory.find((t) => t.type === 'tool_result');
      assert.doesNotMatch(turn.result, /your own work/, `${role} should not warn`);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a subagent that worked is passed through untouched', async () => {
    const { l, dir } = driven({ success: true, result: 'the review body' });
    await l._executeToolCalls([{ name: 'ask_subagent', args: { role: 'review', prompt: 'x' } }]);

    const turn = l.conversationHistory.find((t) => t.type === 'tool_result');
    assert.equal(turn.result, 'the review body');
    assert.doesNotMatch(turn.result, /could not run/);
    rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * The watchdog is a deadline, and a deadline wants evidence.
 *
 * It was five minutes. Measured over 350 recorded turns on the owner's
 * machine: median 8.5s, p90 20.9s, p99 44.7s, and **55.7s for the slowest turn
 * ever recorded**. Five minutes is 5.4× that slowest turn — so a subagent
 * silent at two minutes is not slow, it is gone.
 *
 * The whole of that wait was spent *before* `askSubagent` could hand the work
 * back and do it inline, which it has been able to do since 2026-09-19. The
 * cost of the watchdog being slightly too tight is bounded and visible: the
 * work is handed back, labelled, and done in the main conversation. The cost of
 * it being far too loose is five minutes of nothing.
 */
test('the subagent watchdog stays within reach of measured turn times', () => {
  const src = readFileSync(
    new URL('../../src/core/agent-loop.js', import.meta.url), 'utf8',
  );
  const expr = /const SUBAGENT_WATCHDOG_MS = ([^;]+);/.exec(src)[1];
  // eslint-disable-next-line no-eval
  const ms = eval(expr);

  assert.ok(ms >= 60_000,
    `${ms}ms is inside the tail of normal turns (p99 was 44.7s) — a healthy `
    + 'subagent would be abandoned and its work redone');
  assert.ok(ms <= 180_000,
    `${ms}ms is more than 3× the slowest turn ever recorded (55.7s); the wait `
    + 'is spent before the work can be handed back and done inline');
});
