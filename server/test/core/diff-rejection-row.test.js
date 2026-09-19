/**
 * A rejected edit has to look rejected.
 *
 * Reported from use: pressing reject on an `AGENT.md` edit left the transcript
 * reading `✓ edit_file · 1 hunk in AGENT.md`, in green, on a change that was
 * never written. The Gemini side had it right — the tab shows `User REJECTED
 * the edit to AGENT.md` — so the model was told the truth and the person
 * watching was not, which is the worse half of the two.
 *
 * The cause is ordering. `resultTurn` is recorded when the diff is *generated*,
 * which succeeds whether or not anyone approves it; the decision arrives about
 * ninety lines later and only corrected `toolResults`, the model's copy.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop } from '../../src/core/agent-loop.js';
import { summarizeResult } from '../../src/ui/format.js';

/** A loop that runs one `edit_file` and answers the approval prompt with `action`. */
function driven(action) {
  const dir = mkdtempSync(join(tmpdir(), 'reject-'));
  mkdirSync(join(dir, '.agent'), { recursive: true });
  const sent = [];
  const l = Object.create(AgentLoop.prototype);
  Object.assign(l, {
    workspace: dir,
    // Plan mode, because in auto a safe edit auto-applies and never reaches an
    // approval prompt at all — the first version of this fixture asserted on a
    // decision nobody was ever asked to make.
    mode: 'plan',
    modelConfig: { main: 'gemini' },
    conversationHistory: [],
    commandRules: { enabled: false, allow: [], block: [] },
    sessionStore: { appendTurn() {} },
    riskClassifier: { classify: () => ({ level: 'safe', reason: '' }) },
    mcpServer: {
      executeTool: async () => ({
        success: true,
        result: { diffId: 'd1', filePath: 'AGENT.md', hunkCount: 1, status: 'pending_approval' },
      }),
    },
    promptBuilder: { noteMessageSent() {}, buildToolResultBatch: (r) => JSON.stringify(r) },
    diffEngine: { acceptDiff: () => ({ success: true }), rejectDiff: () => ({ success: true }) },
    callbacks: {
      sendToPanel: (m) => sent.push(m),
      requestDiffApproval: () => setImmediate(() => l.pendingDiffResolve({ action })),
    },
    _sendToGemini() {},
    _turnEvidence: new Map(),
  });
  return { l, sent, dir };
}

const recorded = (l) => l.conversationHistory.find((t) => t.type === 'tool_result');

describe('the transcript records the approval decision', () => {
  test('a rejected edit is recorded as a failure', async () => {
    const { l, dir } = driven('reject');
    await l._executeToolCalls([{ name: 'edit_file', args: { path: 'AGENT.md' } }]);

    const turn = recorded(l);
    assert.equal(turn.success, false, 'the row would draw a green tick on an edit nobody took');
    assert.match(turn.result, /REJECTED/);
    rmSync(dir, { recursive: true, force: true });
  });

  // The control. Narrowing to "rejections are failures" must not turn an
  // approved edit into one — that would be the same lie pointing the other way.
  test('an approved edit is still recorded as a success', async () => {
    const { l, dir } = driven('accept');
    await l._executeToolCalls([{ name: 'edit_file', args: { path: 'AGENT.md' } }]);

    const turn = recorded(l);
    assert.equal(turn.success, true);
    assert.match(turn.result, /APPROVED/);
    rmSync(dir, { recursive: true, force: true });
  });

  test('the decision reaches the screen as well as the record', async () => {
    const { l, sent, dir } = driven('reject');
    await l._executeToolCalls([{ name: 'edit_file', args: { path: 'AGENT.md' } }]);

    const last = sent.filter((m) => m.type === 'tool_result').pop();
    assert.ok(last, 'nothing was sent to the front-ends');
    assert.equal(last.payload.success, false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('and the row says what happened', () => {
  /*
   * The old summary was the whole sentence the *model* was sent: "User REJECTED
   * the edit to AGENT.md. Do not retry the same edit — ask what they want
   * changed." That is an instruction to the model, not a description for the
   * person who just pressed reject and knows what they did.
   */
  test('a rejection reads as one', () => {
    const out = summarizeResult('edit_file',
      'User REJECTED the edit to AGENT.md. Do not retry the same edit — ask what they want changed.');
    assert.equal(out, 'rejected — nothing written');
  });

  test('an approval reads as one', () => {
    assert.equal(
      summarizeResult('edit_file', '✅ User APPROVED the edit. AGENT.md has been written to disk.'),
      'approved — written to disk',
    );
  });

  // An edit that never reached an approval prompt still summarises as before.
  test('a pending diff is unaffected', () => {
    assert.equal(summarizeResult('edit_file', { filePath: 'a/b.js', hunkCount: 2 }), '2 hunks in b.js');
  });
});
