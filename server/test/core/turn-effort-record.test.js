/**
 * Which rung a reply was produced at, on the reply.
 *
 * Nothing recorded it, and that made a class of question unanswerable. "Does
 * `deep`'s assumption ledger ever actually get written?" is the cheap way to
 * tell an instruction that works from one the model ignores — the same
 * question that found the write-only traps — and answering it needs to know
 * which turns ran at `deep`.
 *
 * Measured across 412 stored agent replies before this existed: zero assumption
 * ledgers, zero approach enumerations, zero reviewer calls, against a working
 * control of 8 handover blocks. Which settled nothing, because the rung was not
 * on the record: "deep's blocks are inert" and "deep was rarely used" look
 * identical from the outside.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop } from '../../src/core/agent-loop.js';

function loopAt(effort) {
  const dir = mkdtempSync(join(tmpdir(), 'rung-'));
  mkdirSync(join(dir, '.agent'), { recursive: true });
  const filed = [];
  const l = Object.create(AgentLoop.prototype);
  Object.assign(l, {
    workspace: dir,
    modelConfig: { main: 'gemini', effort },
    conversationHistory: [],
    isProcessing: true,
    sessionStore: { appendTurn: (t) => filed.push(t), saveHistory() {} },
    promptBuilder: { noteDrift() {}, resetPromptState() {} },
    callbacks: { sendToPanel() {} },
    extensionLock: { release() {}, abortAll() {} },
    contextManager: { needsCompaction: () => false },
    _turnEvidence: new Map(),
    _releaseExtension() {},
  });
  return { l, filed, dir };
}

describe('an agent reply records its rung', () => {
  for (const effort of ['low', 'standard', 'deep']) {
    test(`a ${effort} turn is filed as ${effort}`, async () => {
      const { l, filed, dir } = loopAt(effort);
      await l.handleGeminiResponse('m1', { content: 'Done.', complete: true });

      const reply = filed.find((t) => t.role === 'agent');
      assert.ok(reply, 'no agent turn was filed at all');
      assert.equal(reply.effort, effort);
      rmSync(dir, { recursive: true, force: true });
    });
  }

  /*
   * It has to reach the *durable* record, not just the in-memory one — the
   * whole point is reading it back weeks later, after compaction has moved the
   * turn into the archive.
   */
  test('it is on the filed copy, not only in memory', async () => {
    const { l, filed, dir } = loopAt('deep');
    await l.handleGeminiResponse('m1', { content: 'Done.', complete: true });

    assert.equal(filed.find((t) => t.role === 'agent').effort, 'deep');
    assert.equal(l.conversationHistory.find((t) => t.role === 'agent').effort, 'deep');
    rmSync(dir, { recursive: true, force: true });
  });

  // A loop with no effort set must file `null` rather than crash or invent one.
  // An invented default would quietly attribute turns to a rung they never ran at.
  test('an unset rung is recorded as null, not guessed', async () => {
    const { l, filed, dir } = loopAt(undefined);
    await l.handleGeminiResponse('m1', { content: 'Done.', complete: true });

    assert.equal(filed.find((t) => t.role === 'agent').effort, null);
    rmSync(dir, { recursive: true, force: true });
  });
});
