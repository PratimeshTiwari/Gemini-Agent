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

export async function runSubAgentSession(loop, role, prompt, targetModel) {
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

  for (let turn = 0; turn < 6; turn++) {
    const serializedPrompt = localHistory.map(t => {
      if (t.role === 'system') return `[System Context/Tool Results]\n${t.content}`;
      if (t.role === 'user') return `[User Task]\n${t.content}`;
      if (t.role === 'agent') return `[Your Previous Output]\n${t.content}`;
      return t.content;
    }).join('\n\n');
    const response = await loop._executeSubagent(targetModel, serializedPrompt);
    if (!response.success) return { success: false, error: response.error };

    if (response.url) {
      loop.callbacks.sendToPanel({
        id: randomUUID(),
        type: 'status',
        payload: { message: `🔗 [${role}] Subagent background tab: ${response.url}` },
        timestamp: Date.now(),
      });
    }

    const content = response.result || response.content;
    localHistory.push({ role: 'agent', content });

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
