/**
 * A batch agent turn loop: prompt in, final text out.
 *
 * Extracted from `AgentLoop.runHeadlessTask`, which was a second agent loop
 * living inside the first — ten turns, its own dispatch, its own retry, its own
 * tool list — with no seam and no tests. GITHUB-AGENT-PLAN phase 6.
 *
 * It knows nothing about GitHub, sessions, the UI, or where the model lives.
 * Everything that touches the outside is passed in, which is what makes the
 * loop testable without a browser: `send` dispatches a prompt, `executeTool`
 * runs one, `runSubagent` handles delegation. The interactive loop in
 * `agent-loop.js` stays separate on purpose — it is stateful with a person
 * waiting, where this is batch and stateless per request.
 *
 * **Two things the plan expected this to fix, which it does not, because the
 * diagnosis was wrong.** Recorded here so the next reader does not act on it.
 *
 * 1. *"The entire history re-serialised every turn"* — true, and **necessary**.
 *    Every `send` here goes through `_executeSubagent`, which sets
 *    `isSubagent: true`; the extension answers that by creating a **fresh tab**
 *    (`content.js`, the `payload.isSubagent` branch) and `main.js` closes it
 *    when the turn ends. So turn 2 is a browser tab that has never seen turn 1.
 *    There is no thread to rely on, and the re-serialisation is the only thing
 *    making a multi-turn batch task work at all. It is not opting out of
 *    `PromptBuilder`'s protection; it has nothing to opt into. Removing it needs
 *    one tab held across a task's turns — a real change to the bridge, not a
 *    refactor, and the lane work in `extension-lock.js` is its prerequisite.
 *
 * 2. *"Removes the third tool list by construction"* — it does not, and should
 *    not here. The headless tool list is a deliberate subset in a shape of its
 *    own, carrying a correction the full definitions do not ("use `pattern` NOT
 *    `query`"). Generating it would change what this agent is told, on a path
 *    that can only be verified against a real browser. Its *membership* is
 *    checked against `core/tool-catalog.js` by `tool-catalog.test.js`, which is
 *    the half that actually broke elsewhere.
 *
 * What the extraction does buy is the seam: a loop that can be driven with
 * stubs, which is what GitHub phase 7 needs and what nothing had before.
 */

import { randomUUID } from 'crypto';
import { looksLikeProviderError } from './drift-detector.js';

/** Turns before a batch task gives up and returns what it has. */
export const MAX_BATCH_TURNS = 10;

/** Consecutive provider errors before the task is abandoned. */
export const MAX_BATCH_PROVIDER_RETRIES = 3;

/**
 * Run a batch task to completion.
 *
 * @param {object} options
 * @param {string} options.system - the system prompt for this task
 * @param {string} options.user - what to do
 * @param {(prompt: string) => Promise<{success: boolean, result?: string, content?: string, error?: string}>} options.send
 * @param {(content: string) => {toolCalls: Array, cleanContent: string}} options.extractToolCalls
 * @param {(name: string, args: object) => Promise<any>} options.executeTool
 * @param {(prompt: string) => Promise<any>} [options.runSubagent] - handles `ask_subagent`
 * @param {(name: string, args: object) => {level: string, reason: string}} [options.classifyRisk]
 * @param {number} [options.maxTurns]
 * @param {number} [options.maxProviderRetries]
 * @returns {Promise<{success: boolean, result?: string, error?: string, turns: number}>}
 */
export async function runBatchTask({
  system,
  user,
  send,
  extractToolCalls,
  executeTool,
  runSubagent = null,
  classifyRisk = null,
  maxTurns = MAX_BATCH_TURNS,
  maxProviderRetries = MAX_BATCH_PROVIDER_RETRIES,
}) {
  const history = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];

  let providerRetries = 0;
  let lastCleanContent = '';
  let turns = 0;

  for (let turn = 0; turn < maxTurns; turn += 1) {
    turns = turn + 1;

    // Flat, and it has to be — see the note at the top of this file. Each send
    // reaches a tab that has never seen the previous turn.
    const prompt = `${history.map((t) => `${t.role.toUpperCase()}:\n${t.content}`).join('\n\n')}\n\nAGENT:\n`;

    const response = await send(prompt);
    if (!response?.success) {
      return { success: false, error: response?.error || 'no response', turns };
    }

    const content = response.result || response.content || '';
    history.push({ role: 'agent', content });

    let toolCalls = [];
    let cleanContent = content;
    try {
      ({ toolCalls, cleanContent } = extractToolCalls(content));
    } catch (err) {
      history.push({
        role: 'system',
        content: `JSON Parse Error: ${err.message}. Fix your tool call format.`,
      });
      continue;
    }

    /**
     * Gemini's own failure message arrives through the same path as a real
     * reply — no tool calls and some prose, structurally identical to a
     * finished answer. Left alone it became the final output and was written to
     * disk as the PR plan.
     */
    if (toolCalls.length === 0 && looksLikeProviderError(cleanContent)) {
      providerRetries += 1;
      if (providerRetries <= maxProviderRetries) {
        history.push({
          role: 'system',
          content: '[System: the previous response was a provider error, not an answer. Retrying the same request.]',
        });
        continue;
      }
      return { success: false, error: `Gemini kept returning an error: ${cleanContent.trim()}`, turns };
    }

    if (cleanContent.trim()) lastCleanContent = cleanContent.trim();

    // No tool calls means the model is done talking: this turn is the answer.
    if (toolCalls.length === 0) break;

    const results = await Promise.all(toolCalls.map(async (call) => {
      let result;
      if (call.name === 'ask_subagent' && runSubagent) {
        result = await runSubagent(call.args?.prompt);
      } else {
        // A batch turn has nobody to approve anything, so anything the risk
        // classifier does not call safe is refused rather than queued for an
        // approval that will never come.
        const risk = classifyRisk ? classifyRisk(call.name, call.args) : null;
        if (call.name === 'run_command' && risk && risk.level !== 'safe') {
          result = { success: false, error: `Command blocked in background agent for security: ${risk.reason}` };
        } else {
          try {
            result = await executeTool(call.name, call.args);
          } catch (e) {
            result = { success: false, error: e.message };
          }
        }
      }
      return { call_id: call.id || randomUUID(), name: call.name, result };
    }));

    history.push({ role: 'tool', content: JSON.stringify(results, null, 2) });
  }

  return {
    success: true,
    result: lastCleanContent || '(No plan generated)',
    turns,
  };
}
