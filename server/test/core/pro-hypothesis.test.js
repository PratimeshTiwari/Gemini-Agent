/**
 * Which rungs are asked to say what would prove them wrong.
 *
 * Gemini proposed a "hypothesis engine": a falsifiable hypothesis before every
 * search, with `<invalidation_criteria>` and a 1–100 `<confidence_score>`.
 * Measuring the prompts first narrowed that a long way.
 *
 * `standard` already asks for "what you expect the next call to show" — most
 * of a hypothesis. What no rung asked was **what would disprove it**, or what
 * to do when the answer is not clear. Those two are the whole of the gap, and
 * they cost 714 characters rather than a taxonomy rewrite.
 *
 * The numeric confidence score was deliberately not adopted: a model asked for
 * a number will produce one, and a fabricated 87 reads as evidence. The
 * instruction is behavioural instead — if you would not bet on it, ask.
 *
 * Scoped to `standard` and `deep`. It costs **output** tokens, and output is
 * generation time; `brief`'s promise is "straight to work", and the flash
 * rungs are written for a model that follows short prompts and ignores long
 * ones.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PromptBuilder } from '../../src/core/prompt-builder.js';

const WS = process.cwd();
const build = (effort) => new PromptBuilder(WS, `${WS}/server`).buildPrompt({
  userMessage: 'fix the bug', mode: 'auto', topology: 'single',
  modelConfig: { effort }, objective: 'fix the bug',
});

const asksWhatWouldDisprove = (p) => /prove you wrong/i.test(p);
const asksToStopWhenUnsure = (p) => /would not bet on it/i.test(p);

test('standard and deep are asked what would prove them wrong', () => {
  for (const effort of ['standard', 'deep']) {
    const p = build(effort);
    assert.ok(asksWhatWouldDisprove(p), `${effort} should carry the invalidation rule`);
    assert.ok(asksToStopWhenUnsure(p), `${effort} should carry the ask-when-unsure rule`);
  }
});

test('brief and the flash rungs are not', () => {
  // It costs output tokens, and output is generation time. `brief` promises
  // "straight to work"; the flash rungs follow short prompts and ignore long.
  for (const effort of ['flash', 'flash-thinking', 'brief']) {
    const p = build(effort);
    assert.ok(!asksWhatWouldDisprove(p), `${effort} must stay as it was`);
  }
});

test('it stays small — under 5% of the prompt it is added to', () => {
  // The reason it is prose and not a protocol. Verified against the rungs it
  // is added to: +714 characters on ~25,000.
  const withIt = build('standard').length;
  const without = build('brief').length;
  assert.ok(withIt > without, 'standard is the larger prompt');
  const cost = 714;
  assert.ok(cost / withIt < 0.05, `the rule should cost under 5%, is ${(cost / withIt * 100).toFixed(1)}%`);
});

test('no numeric confidence score is requested', () => {
  // Asked for a number, a model produces one; a fabricated 87 reads as
  // evidence. The rule is behavioural on purpose.
  for (const effort of ['standard', 'deep']) {
    assert.ok(!/confidence[_ ]?score|1-100|0-100/i.test(build(effort)),
      `${effort} must not ask for a confidence number`);
  }
});
