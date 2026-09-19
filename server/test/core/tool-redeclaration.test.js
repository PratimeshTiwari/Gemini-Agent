/**
 * Putting the tools back without resending everything else.
 *
 * When the model answers "I cannot execute local commands", `agent-loop`
 * re-declares its tools and retries the turn once. That repair used to go
 * through `resetPromptState()`, which does not mean "send the tools again" —
 * it means "pretend this chat has never seen a prompt", so the next turn is a
 * full turn-0 payload: system instructions, tool definitions, `AGENT.md`,
 * memory and the skill catalogue.
 *
 * The model had not forgotten the project. It had forgotten one block. And
 * `PromptBuilder` tiers its prompts in the first place because a large
 * repeated payload is what trips Gemini's repetition and A/B-test filters —
 * so the old repair fired the heaviest prompt in the system at the exact
 * moment the session was already unhealthy.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PromptBuilder } from '../../src/core/prompt-builder.js';

const WS = process.cwd();
const OPTS = {
  userMessage: 'fix the failing test',
  mode: 'auto',
  topology: 'single',
  modelConfig: { effort: 'standard' },
  objective: 'fix the failing test',
};

/** A builder that has already sent its turn-0 prompt, as a live session has. */
function warmed() {
  const b = new PromptBuilder(WS, `${WS}/server`);
  b.buildPrompt(OPTS);
  return b;
}

/** The definitions carry a `## <tool>` heading per tool; the index is names only. */
const hasFullDefinitions = (s) => /^## read_file$/m.test(s);
// NOT anchored to a line start: the prompt opens with a zero-width space, so
// `/^<system_state/m` never matches and every assertion built on it passes
// for the wrong reason. It did, until this test's own negative case caught it.
const isTurnZero = (s) => s.includes('<system_state');

test('the repair carries the full tool definitions', () => {
  const b = warmed();
  b.requestToolRedeclaration();
  const prompt = b.buildPrompt(OPTS);

  assert.ok(hasFullDefinitions(prompt), 'the names alone are what just failed');
});

test('the repair is not a turn-0 prompt', () => {
  const b = warmed();
  b.requestToolRedeclaration();
  const repair = b.buildPrompt(OPTS);

  assert.ok(!isTurnZero(repair), 'must not re-open <system_state> and resend everything');
  assert.ok(
    !/^<agent_instructions>$/m.test(repair),
    'AGENT.md is not something the model forgot',
  );
});

test('the repair is materially smaller than the one it replaces', () => {
  const repairB = warmed();
  repairB.requestToolRedeclaration();
  const repair = repairB.buildPrompt(OPTS);

  const resetB = warmed();
  resetB.resetPromptState();
  const full = resetB.buildPrompt(OPTS);

  assert.ok(
    repair.length < full.length * 0.75,
    `repair ${repair.length} should be well under the ${full.length} of a full resend`,
  );
});

test('it is one-shot', () => {
  const b = warmed();
  b.requestToolRedeclaration();
  b.buildPrompt(OPTS);
  const next = b.buildPrompt(OPTS);

  assert.ok(!hasFullDefinitions(next), 'the turn after must be an ordinary short turn');
});

test('a repair outranks the periodic refresh', () => {
  // The refresh tier sends tool *names*. Letting it win here would answer a
  // model that just proved names are not enough with names.
  const b = warmed();
  b.messagesSinceRefresh = 9999;
  b.requestToolRedeclaration();
  const prompt = b.buildPrompt(OPTS);

  assert.ok(hasFullDefinitions(prompt));
});

test('a full reset satisfies and clears a pending repair', () => {
  const b = warmed();
  b.requestToolRedeclaration();
  b.resetPromptState();

  const first = b.buildPrompt(OPTS);
  assert.ok(isTurnZero(first), 'the reset still produces its turn-0 prompt');
  assert.ok(hasFullDefinitions(first), 'which carries the definitions anyway');

  const second = b.buildPrompt(OPTS);
  assert.ok(!hasFullDefinitions(second), 'so the repair must not also fire on the next turn');
});
