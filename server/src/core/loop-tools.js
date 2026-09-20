/**
 * The three tools the loop answers itself.
 *
 * `core/tool-catalog.js` has said `dispatch: 'loop'` about these since it was
 * written — they are not MCP handlers, because each needs something only the
 * loop has: `ask_question` parks the turn on a promise a front-end resolves,
 * `ask_subagent` opens a second browser tab, `manage_memory` writes to the
 * manager whose facts ride in the next system prompt.
 *
 * What the catalog knew and the code did not was that this is a **set**. The
 * dispatch chain named the three literally and an `else` swept everything else
 * to `mcpServer.executeTool`, so a fourth loop tool added to the catalog would
 * have gone to a server with no handler for it and come back to the model as an
 * unknown tool it had just been told it has. That is the `run_background` shape
 * exactly. `LOOP_TOOLS` is derived from the catalog and `loop-tools.test.js`
 * asserts the dispatcher covers it, so the next one is a red test rather than a
 * confused turn.
 */
import { randomUUID } from 'crypto';
import { normalizeQuestionSet } from './question.js';
import { TOOL_CATALOG } from './tool-catalog.js';

/** Tools dispatched here rather than by the MCP server. */
export const LOOP_TOOLS = new Set(
  TOOL_CATALOG.filter((t) => t.dispatch === 'loop').map((t) => t.name),
);

/**
 * Run one of them.
 *
 * @param {object} loop - the `AgentLoop`; these need its callbacks and state
 * @param {{name: string, args: object}} call
 * @returns {Promise<object>} a result in the shape `_executeToolCalls` expects
 */
export async function dispatchLoopTool(loop, call) {
  switch (call?.name) {
    case 'ask_question': return askQuestion(loop, call);
    case 'ask_subagent': return askSubagent(loop, call);
    case 'manage_memory': return manageMemory(loop, call);
    default:
      /*
       * Unreachable from `_executeToolCalls`, which checks `LOOP_TOOLS` first.
       * Reached only by a catalog entry declared `dispatch: 'loop'` with no arm
       * here — which the test catches. It must not return `undefined`: the
       * caller reads `result.success` and `result.result` off it immediately.
       */
      return { error: `${call?.name} is declared as a loop tool and has no implementation.` };
  }
}

/**
 * Ask the user a question and park the turn until they answer.
 *
 * Nothing resolves this but a front-end, so the promise is the turn: if a
 * surface renders the payload as an unanswerable picker, the turn hangs.
 */
function askQuestion(loop, call) {
  return new Promise((resolve) => {
    loop.pendingQuestionResolve = resolve;
    /**
     * Normalised here, once, rather than by each front-end.
     *
     * These args are parsed out of model prose, so nothing in them is
     * guaranteed: options arrive as strings, as `{label, description}`, as a
     * single string instead of an array, or not at all. The terminal has
     * cleaned that up on arrival since `question.js` was written — the side
     * panel could not, because it cannot import server code, so it would have
     * needed its own copy of the rules and they would have drifted.
     *
     * It matters more than tidiness: the loop is parked on
     * `pendingQuestionResolve` until something is chosen, so a surface that
     * renders a malformed payload as an unanswerable picker hangs the turn
     * outright.
     *
     * `normalizeQuestionSet` is idempotent, so the terminal running it again
     * on receipt costs nothing and needed no change.
     */
    const questions = normalizeQuestionSet({
      question: call.args.question,
      options: call.args.options,
      header: call.args.header,
      questions: call.args.questions,
    });
    loop.callbacks.sendToPanel({
      id: randomUUID(),
      type: 'ask_question',
      // The single-question fields ride along too: the terminal reads
      // `questions` and anything older reads the flat shape.
      payload: {
        question: questions[0].question,
        options: questions[0].options,
        header: questions[0].header,
        questions,
      },
      timestamp: Date.now(),
    });
  });
}

/** Hand the work to a second Gemini tab, or hand it back labelled. */
async function askSubagent(loop, call) {
  const role = String(call.args.role || 'task').toLowerCase();
  const task = call.args.prompt || call.args.query || '';
  const result = await loop._runSubAgentSession(role, task, loop.mainModel);
  if (result.success) return result;

  /**
   * A subagent that could not run hands the work back, labelled.
   *
   * Returning a bare error loses the task: the model is told "that call
   * failed, fix it yourself", which it reads as being about the call rather
   * than about the work the call was carrying.
   *
   * **The label is the whole difficulty.** If a failed `review` quietly
   * becomes the author reviewing their own diff, the one thing a reviewer was
   * for — not sharing the assumptions that produced the code — is gone, and
   * nothing on screen says so. So the fallback names what it is and requires
   * the answer to name it too. Same rule as `unstructured` and "unsupported,
   * never false": degrade, and say you degraded.
   */
  const cold = role === 'review'
    ? ' Because you are reviewing your own work, you share every assumption that '
      + 'produced it — re-read the files rather than trusting your memory of them, '
      + 'and **say in your answer that this review is your own**.'
    : '';
  return {
    success: true,
    fellBack: true,
    result: `The ${role} subagent could not run (${result.error}). Do it here instead, `
      + `in this conversation.${cold}\n\n--- the task ---\n${task}`,
  };
}

/**
 * Add or forget one fact.
 *
 * Both paths call `resetPromptState()` afterwards and the invalid one does not:
 * the facts ride inside `<memory>` in the system prompt, so a changed set is
 * only visible to the model once that prompt is rebuilt. Doing it on a rejected
 * action would spend a full turn-0 payload to change nothing.
 */
function manageMemory(loop, call) {
  if (call.args.action === 'add') {
    let result;
    if (!loop.memoryManager.isMemoryEnabled()) {
      // Said plainly, because "failed" made the model retry the same call.
      // Memory being off is a decision, not a transient error.
      result = { result: 'Memory is turned off for this workspace (`/memory on` re-enables it). Nothing was stored.' };
    } else {
      const added = loop.memoryManager.addMemory(call.args.fact);
      result = { result: added ? `Remembered: ${call.args.fact}` : 'Already remembered — nothing to do.' };
    }
    loop.promptBuilder?.resetPromptState?.();
    return result;
  }

  if (call.args.action === 'remove') {
    const which = call.args.index ?? call.args.position;
    const removed = loop.memoryManager.removeMemory(which);
    const result = removed
      ? { result: `Forgot #${which}.` }
      : { error: `No memory at #${which}. The numbers are the ones in <memory>; re-read them before removing.` };
    loop.promptBuilder?.resetPromptState?.();
    return result;
  }

  return { error: 'Invalid action. Use "add" or "remove".' };
}
