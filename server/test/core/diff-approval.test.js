/**
 * The two halves of the approval path `diff-rejection-row.test.js` does not reach.
 *
 * That one drives the real loop through an approval prompt and answers it, so
 * the accept and reject paths are covered end to end. Neither of these is:
 *
 * - **auto-apply**, where nobody is asked at all. The tools return
 *   `status: 'pending_approval'` because that is true when they build the diff,
 *   and it stops being true the moment it is applied — the model used to be
 *   handed that payload unchanged and told the user an edit was awaiting review
 *   that was already on disk.
 * - **no UI wired**, which is the side panel and the batch runner. `await`ing a
 *   promise nothing can resolve is how the panel's `ask_question` deadlocked a
 *   turn, and an edit is the same shape.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDiff } from '../../src/core/diff-approval.js';

const DIFF = { diffId: 'd1', filePath: 'src/x.js', patch: '@@', hunks: [{}] };
const risk = { level: 'safe', reason: '' };

function loopWith(over = {}) {
  const panel = [];
  const applied = [];
  return {
    panel,
    applied,
    diffEngine: { acceptDiff: (id) => { applied.push(id); return { ok: true }; } },
    callbacks: { sendToPanel: (m) => panel.push(m) },
    ...over,
  };
}

describe('auto-applied, so nobody is asked', () => {
  test('the edit is actually written', async () => {
    const loop = loopWith();
    await resolveDiff(loop, {
      call: { name: 'edit_file' }, diffResult: DIFF, needsApproval: false, risk, resultTurn: {},
    });

    assert.deepEqual(loop.applied, ['d1'], 'the diff was never accepted, so nothing reached disk');
  });

  /*
   * The bug this replaced. The tool's own `status: 'pending_approval'` went back
   * to the model verbatim, so it told the user to go and approve something that
   * had already happened — and they went looking for a prompt that did not
   * exist.
   */
  test('the model is told applied, not pending', async () => {
    const loop = loopWith();
    const out = await resolveDiff(loop, {
      call: { name: 'create_file' }, diffResult: DIFF, needsApproval: false, risk, resultTurn: {},
    });

    assert.equal(out.result.status, 'applied');
    assert.doesNotMatch(JSON.stringify(out), /pending_approval/,
      'the model was handed a pending status for a file already on disk');
    assert.match(out.result.message, /do not tell the user it is pending/i);
  });

  test('and the screen is told too', async () => {
    const loop = loopWith();
    await resolveDiff(loop, {
      call: { name: 'edit_file' }, diffResult: DIFF, needsApproval: false, risk, resultTurn: {},
    });

    const row = loop.panel.find((m) => m.type === 'diff_auto_applied');
    assert.ok(row, 'an edit landed on disk with nothing on screen saying so');
    assert.match(row.payload.message, /src\/x\.js/);
  });

  // The control: an auto-apply asks nobody, so it must not park on a resolver.
  test('it does not wait for anything', async () => {
    const loop = loopWith();
    await resolveDiff(loop, {
      call: { name: 'edit_file' }, diffResult: DIFF, needsApproval: false, risk, resultTurn: {},
    });

    assert.equal(loop.pendingDiffResolve, undefined);
  });
});

describe('no approval UI wired', () => {
  /*
   * The side panel and the batch runner both reach here with no
   * `requestDiffApproval`. Awaiting a promise nothing can resolve is exactly
   * how the panel's `ask_question` deadlocked a turn — and there the send
   * button stayed disabled afterwards, so the session accepted no further
   * prompts at all.
   */
  test('it rejects rather than hanging forever', async () => {
    const loop = loopWith({ callbacks: { sendToPanel() {} } });
    const resultTurn = { success: true, result: 'diff generated' };

    const out = await Promise.race([
      resolveDiff(loop, { call: { name: 'edit_file' }, diffResult: DIFF, needsApproval: true, risk, resultTurn }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('the turn hung')), 500)),
    ]);

    assert.equal(out.failed, true);
    assert.match(out.result, /REJECTED/);
    assert.deepEqual(loop.applied, [], 'an edit nobody approved was written anyway');
  });

  test('and the record is corrected, not left reading success', async () => {
    const loop = loopWith({ callbacks: { sendToPanel() {} } });
    const resultTurn = { success: true, result: 'diff generated' };

    await resolveDiff(loop, {
      call: { name: 'edit_file' }, diffResult: DIFF, needsApproval: true, risk, resultTurn,
    });

    assert.equal(resultTurn.success, false, 'the transcript still reads as a successful edit');
    assert.match(resultTurn.result, /REJECTED/);
  });
});
