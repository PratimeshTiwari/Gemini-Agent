/**
 * One subagent turn: a second tab of this model, with an empty context.
 *
 * Lifted out of `agent-loop.js` verbatim, as a function taking the loop — the
 * shape `slash-commands.js` already uses, so the dependency reads in the
 * signature rather than as eight implicit `this.` references.
 *
 * Two things about it are load-bearing and easy to undo by accident:
 *
 * **The role picks the wrapper, and that has to keep being true.**
 * `buildSubagentWrapper(role)` once took the role and ignored it, so
 * `ask_reviewer`, `ask_researcher` and `ask_subagent` were the same tool three
 * times and the cold adversarial read `deep` promised was never asked for
 * anywhere.
 *
 * **A missing `return_result` is not a missing answer.** A reviewer that ends
 * in prose still produced a review; discarding it on a protocol technicality
 * loses the one step whose purpose is catching what the author's own
 * assumptions hide. It falls back to the prose and marks it `unstructured`.
 * Only a genuinely empty run fails, because reporting success there would hand
 * the caller an empty review to reason from.
 */
import { randomUUID } from 'crypto';
import { logError } from './error-log.js';
import { pickModelFor, browserModelPin } from './model-match.js';

/**
 * One subagent task, in **one** tab held for the whole of it.
 *
 * It used to be one tab per *round*: every pass re-serialised the entire
 * accumulated history and handed it to `_executeSubagent` with no session, so
 * the extension opened a fresh tab, typed everything again, and closed it. Six
 * rounds meant six tabs and six copies of a history that only grew — the same
 * waste `CLAUDE.md` measured for batch tasks at **81% of characters resent
 * over ten turns**, and the reason a subagent has never been cheaper than
 * doing the work inline.
 *
 * `turn-runner.js` already solved this for batch tasks and this file did not
 * follow, because it predates it. The mechanics below are lifted from there
 * deliberately rather than reinvented: a `sessionId` the extension keys a tab
 * on, an incremental prompt of only what the tab has not seen, and a
 * `sessionLost` fallback that says it all again once.
 *
 * The session is ended in a `finally`, because every exit from the loop below
 * is a `return` — `return_result`, the prose fallback, the empty failure — and
 * a session that is never ended leaves a tab open for the life of the browser.
 */
export async function runSubAgentSession(loop, role, prompt, targetModel, effort = null) {
  const session = randomUUID();

  /*
   * A rung, resolved against the picker the browser is really offering.
   *
   * The caller asks for `lite` / `flash` / `pro`, never a model name: the names
   * move (`3.1 Pro` becomes `3.2 Pro`) and the list differs by subscription,
   * which is the whole thesis of `model-match.js`. `pickModelFor` turns the
   * rung into a label that exists *right now*, honouring a `browserModels` pin
   * when one is set.
   *
   * Null when the picker has not been read yet — and null means "leave the tab
   * on whatever it opens with", which is exactly the behaviour before this
   * existed. A routing feature whose failure mode is stranding a subagent on no
   * model at all would be worse than not routing.
   */
  const pick = effort
    ? pickModelFor(effort, loop.modelOptions || [], browserModelPin(loop.modelConfig, effort))
    : null;
  const model = pick?.model?.label || null;

  try {
    return await runSession(loop, role, prompt, targetModel, session, model);
  } finally {
    // Best effort, like every other teardown here: a tab that outlives its
    // task is untidy, and failing the task over the tidy-up would be worse.
    try { loop._sendEndSession?.(session); } catch { /* not worth a turn */ }
  }
}

