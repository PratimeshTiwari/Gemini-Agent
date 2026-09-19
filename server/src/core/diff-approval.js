/**
 * What happens to an edit between building the diff and it being on disk.
 *
 * `edit_file` and `create_file` do not write. They build a `DiffEngine` diff and
 * return `status: 'pending_approval'`, which is true at the moment they return
 * and stops being true a few lines later — either because nobody needed to ask,
 * or because somebody was asked and answered. Three parties have to be told the
 * same thing about that, and each of them has been the odd one out:
 *
 * - **the model**, through `toolResults[i]`, which used to keep the tool's own
 *   "pending approval" payload and report a written file as awaiting review;
 * - **the screen**, through `resultTurn`, which used to keep the *diff
 *   generated* result and draw a rejected edit in green as though it landed;
 * - **the disk**, through `acceptDiff`, which is the only one that was never
 *   wrong.
 *
 * Keeping the three together in one function is the point of it being one.
 */
import { randomUUID } from 'crypto';

/**
 * Apply or ask, then correct every record of what happened.
 *
 * @param {object} loop - the `AgentLoop`
 * @param {object} ctx
 * @param {{name: string, id?: string}} ctx.call
 * @param {object} ctx.diffResult - what `edit_file`/`create_file` returned
 * @param {boolean} ctx.needsApproval - `tool-policy`'s verdict for this call
 * @param {{level: string, reason: string}} ctx.risk
 * @param {object} ctx.resultTurn - the history entry already written for this
 *   call; **mutated** when a decision changes what it should say
 * @returns {Promise<object>} the entry to put in `toolResults`
 */
export async function resolveDiff(loop, { call, diffResult, needsApproval, risk, resultTurn }) {
  if (!needsApproval) {
    // Auto-apply safe edits
    loop.diffEngine.acceptDiff(diffResult.diffId);

    loop.callbacks.sendToPanel({
      id: randomUUID(),
      type: 'diff_auto_applied',
      payload: {
        diffId: diffResult.diffId,
        filePath: diffResult.filePath,
        message: `✓ Auto-applied: ${diffResult.filePath}`,
      },
      timestamp: Date.now(),
    });

    /*
     * Tell the model what actually happened. `create_file` and `edit_file` both
     * return `status: 'pending_approval'` because that is true at the moment
     * they build the diff — but when the edit is auto-applied (an artifact in
     * plan mode, a safe edit in auto mode) nobody ever asks, and the model
     * faithfully reported "waiting for your approval" about a file that was
     * already on disk. The user then goes looking for a prompt that does not
     * exist.
     */
    return {
      call_id: call.id || randomUUID(),
      name: call.name,
      result: {
        filePath: diffResult.filePath,
        status: 'applied',
        message: `Applied to ${diffResult.filePath}. No approval was needed — do not tell the user it is pending.`,
      },
    };
  }

  /*
   * Request approval and WAIT. Without this the loop used to hand Gemini a
   * "waiting for approval" result and immediately continue, so the model
   * replied as if the edit were already under review while the prompt was still
   * on screen — and the user's answer went to chat, not the diff.
   */
  const decision = typeof loop.callbacks?.requestDiffApproval !== 'function'
    ? { action: 'reject' } // no UI wired: never block forever
    : await new Promise((resolve) => {
      loop.pendingDiffResolve = resolve;
      loop.callbacks.requestDiffApproval({
        diffId: diffResult.diffId,
        filePath: diffResult.filePath,
        patch: diffResult.patch,
        hunks: diffResult.hunks,
        riskLevel: risk.level,
        riskReason: risk.reason,
      });
    });

  const accepted = decision.action === 'accept';
  const message = accepted
    ? `✅ User APPROVED the edit. ${diffResult.filePath} has been written to disk.`
    : `User REJECTED the edit to ${diffResult.filePath}. Do not retry the same edit — ask what they want changed.`;

  /**
   * And tell the screen, which used to be the only one left believing the edit
   * had landed.
   *
   * `resultTurn` is recorded when the diff was *generated* — which succeeds
   * whether or not anyone approves it. The decision arrives here, and only
   * `toolResults` was corrected. So a rejected edit drew
   * `✓ edit_file · 1 hunk in AGENT.md`, in green, on a change that was never
   * written: the model was told the truth and the person watching was not,
   * which is the worse half of the two.
   *
   * Mutated rather than re-pushed: the transcript is built from these objects,
   * so correcting the record corrects every later reading of it, and a second
   * row would read as a second edit.
   */
  resultTurn.success = accepted;
  resultTurn.result = message;
  loop.callbacks?.sendToPanel?.({
    id: randomUUID(),
    type: 'tool_result',
    payload: { name: call.name, result: message, success: accepted },
    timestamp: Date.now(),
  });

  // Replace the "pending approval" payload so the model is told what actually
  // happened, and is not fed the whole patch back.
  return { name: call.name, result: message, failed: !accepted };
}
