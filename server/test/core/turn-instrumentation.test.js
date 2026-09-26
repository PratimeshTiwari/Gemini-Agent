/**
 * The three failures that were happening and were counted nowhere.
 *
 * `/logs rates` turns an argument into a number, and until 2026-09-21 it could
 * answer four questions. Two more were being reported from use with no row to
 * land in, and a third — the picker mismatch — had a warning that could not see
 * the case it was written for.
 *
 * Every remaining decision about turn 0 depends on these, which is why they come
 * before the prompt work rather than after it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CHANNEL_OPS, MIN_TURNS_FOR_RATE } from '../../src/core/channel-health.js';
import { modelMismatch } from '../../src/core/model-match.js';

const loopSrc = readFileSync(new URL('../../src/core/agent-loop.js', import.meta.url), 'utf8');

describe('what /logs rates can answer', () => {
  test('the two new failures have rows', () => {
    const ops = CHANNEL_OPS.map((r) => r.op);
    assert.ok(ops.includes('premature_conclusion'),
      'a reply that concluded while still calling tools is unmeasurable');
    assert.ok(ops.includes('turn0_no_tools'),
      'turn 0 answering blind is unmeasurable, which is where it started');
  });

  test('every row is named and explained', () => {
    for (const row of CHANNEL_OPS) {
      assert.ok(row.op && row.label && row.detail, `${row.op} is missing a label or detail`);
    }
    assert.equal(new Set(CHANNEL_OPS.map((r) => r.op)).size, CHANNEL_OPS.length,
      'two rows share an op, so one of them counts the other');
  });

  // A percentage over five turns is theatre. The count is still shown, so a
  // young log reads as "2 failures, too few turns to rate".
  test('the rate floor is still meaningful', () => {
    assert.ok(MIN_TURNS_FOR_RATE >= 20);
  });
});

describe('turn0_no_tools is emitted from the right place', () => {
  test('all three halves are required', () => {
    assert.match(
      loopSrc,
      /if \(isFirstReply && !premature && openedNothing\s*\n?\s*&& looksLikeCodeQuestion\(this\.currentObjective\)\)/,
      'the combination is what makes it a failure — any one alone is ordinary',
    );
    assert.match(loopSrc, /op: 'turn0_no_tools'/);
  });

  /*
   * The half that was missing, and the reason it matters more than it looks.
   *
   * `isFirstReply` reads `conversationHistory` for an `agent`/`assistant` turn.
   * A tool round pushes `role: 'system'` and nothing else, so it stays true for
   * every round of turn 0 — and the final prose reply, which by then has no
   * tool calls of its own, tripped the pair. Caught on 2026-09-24 by running
   * the real agent: four files opened, an accurate answer, and a log line
   * saying it "answered without opening anything".
   *
   * That is a false positive on the *best* available outcome — investigate,
   * then answer — so it would have inflated the rate the turn-0 work is gated
   * on, in the opposite direction from the blindness fixed in #26.
   */
  test('a turn that opened something is not a turn that opened nothing', () => {
    assert.match(
      loopSrc,
      /const openedNothing = !this\._turnEvidence\?\.size;/,
      'the check must be the turn\'s evidence, not whether this one reply called a tool',
    );
    // And the evidence it reads has to be per user turn, or a second question
    // in the same session inherits the first one's tool calls and never fires.
    assert.match(loopSrc, /this\._turnEvidence = new Map\(\);/);
  });

  test('it reads the request, not the reply', () => {
    // "here is how the UI works" is a good answer to a question about UI design
    // and a fabrication when the question was about *this* UI. Only the request
    // separates them.
    assert.match(loopSrc, /looksLikeCodeQuestion\(this\.currentObjective\)/);
  });

  test('the first-reply flag is captured before the reply is pushed', () => {
    const decl = loopSrc.indexOf('const isFirstReply =');
    const push = loopSrc.indexOf('this.conversationHistory.push(agentTurn)');
    assert.ok(decl !== -1 && push !== -1);
    assert.ok(decl < push,
      'counted after pushing this turn, so turn 0 can never look like turn 0');
  });

  // Recorded, never acted on. A first answer from memory is sometimes right,
  // and re-asking on suspicion spends a turn to second-guess the model.
  test('it does not retry or re-ask', () => {
    const i = loopSrc.indexOf("op: 'turn0_no_tools'");
    const after = loopSrc.slice(i, i + 400);
    assert.doesNotMatch(after, /_sendToGemini|requestToolRedeclaration|resetPromptState/,
      'the detector started acting on its own finding');
  });
});

describe('the picker mismatch can finally see its own case', () => {
  const picker = (selected) => [
    { label: '3.5 Flash-Lite — fastest' },
    { label: '3.8 Flash — all-around help' },
    { label: '3.1 Pro — reasoning & advanced' },
    { label: 'Extended thinking — complex problem solving' },
  ].map((m) => ({ ...m, selected: m.label.startsWith(selected) }));

  test('pro rung against a Flash tab is a mismatch', () => {
    const m = modelMismatch('high', picker('3.8 Flash'));
    assert.ok(m, 'the documented worst pairing reports nothing');
    assert.match(m.current, /Flash/);
    assert.match(m.wanted, /Pro/);
  });

  test('agreement is silent', () => {
    assert.equal(modelMismatch('high', picker('3.1 Pro')), null);
  });

  // This was the real bug: the list was requested once, 1.5s after the extension
  // connected, and never again — so a picker changed mid-session was invisible,
  // which is exactly when someone changes it.
  test('nothing can be said without a list, so the list is refreshed', () => {
    assert.equal(modelMismatch('high', []), null, 'an empty list must stay silent');
    assert.match(loopSrc, /this\.requestModelOptions\(\)/);
    assert.match(loopSrc, /MODEL_POLL_INTERVAL_MS/,
      'the refresh is unthrottled, so it costs a message every turn forever');
  });

  test('the refresh waits for the turn to be over', () => {
    const poll = loopSrc.indexOf('this._lastModelPoll = now');
    const audit = loopSrc.indexOf('this._auditHandover(cleanContent)');
    assert.ok(poll !== -1 && audit !== -1);
    assert.ok(poll > audit,
      'discovery races the turn it is meant to follow');
  });
});
