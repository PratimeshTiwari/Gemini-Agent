/**
 * A conclusion written before its own evidence is not shown.
 *
 * Reported with three screenshots, 2026-09-21. A `## Review` block listing five
 * **Verified Files** — two of which did not exist, one in a directory deleted
 * wholesale in `e375aed` — arrived *above* the `<tool_results>` that were meant
 * to support it, with an invented architecture attached (`agentLoop.on(...)`,
 * `F2` navigation, three dialog components, none of which exist).
 *
 * The model had already been told not to. Every tool-result turn ends with
 * *"Reply once, with exactly one of: the next tool call, or your final answer to
 * the user"*, and that is the turn this happened on. So the prompt rule added to
 * `tool-call-format-full.md` is the weaker half: an instruction can be ignored,
 * and was. The loop declining to print the conclusion cannot be.
 *
 * Observing the withheld branch needs a live turn under the pty harness, so the
 * gate itself is pinned as a source assertion — the same shape `startup-order`
 * and the local-command spinner already use, and for the same reason: the
 * regression is two lines that read as ordinary bookkeeping in a diff.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hasHandoverBlock } from '../../src/core/handover-audit.js';
import { PromptBuilder } from '../../src/core/prompt-builder.js';
import { AgentLoop } from '../../src/core/agent-loop.js';

const loopSrc = readFileSync(new URL('../../src/core/agent-loop.js', import.meta.url), 'utf8');
const parse = (t) => Object.create(AgentLoop.prototype)._extractToolCalls(t);
const block = (body) => '```json\n' + body + '\n```';
const CALL = block('{"name":"read_file","args":{"path":"a.js"}}');

test('hasHandoverBlock', async (t) => {
  await t.test('finds the closing report however much prose precedes it', () => {
    assert.equal(hasHandoverBlock('lots of prose\n\n## Review\n- Ran: tests'), true);
    assert.equal(hasHandoverBlock('#### Review'), true);
    assert.equal(hasHandoverBlock('  ## Review  '), true);
  });

  // The discriminator is the block, never length or tone. Ordinary narration
  // beside a tool call is correct and common, and eating it would cost far more
  // than this buys.
  await t.test('ordinary prose is not a conclusion', () => {
    assert.equal(hasHandoverBlock('Let me look at the parser.'), false);
    assert.equal(hasHandoverBlock('I will review the diff once the tests pass.'), false);
    assert.equal(hasHandoverBlock('## Review of the options'), false,
      'a heading that merely starts with Review is not the block');
    assert.equal(hasHandoverBlock(''), false);
    assert.equal(hasHandoverBlock(null), false);
  });
});

test('the shape that triggers it, through the real parser', async (t) => {
  const premature = (text) => {
    const { toolCalls, cleanContent } = parse(text);
    return toolCalls.length > 0 && hasHandoverBlock(cleanContent);
  };

  await t.test('a Review block beside a tool call is premature', () => {
    assert.equal(premature(`Here is what I found.\n\n## Review\n- Verified Files:\n    - a.js\n\n${CALL}`), true);
  });

  await t.test('a Review block with no tool call is a finished turn', () => {
    assert.equal(premature('## Review\n- Ran: npm test'), false);
  });

  await t.test('a tool call with ordinary narration is not premature', () => {
    assert.equal(premature(`Let me read it first.\n\n${CALL}`), false);
  });

  await t.test('a tool call alone is not premature', () => {
    assert.equal(premature(CALL), false);
  });
});

test('the loop acts on it', async (t) => {
  await t.test('agent_response is gated on the reply not being premature', () => {
    assert.match(loopSrc, /const premature = toolCalls\.length > 0 && hasHandoverBlock\(cleanContent\)/,
      'the gate is gone; a conclusion can reach the screen before its evidence');
    assert.match(loopSrc, /if \(cleanContent\.trim\(\) && !premature\)/,
      'the reply is shown regardless of whether it concluded early');
  });

  await t.test('it is recorded, so the rate is answerable', () => {
    assert.match(loopSrc, /op: 'premature_conclusion'/);
  });

  // Without a word the model believes it answered, and either repeats itself
  // verbatim or moves on — and the user sees neither version.
  await t.test('the model is told next turn, once', () => {
    assert.match(loopSrc, /this\._withheldConclusion = true/);
    assert.match(loopSrc, /this\._withheldConclusion = false/,
      'the flag is never cleared, so every later turn carries the notice');
  });
});

test('buildToolResultBatch carries the notice', async (t) => {
  const pb = () => new PromptBuilder(process.cwd());
  const results = [{ name: 'read_file', success: true, result: 'x' }];

  await t.test('present when something was withheld', () => {
    const out = pb().buildToolResultBatch(results, 'read_file x1', '', 'It was not shown.');
    assert.match(out, /It was not shown\./);
  });

  await t.test('absent otherwise, and the batch is unchanged', () => {
    const plain = pb().buildToolResultBatch(results, 'read_file x1', '');
    assert.doesNotMatch(plain, /not shown/);
    assert.equal(pb().buildToolResultBatch(results, 'read_file x1', '', ''), plain,
      'an empty notice changed the prompt');
  });

  // The last thing read hardest must stay "what to do next".
  await t.test('it sits above the closing instruction', () => {
    const out = pb().buildToolResultBatch(results, 'read_file x1', '', 'NOTICE_HERE');
    assert.ok(out.indexOf('NOTICE_HERE') < out.indexOf('Reply once'),
      'the notice displaced the instruction from the end');
  });
});
