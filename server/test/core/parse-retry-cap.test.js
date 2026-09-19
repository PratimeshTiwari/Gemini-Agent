/**
 * The one retry path that had no ceiling.
 *
 * On a `JSON.parse` failure the loop pushes an `ERROR PARSING TOOL CALLS` turn
 * and calls `_sendToGemini` again. There was no counter: a model stuck on a
 * formatting habit re-asked forever, a full browser turn each round, and the
 * only thing that stopped it was the user.
 *
 * Every other retry here is capped — `MAX_PROVIDER_RETRIES`, the one-shot
 * unsubmitted resend, the one-shot tool redeclaration. This one was missed.
 *
 * What it does on the third failure matters as much as stopping: the raw reply
 * almost always contains the answer in prose, because the model knew what to
 * do and could not wrap it in JSON. Ending the turn silently would throw that
 * away, which is the same shape as the `ask_reviewer` bug next door.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop } from '../../src/core/agent-loop.js';

/** A loop with the bridge replaced by lists of what it was asked to send. */
function loop() {
  const dir = mkdtempSync(join(tmpdir(), 'parsecap-'));
  const l = new AgentLoop({
    workspace: dir, mcpServer: {}, promptBuilder: {}, diffEngine: {}, riskClassifier: {},
  });
  const sent = [];
  const panel = [];
  l.promptBuilder = { noteDrift() {}, resetPromptState() {} };
  l.callbacks = { sendToPanel: (m) => panel.push(m), injectPrompt: (p) => sent.push(p) };
  l.isProcessing = true;
  return { l, sent, panel };
}

// Matches TOOL_CALL_REGEX (a fenced `{…}`) and fails JSON.parse, which is the
// combination that reaches the catch. A block that does not match the regex is
// just prose and never gets there.
const BROKEN = 'Here is the fix.\n```json\n{"name": "edit_file", "args": {"path": }}\n```';

const reply = (content) => ({ content, complete: true });

test('a malformed tool call is re-asked, but not forever', async () => {
  const { l, sent, panel } = loop();

  await l.handleGeminiResponse('m1', reply(BROKEN));
  assert.equal(sent.length, 1, 'first failure asks for a correction');

  await l.handleGeminiResponse('m2', reply(BROKEN));
  assert.equal(sent.length, 2, 'second failure asks once more');

  await l.handleGeminiResponse('m3', reply(BROKEN));
  assert.equal(sent.length, 2, 'the third does not re-ask');

  const answer = panel.filter((m) => m.type === 'agent_response');
  assert.equal(answer.length, 1, 'and the turn ends with something to read');
  assert.match(answer[0].payload.message, /could not format a tool call/);
  assert.match(answer[0].payload.message, /Here is the fix\./, 'the prose is handed over');
  assert.equal(l.isProcessing, false, 'the turn is over, not wedged');
});

/*
 * The negative control. The cap counts a *run* of malformed replies, not a
 * tally across the session — otherwise a session with three scattered format
 * slips would refuse to retry the fourth, hours later, for no reason the
 * person could see.
 */
test('a clean parse in between clears the count', async () => {
  const { l, sent } = loop();

  await l.handleGeminiResponse('m1', reply(BROKEN));
  await l.handleGeminiResponse('m2', reply(BROKEN));
  assert.equal(sent.length, 2);

  // A reply that parses. No tool calls in it, so the turn simply ends.
  l.isProcessing = true;
  await l.handleGeminiResponse('m3', reply('All done — nothing else to change.'));
  assert.equal(l._parseRetries, 0, 'a parse resets the run');

  l.isProcessing = true;
  await l.handleGeminiResponse('m4', reply(BROKEN));
  assert.equal(sent.length, 3, 'so the next failure is a first failure again');
});

/*
 * Nothing readable is still an ending, not a hang: the alternative is a turn
 * that never resolves and an extension lane held until the watchdog fires.
 *
 * `null` rather than a broken fence, because a broken fence *is* readable —
 * it is handed over whole, which is the point of the branch above. The only
 * way to reach the catch with nothing to show is content that is not a string
 * at all, and `_extractToolCalls` throws on that before it parses anything.
 */
test('a reply with nothing in it still ends the turn', async () => {
  const { l, panel } = loop();

  for (const id of ['m1', 'm2', 'm3']) {
    l.isProcessing = true;
    await l.handleGeminiResponse(id, { content: null, complete: true });
  }

  const answer = panel.filter((m) => m.type === 'agent_response');
  assert.equal(answer.length, 1);
  assert.match(answer[0].payload.message, /returned nothing readable/);
  assert.equal(l.isProcessing, false);
});
