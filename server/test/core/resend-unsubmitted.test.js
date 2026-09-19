/**
 * The one timeout it is safe to retry.
 *
 * The content script gives up after five minutes and reports `timedOut`, and
 * the loop's answer was always the same: show the diagnosis, end the turn.
 * But two very different things wear that label, and the content script can
 * tell them apart.
 *
 * If it saw Gemini generating, the model HAS an answer and we failed to read
 * it — resending asks the same question twice, into a thread that already
 * holds the first reply. If generation never started and nothing was scraped,
 * the submit itself did not happen: the model has no idea the turn exists, so
 * sending it is not a repeat, it is the first attempt finally landing.
 *
 * Only the second is retried, and only once.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop } from '../../src/core/agent-loop.js';

/** A loop with the bridge replaced by a list of what it was asked to send. */
function loop() {
  const dir = mkdtempSync(join(tmpdir(), 'resend-'));
  const l = new AgentLoop({
    workspace: dir, mcpServer: {}, promptBuilder: {}, diffEngine: {}, riskClassifier: {},
  });
  const sent = [];
  l.callbacks = { sendToPanel: () => {}, injectPrompt: (p) => sent.push(p) };
  l.isProcessing = true;
  l._lastMainPrompt = 'THE ORIGINAL PROMPT, VERBATIM';
  l._resentUnsubmittedOnce = false;
  return { l, sent };
}

const timedOut = (extra) => ({ content: '[diagnosis]', complete: false, timedOut: true, ...extra });

test('resends when the prompt never reached the composer', async () => {
  const { l, sent } = loop();
  await l.handleGeminiResponse('m1', timedOut({ neverSubmitted: true }));

  assert.equal(sent.length, 1, 'should put the turn back on the wire');
  assert.equal(sent[0].prompt, 'THE ORIGINAL PROMPT, VERBATIM',
    'verbatim — rebuilding would drop the system prompt the tab never received');
  assert.equal(l.isProcessing, true, 'the turn is still alive');
});

test('does NOT resend when the model was already generating', async () => {
  const { l, sent } = loop();
  await l.handleGeminiResponse('m1', timedOut({ neverSubmitted: false }));

  assert.equal(sent.length, 0, 'the model has an answer; asking twice corrupts the thread');
  assert.equal(l.isProcessing, false, 'and the turn ends');
});

test('an ordinary timeout with no flag is not retried', async () => {
  // A ChatGPT tab, or an older content script: the field is simply absent.
  const { l, sent } = loop();
  await l.handleGeminiResponse('m1', timedOut({}));

  assert.equal(sent.length, 0, 'absence of evidence is not evidence the submit failed');
  assert.equal(l.isProcessing, false);
});

test('it retries once, not forever', async () => {
  const { l, sent } = loop();
  await l.handleGeminiResponse('m1', timedOut({ neverSubmitted: true }));
  l.isProcessing = true;
  await l.handleGeminiResponse('m2', timedOut({ neverSubmitted: true }));

  assert.equal(sent.length, 1, 'a second failure means the composer changed; the diagnosis is worth more');
  assert.equal(l.isProcessing, false, 'and the turn ends');
});

test('nothing to resend means nothing is invented', async () => {
  const { l, sent } = loop();
  l._lastMainPrompt = null;
  await l.handleGeminiResponse('m1', timedOut({ neverSubmitted: true }));

  assert.equal(sent.length, 0);
  assert.equal(l.isProcessing, false);
});

test('the prompt it resends is the one _sendToGemini actually sent', async () => {
  // The tests above set `_lastMainPrompt` by hand, which leaves the wiring
  // that captures it untested — deleting the assignment in `_sendToGemini`
  // broke nothing. This drives the real path.
  const { l, sent } = loop();
  l._lastMainPrompt = null;
  l.modelConfig = { main: 'gemini' };

  await l._sendToGemini('WHAT THE BUILDER PRODUCED', l.callbacks);
  assert.equal(sent.length, 1, 'the original dispatch');

  l.isProcessing = true;
  await l.handleGeminiResponse('m1', timedOut({ neverSubmitted: true }));

  assert.equal(sent.length, 2, 'and the resend');
  assert.equal(sent[1].prompt, 'WHAT THE BUILDER PRODUCED');
});
