/**
 * On `deep`, the hostile reviewer is a second tab when there is one.
 *
 * `deep` already ended with "read the diff as a hostile reviewer" — and the
 * model reviewing its own diff **in its own thread** is the weakest reviewer
 * available: it shares every assumption that produced the code. A second tab
 * shares the weights and not the conversation, which is the half that matters
 * here: it has nothing to reason from but the code it is sent.
 *
 * The current reading of the multi-agent literature is that extra agents earn
 * their place when they contribute **intelligence rather than actions**, and
 * writes stay single-threaded. This is exactly that shape: one reviewer, no
 * write access, the main lane still owns every edit. It is also the one case
 * that genuinely runs in parallel here — `extension-lock` gives each *tab* a
 * lane, so a subagent turn overlaps the main one whatever model it is on.
 *
 * Scoped to `deep` **and** a configured reviewer. Asking for `ask_reviewer`
 * where the tool is not offered would instruct the model to call something it
 * has never been given — the failure `toolCatalogDrift` exists to prevent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PromptBuilder } from '../../src/core/prompt-builder.js';

const WS = process.cwd();
const build = (subagents, modelConfig) => new PromptBuilder(WS, `${WS}/server`)
  .buildPrompt({ userMessage: 'x', mode: 'auto', subagents, modelConfig, objective: 'x' });

const WITH_SUBAGENTS = { effort: 'deep', main: 'gemini' };
const NO_SUBAGENTS = { effort: 'deep', main: 'gemini' };

test('with subagents, deep sends the diff out rather than reviewing itself', () => {
  const p = build(true, WITH_SUBAGENTS);
  assert.match(p, /Send the diff to `ask_subagent` with `role: "review"`/);
  assert.ok(!/Adversarial self-review/.test(p), 'and stops asking it to review itself');
});

test('the tool it is told to call is actually offered', () => {
  // Instructing a call to a tool the prompt never defines is the drift
  // `toolCatalogDrift` exists to catch.
  assert.match(build(true, WITH_SUBAGENTS), /^## ask_subagent$/m);
});

test('without subagents, deep reviews itself as before', () => {
  const p = build(false, NO_SUBAGENTS);
  assert.match(p, /Adversarial self-review/);
  assert.equal((p.match(/ask_subagent/g) || []).length, 0,
    'solo must not mention a tool it has not been given');
});

test('the step is deep-only — standard does not get it', () => {
  // `standard`'s promise is a four-phase protocol, not a second opinion on
  // every change; a review costs a whole extra turn.
  const p = build('duo', { effort: 'standard', main: 'gemini', reviewer: 'chatgpt' });
  assert.ok(!/Send the diff to `ask_reviewer`/.test(p));
});