async function runSession(loop, role, prompt, targetModel, session, model) {
  const wrapper = loop.promptBuilder.buildSubagentWrapper(role);
  const baseSystem = `${wrapper}\nYou also have access to read-only tools to explore the codebase if needed.
Workspace root path: ${loop.workspace}

## TOOLS AVAILABLE:
- grep_search({ "pattern": "string", "isRegex": false, "includes": ["*.js"] })
- read_file({ "path": "path/to/file", "startLine": 1, "endLine": 50 })
- list_directory({ "path": "." })
- search_files({ "query": "filename" })
- return_result({ "result": "your final markdown output" })

## TOOL CALL FORMAT (exact format required):
\`\`\`json
{"name": "tool_name", "args": {"key": "value"}}
\`\`\`
RULES: Make up to 5 tool calls before calling return_result with your final answer.`;

  const localHistory = [
    { role: 'system', content: baseSystem },
    { role: 'user', content: prompt }
  ];

  let lastCleanContent = '';
  // How much of `localHistory` the tab's own thread already holds.
  let sent = 0;

  const serialise = (entries) => entries.map(t => {
    if (t.role === 'system') return `[System Context/Tool Results]\n${t.content}`;
    if (t.role === 'user') return `[User Task]\n${t.content}`;
    if (t.role === 'agent') return `[Your Previous Output]\n${t.content}`;
    return t.content;
  }).join('\n\n');

  for (let turn = 0; turn < 6; turn++) {
    // Only what the tab has not seen. On the first pass, or after a lost
    // session, that is everything; after that it is the tool results alone.
    const continuing = sent > 0;
    let response = await loop._executeSubagent(
      targetModel,
      serialise(continuing ? localHistory.slice(sent) : localHistory),
      { session, continuing, model },
    );

    /*
     * The tab was closed under us mid-task.
     *
     * The extension refuses an incremental prompt rather than opening a fresh
     * tab for it, because a continuation typed into an empty conversation gets
     * a confident answer to a question the model never saw. Say it all again,
     * once — if the second attempt loses its tab too, something is closing
     * tabs faster than we can use them and retrying forever helps nobody.
     */
    if (continuing && response?.sessionLost) {
      sent = 0;
      response = await loop._executeSubagent(
        targetModel, serialise(localHistory), { session, continuing: false, model },
      );
    }

    if (!response.success) return { success: false, error: response.error };
    // Everything to here is in the tab's thread now. What follows — the reply
    // and the tool results — is what the next pass has to send.
    sent = localHistory.length;

    if (response.url) {
      loop.callbacks.sendToPanel({
        id: randomUUID(),
        type: 'status',
        payload: { message: `🔗 [${role}] Subagent background tab: ${response.url}` },
        timestamp: Date.now(),
      });
    }

    const content = response.result || response.content;
    // The reply is already in the tab's thread — the model wrote it there. It
    // stays in `localHistory` only for the `sessionLost` re-send, so `sent`
    // moves past it and the next incremental prompt is the tool results alone.
    // `turn-runner.js` sets `sent` twice for exactly this reason; the first
    // port of this loop set it once and typed the model's own words back at it.
    localHistory.push({ role: 'agent', content });
    sent = localHistory.length;

    let toolCalls = [];
    let cleanContent = content;
    try {
      const extracted = loop._extractToolCalls(content);
      toolCalls = extracted.toolCalls;
      cleanContent = extracted.cleanContent;
    } catch (err) {
      localHistory.push({ role: 'system', content: `JSON Parse Error: ${err.message}` });
      continue;
    }

    if (cleanContent.trim()) lastCleanContent = cleanContent.trim();

    // No tool call means the subagent stopped talking. Either it called
    // `return_result` below on an earlier pass, or it answered in prose —
    // which is what the fall-through after this loop is for.
    if (toolCalls.length === 0) break;

    const toolResults = [];
    let returned = false;
    for (const call of toolCalls) {
      if (call.name === 'return_result') {
        return { success: true, result: call.args.result };
      }
      
      let result;
      if (!['grep_search', 'read_file', 'list_directory', 'search_files'].includes(call.name)) {
        result = { success: false, error: `Tool ${call.name} not permitted for subagents.` };
      } else {
        result = await loop.mcpServer.executeTool(call.name, call.args, {
          editor: loop.editor, taskManager: loop.taskManager,
        });
      }
      toolResults.push({ name: call.name, result: result.result || result.error });
    }
    localHistory.push({ role: 'system', content: `Tool Results:\n${JSON.stringify(toolResults, null, 2)}` });
  }
  
  /**
   * A missing `return_result` is not a missing answer.
   *
   * Observed on `deep` + `duo`: `ask_reviewer` produced a full, well-formed
   * adversarial review, ended it in prose rather than a tool call, and the
   * turn reported `✗ ask_reviewer · Subagent failed to use the return_result
   * tool` — discarding the review on a protocol technicality with the answer
   * sitting in the payload. That is the one step whose whole purpose is
   * catching what the author's own assumptions hide, and a long adversarial
   * review is exactly the shape that drifts out of format.
   *
   * So: fail open, the same trade as `looksLikeCapabilityDenial`. Losing the
   * answer is the expensive failure; using it unstructured is the cheap one.
   * `unstructured` rides on the result so the caller can say so and
   * `/logs agent` can answer how often the format is being missed — a silent
   * fallback would just move the invisibility somewhere else.
   *
   * Only a genuinely empty run still fails. There is nothing to fall back to
   * there, and calling it a success would hand the caller an empty review to
   * reason from.
   */
  if (lastCleanContent) {
    logError(loop.workspace, {
      flow: 'agent',
      op: 'subagent_unstructured',
      message: `${role} answered in prose instead of calling return_result`,
      detail: lastCleanContent.slice(0, 500),
    });
    return { success: true, result: lastCleanContent, unstructured: true };
  }

  return { success: false, error: `The ${role} subagent returned no output at all.` };
}
