/**
 * A batch agent turn loop: prompt in, final text out.
 *
 * Extracted from `AgentLoop.runHeadlessTask`, which was a second agent loop
 * living inside the first — ten turns, its own dispatch, its own retry, its own
 * tool list — with no seam and no tests.
 *
 * It knows nothing about GitHub, sessions, the UI, or where the model lives.
 * Everything that touches the outside is passed in, which is what makes the
 * loop testable without a browser: `send` dispatches a prompt, `executeTool`
 * runs one, `runSubagent` handles delegation. The interactive loop in
 * `agent-loop.js` stays separate on purpose — it is stateful with a person
 * waiting, where this is batch and stateless per request.
 *
 * **The history used to be re-serialised on every turn, and it had to be.**
 * Every `send` goes through `_executeSubagent`, which sets `isSubagent: true`,
 * and the extension answered that by creating a **fresh tab** and closing it
 * when the turn ended — so turn 2 was a browser tab that had never seen turn 1.
 * There was no thread to rely on. The GitHub plan called that opting out
 * of `PromptBuilder`'s protection; it was not, there was nothing to opt into.
 *
 * Measured on a ten-turn task with realistic tool results: **156,140 characters
 * typed into browser tabs where 28,943 were new — 81% resent**, growing every
 * turn, so turn 10 was a 29 KB prompt. That is precisely the shape `CLAUDE.md`
 * says trips Gemini's repetition filters.
 *
 * So the tab is held for the life of the task now (`sessionId`), and each turn
 * after the first sends only what is new. If the tab is gone the extension
 * **refuses** the turn rather than opening a fresh one — an incremental prompt
 * in an empty conversation gets a confident answer to a question the model
 * never saw — and this loop answers that by resending the full history once.
 *
 * **A caller without a session still gets the old behaviour.** `send` is told
 * whether it is `continuing`, and a transport that cannot keep a thread simply
 * never reports one, so every turn is flat and correct.
 *
 * *One thing the plan expected that is still not done:* generating the tool
 * list "by construction". The headless list is a deliberate subset in a shape
 * of its own, carrying a correction the full definitions do not ("use `pattern`
 * NOT `query`"). Generating it would change what this agent is told, on a path
 * only a real browser can verify. Its *membership* is checked against
 * `core/tool-catalog.js` instead, which is the half that actually broke.
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
 * @param {() => void} [options.endSession] - release the tab this task was holding
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
  endSession = null,
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
  /** How much of `history` the tab has already been told. */
  let sent = 0;

  const serialise = (entries) =>
    `${entries.map((t) => `${t.role.toUpperCase()}:\n${t.content}`).join('\n\n')}\n\nAGENT:\n`;

  for (let turn = 0; turn < maxTurns; turn += 1) {
    turns = turn + 1;

    // Only what the tab has not seen. On turn 1, or after a lost session, that
    // is everything; after that it is the tool results and nothing else.
    const continuing = sent > 0;
    const prompt = serialise(continuing ? history.slice(sent) : history);

    let response = await send(prompt, { continuing });

    /**
     * The tab holding this task was closed mid-run.
     *
     * The extension refuses the turn rather than opening a fresh one, because
     * an incremental prompt in an empty conversation produces a confident
     * answer to a question the model never saw. Recover by saying it all again,
     * once — if the second attempt also loses its tab, something is closing
     * tabs faster than we can use them and retrying forever helps nobody.
     */
    if (continuing && response?.sessionLost) {
      sent = 0;
      response = await send(serialise(history), { continuing: false });
    }

    if (!response?.success) {
      return { success: false, error: response?.error || 'no response', turns };
    }
    // Everything up to here is now in the tab's own thread. What follows — the
    // model's reply and the tool results — is what the next turn has to send.
    sent = history.length;

    const content = response.result || response.content || '';
    // The model's own reply is already in the thread; keeping it in `history`
    // is for the *fallback* re-send, not for the next incremental prompt.
    history.push({ role: 'agent', content });
    sent = history.length;

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
