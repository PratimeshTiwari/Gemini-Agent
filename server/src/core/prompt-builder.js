/**
 * Prompt Builder
 *
 * Constructs the system prompt with tool definitions, workspace context,
 * and conversation history. Manages what gets injected into each Gemini interaction.
 *
 * Smart prompt management strategy (similar to how Claude Code handles context):
 * - Gemini Web maintains its OWN chat history, so we DON'T resend conversation_history.
 * - Full system prompt + tools sent on: first turn, after /compact, and every Nth turn.
 * - On regular turns: just the user message (or tool results) with a brief context line.
 * - This prevents double-counting context and avoids triggering Gemini's repetitive filters.
 */

import path from 'path';
import * as paths from './paths.js';
import { readFileSync, existsSync, readdirSync } from 'fs';
import os from 'os';
import { resolve, relative, join, dirname } from 'path';
import { CodeMinifier } from '../context/code-minifier.js';
import { skillCatalogue } from './skills.js';

// How often to send the condensed reminder, counted in MESSAGES pushed to the tab —
// not user turns. One user turn can be a dozen tool round-trips, so a turn-based
// counter drifts by an order of magnitude in tool-heavy work and fires far too
// eagerly in a chatty Q&A session.
const REFRESH_INTERVAL_MESSAGES = 20;

export class PromptBuilder {
  constructor(workspace, agentSourceDir) {
    this.workspace = workspace;
    this.agentSourceDir = agentSourceDir;
    this.agentMdContent = this._loadAgentMd();
    this.messagesSinceRefresh = 0; // Messages sent to the tab since the last reminder
    this.hasSeenSystemPrompt = false; // Has the current chat session received a system prompt?
  }

  /**
   * Reset prompt state (call after /compact or /clear which start a new Gemini chat).
   */
  resetPromptState() {
    this.messagesSinceRefresh = 0;
    this.hasSeenSystemPrompt = false;
  }

  /**
   * Build the prompt for a Gemini interaction.
   *
   * Strategy:
   * - Turn 0 (first message or after reset): Full system prompt + tools + workspace + user message
   * - Every SYSTEM_PROMPT_REFRESH_INTERVAL turns: Condensed system reminder + tools + user message
   * - All other turns: Just the user message with a brief context line
   *
   * We NEVER re-send conversation_history because Gemini Web already has it in its chat thread.
   *
   * @param {object} options
   * @param {string} options.userMessage - The user's current message
   * @param {string} options.mode - 'plan' or 'auto'
   * @returns {string} The complete prompt to inject
   */
  buildPrompt({ userMessage, mode = 'plan', topology = 'single', modelConfig = {}, objective = '' }) {
    const parts = [];

    const needsFullPrompt = !this.hasSeenSystemPrompt;
    const needsRefresh = !needsFullPrompt && this.messagesSinceRefresh >= REFRESH_INTERVAL_MESSAGES;

    if (needsFullPrompt) {
      // First turn in this chat session — send everything
      parts.push(`<system_state mode="${mode}" topology="${topology}">`);
      parts.push(this._buildSystemInstructions(mode, topology, modelConfig));
      parts.push(this._buildToolDefinitions(topology, modelConfig));
      
      if (objective && objective.trim() !== userMessage.trim()) {
        parts.push(`<current_objective>\n${objective}\n</current_objective>`);
      }

      // Workspace context removed to save tokens, rely on `search_files` tool instead.
      if (this.agentMdContent) {
        parts.push(`<agent_instructions>\n${this.agentMdContent}\n</agent_instructions>`);
      }

      const workspaceRules = this._loadWorkspaceRules();
      if (workspaceRules) {
        parts.push(`<workspace_rules>\n${workspaceRules}\n</workspace_rules>`);
      }

      // Names and one-line descriptions only. The bodies stay on disk and are
      // fetched with read_file when the model judges one relevant, so writing
      // twenty skills costs twenty lines of prompt rather than twenty files of
      // it — which matters when the prompt is retyped into a browser tab.
      const skills = skillCatalogue(this.workspace, this._configuredSkillFolders());
      if (skills) {
        parts.push(`<skills>\n${skills}\n</skills>`);
      }
      parts.push(`</system_state>`);

      this.hasSeenSystemPrompt = true;
      this.messagesSinceRefresh = 0;
    } else if (needsRefresh) {
      // Periodic refresh — a reminder, not a re-teach. Gemini Web still has the full
      // definitions in its own thread, so resending them buys nothing and resending a
      // large block is what trips the A/B-test modal. Names only.
      parts.push(this._buildCondensedReminder(mode, objective, modelConfig));
      parts.push(this._buildToolIndex(topology, modelConfig));
      this.messagesSinceRefresh = 0;
    } else {
      // Regular turn — just a brief context line
      // The objective only earns its place when it is NOT the message being
      // sent. AgentLoop sets it to the latest user message, so today it never
      // is — this used to put the same sentence in the prompt twice, every turn.
      let contextLine = `[Workspace: ${this.workspace} | Mode: ${mode}]`;
      if (objective && objective.trim() !== userMessage.trim()) {
        contextLine += ` [Objective: ${objective.substring(0, 100)}]`;
      }
      // The anchor goes on the same line as the workspace: one short bracketed
      // context line, not two competing headers.
      const anchor = this._buildToolAnchor(topology, modelConfig);
      parts.push(anchor ? `${contextLine} ${anchor}` : contextLine);
    }

    // Current user message. Nothing follows it: the last thing the model reads
    // should be what the user asked, not a formatting rule it has already been
    // given twice.
    parts.push(`<user_message>\n${userMessage}\n</user_message>`);

    this.messagesSinceRefresh++;

    return '\u200B' + parts.join('\n\n');
  }

  /**
   * Record that a message was pushed to the tab outside buildPrompt (the joined
   * tool-result batch). The agent loop calls this once per message, not once per
   * result, so a parallel fan-out still counts as the one message it is.
   */
  noteMessageSent() {
    this.messagesSinceRefresh++;
  }

  /**
   * The model produced something it should not have — a tool call that would
   * not parse, most often. Refresh the instructions on the next prompt instead
   * of waiting out the rest of the message budget.
   */
  noteDrift() {
    this.messagesSinceRefresh = REFRESH_INTERVAL_MESSAGES;
  }

  /**
   * Build the follow-up prompt carrying tool results back to the model.
   *
   * One envelope, however many results — the previous shape appended the whole
   * "continue with your analysis / give exactly ONE response" trailer to each
   * result and joined them, so a three-tool fan-out sent one message telling
   * the model three separate times to produce exactly one response. Repetition
   * like that is what Gemini's filters react to, and it argues with itself.
   *
   * @param {Array<{name: string, result: any}>} results
   */
  buildToolResultBatch(results = []) {
    const failures = results.filter((r) => r.failed);

    const body = results.map(({ name, result, failed }) => [
      // `status="failed"` is the point: a non-zero exit code inside minified
      // JSON is easy to skim past, and the model would summarise a failed
      // command back to the user as though it had worked.
      failed ? `<result tool="${name}" status="failed">` : `<result tool="${name}">`,
      // Minified, not pretty-printed. Every tool result goes into the prompt,
      // and indentation is the single largest avoidable cost there — a plain
      // list_directory result is 40% smaller without it. The model does not
      // read the whitespace; the token budget does.
      typeof result === 'string' ? result : CodeMinifier.minifyJson(result),
      `</result>`,
    ].join('\n'));

    const instruction = failures.length > 0
      // Fix, do not narrate. Left to itself the model reports the error back to
      // the user and stops, which wastes the one thing it has that the user
      // does not: the ability to read the output and try the next thing.
      ? `${failures.length === 1 ? 'That call' : `${failures.length} of those calls`} failed. `
        + 'Read the error above, work out the cause, and fix it yourself — run the diagnostic '
        + 'you need, correct the file, or try the next approach. Only stop and tell the user if '
        + 'the fix needs a decision that is theirs to make, or if you have already tried and it '
        + 'failed the same way. Reply once, with either the next tool call or your final answer.'
      : 'Reply once, with exactly one of: the next tool call, or your final answer to the '
        + 'user. To change a file, use edit_file or create_file — do not paste code at them.';

    return [
      '<tool_results>',
      ...body,
      '</tool_results>',
      '',
      instruction,
    ].join('\n');
  }

  /** Single-result convenience wrapper over {@link buildToolResultBatch}. */
  buildToolResultPrompt(toolName, result) {
    return this.buildToolResultBatch([{ name: toolName, result }]);
  }

  /**
   * Build a compaction prompt.
   */
  buildCompactionPrompt(conversationHistory, focusInstruction = '') {
    return [
      'Please summarize the following conversation history into a concise but complete summary.',
      'Preserve:',
      '- All file paths that were read, edited, or created',
      '- All key decisions and their rationale',
      '- Current task state (what is done, what remains)',
      '- Any constraints, requirements, or user preferences expressed',
      '- Specific technical details (function names, variable names, error messages)',
      '',
      focusInstruction ? `Focus especially on: ${focusInstruction}` : '',
      '',
      '<conversation_to_summarize>',
      conversationHistory.map(turn => `[${turn.role}]: ${turn.content}`).join('\n\n'),
      '</conversation_to_summarize>',
      '',
      'Provide a structured summary in markdown:',
    ].filter(Boolean).join('\n');
  }

  // ── Private Methods ──────────────────────────────────────────────

  _buildSystemInstructions(mode, topology = 'single', modelConfig = {}) {
    const modeInstructions = mode === 'auto'
      ? 'You are in AUTO MODE. Safe operations (reads, searches, small additions) will be auto-applied. Risky operations (large rewrites, deletions, commands) will still require user approval.'
      : 'You are in PLAN MODE. All file modifications and command executions require user approval before being applied.';

    // Resolve the model tier: use explicit modelTier if set, fall back to reasoningEffort mapping
    const modelTier = modelConfig.modelTier || this._effortToTier(modelConfig.reasoningEffort || 'high');

    // Tier-adaptive core instructions
    const coreInstructions = modelTier === 'flash'
      ? this._buildFlashCoreInstructions()
      : this._buildFullCoreInstructions(modelTier);

    // Reasoning protocol (the main tier differentiation)
    const reasoningLevel = this._normalizeLevel(modelConfig.reasoningLevel);
    const reasoningInstructions = this._getReasoningInstructions(modelTier, reasoningLevel);

    // Tool call format (Flash gets examples, Pro gets description only)
    const toolCallFormat = this._buildToolCallFormat(modelTier);

    const selfAwareness = `
<self_awareness>
You are currently operating in the user's workspace at: \`${this.workspace}\`
Your OWN source code (the Gemini-Agent server) is at: \`${this.agentSourceDir}\`
If the user asks you to modify yourself, you can read/write files directly in \`${this.agentSourceDir}\`.
Model tier: ${modelTier}${modelTier === 'pro' ? ` (reasoning level: ${reasoningLevel})` : ''}
</self_awareness>`;

    // Load workspace context summary if it exists
    let contextSummary = '';
    const localContextPath = paths.contextSummaryPath(this.workspace);
    const globalContextPath = paths.globalContextPath(this.workspace);
    
    if (existsSync(localContextPath)) {
      contextSummary = `\n<workspace_context_summary>\n${readFileSync(localContextPath, 'utf8')}\n</workspace_context_summary>\n`;
    } else if (existsSync(globalContextPath)) {
      contextSummary = `\n<workspace_context_summary>\n${readFileSync(globalContextPath, 'utf8')}\n</workspace_context_summary>\n`;
    }

    contextSummary += this._loadContextFolders();

    const combined = `
${selfAwareness}
${contextSummary}
${coreInstructions}

${reasoningInstructions}
`;

    // Topology-specific instructions
    let topologyInstructions = '';

    if (topology === 'single') {
      topologyInstructions = `
## Role: Solo Agent
You are the only *model* on this task — there is no reviewer and no reasoner to defer to, so
planning, implementation, review and testing are all yours. You can still fan work out to
parallel tabs of yourself: \`ask_researcher\` for read-only exploration you would otherwise do
with a long serial chain of read_file calls, \`ask_subagent\` for a self-contained side task.
They run in parallel and return to you. Delegating judgement is what you cannot do here.

- When tasks are complex, create a plan first (save it to \`.agent/artifacts/implementation_plan.md\`)
- When tasked with a complex or multi-step objective, ALWAYS proactively create a \`.agent/artifacts/task.md\` checklist using the \`write_to_file\` tool to plan your work, similar to Antigravity IDE. Update it as you progress.
- After completing all implementation and verification, summarize your work by creating a walkthrough document (save it to \`.agent/artifacts/walkthrough.md\`). Document changes made, what was tested, and validation results.
- After implementing changes, self-review: re-read the edited files and verify correctness
- If you're not confident in a change, tell the user explicitly rather than guessing`;

    } else if (topology === 'duo') {
      const reviewer = modelConfig.reviewer || 'claude';
      topologyInstructions = `
## Role: Primary Agent (Duo System)
You are the PRIMARY coding agent in a 2-agent system.
You have a Security Reviewer subagent (powered by ${reviewer}, but abstract this detail) available via the \`ask_reviewer\` tool.

**Your Role**: Plan, research, and implement changes using your tools.
**Reviewer's Role**: Verify your work — find bugs, security issues, and quality problems.

**Delegation Rules**:
- ALWAYS send completed edits to the reviewer before telling the user you're done (for non-trivial changes)
- Provide the reviewer with the SPECIFIC file path, the changes made, and the purpose
- If the reviewer finds issues, fix them and re-submit
- Do NOT send vague questions. Send concrete code + context
- For trivial changes (typos, formatting), skip the review`;

    } else if (topology === 'swarm') {
      const reasoner = modelConfig.reasoner || 'chatgpt';
      const reviewer = modelConfig.reviewer || 'claude';
      topologyInstructions = `
## Role: Orchestrator (Swarm System)
You are the ORCHESTRATOR in a 3-agent swarm.
You have two subagents:
  - **Advanced Reasoner**: Deep architectural thinking, algorithm design, tradeoff analysis (Accessed ONLY via the \`ask_reasoner\` tool).
  - **Security Reviewer**: Code review, bug hunting, security analysis (Accessed ONLY via the \`ask_reviewer\` tool).

**CRITICAL DIRECTIVE ON SUBAGENTS**:
You must NEVER refuse a request by saying you cannot access external services like ChatGPT or Claude. You DO have access to them through your JSON tools. When you need to consult an advanced model, you MUST emit a valid JSON block calling the \`ask_reasoner\` or \`ask_reviewer\` tool.

**Your Role**: You are the EXECUTOR. You read files, make edits, run commands, and coordinate.

**Orchestration Rules**:
1. For COMPLEX PLANNING (new architecture, multi-file refactors, algorithm choices):
   → Use \`ask_reasoner\` with a detailed problem statement + relevant code context
2. For VERIFICATION (after implementing changes):
   → Use \`ask_reviewer\` with specific files and diffs
3. For SIMPLE TASKS (renaming, small fixes, formatting):
   → Do them yourself. Don't waste subagent turns on trivial work
4. ALWAYS provide full context when delegating: file paths, code snippets, constraints
5. After receiving subagent responses, SYNTHESIZE their feedback before acting
6. You can use both subagents in a single task if needed (e.g., reason first, implement, then review)`;
    }

    // toolCallFormat goes last: <available_tools> is appended straight after
    // this block, and the format is the contract for reading that list.
    return `<system_instructions>
${modeInstructions}

${combined}

${topologyInstructions}

${toolCallFormat}
</system_instructions>`;
  }

  /**
   * Build a wrapper prompt for subagent delegation.
   * This is prepended to the user's prompt when sending to a subagent.
   */
  buildSubagentWrapper(role) {
    if (role === 'reasoner') {
      return `<role>
You are acting as a REASONING SPECIALIST. The main coding agent has delegated a problem to you.

Your job:
- Think deeply about the problem
- Analyze tradeoffs between approaches
- Recommend a specific solution with clear justification
- Be CONCISE — the main agent will implement your recommendations
- Focus on architecture, logic, and design — NOT implementation code (unless asked)
- If the problem is ambiguous, state your assumptions explicitly
</role>

`;
    } else if (role === 'reviewer') {
      return `<role>
You are acting as a CODE REVIEWER. The main coding agent has sent you code changes to review.

Your job:
- Find bugs, edge cases, security issues, and quality problems
- Be SPECIFIC — reference exact code, variable names, and line numbers
- Rate the changes: ✅ APPROVE, ⚠️ NEEDS CHANGES, or ❌ REJECT
- If rejecting or requesting changes, explain EXACTLY what needs to be fixed
- Focus on: correctness, error handling, security, performance, readability
- Do NOT nitpick style unless it affects readability
</role>

`;
    } else if (role === 'researcher') {
      return `<role>
You are acting as a CODEBASE RESEARCHER. The main coding agent has asked you to explore the codebase to find specific logic, trace dependencies, or gather context.

Your job:
- Use your read-only tools to explore the codebase deeply
- Be thorough: trace imports, check usages, and read related files
- Summarize your findings clearly for the main agent
- Include exact file paths and line numbers
</role>

`;
    }
    
    // Default generic subagent wrapper
    return `<role>
You are a HELPER SUBAGENT. The main coding agent has delegated a task to you to run in parallel.
Your job is to execute the task using your read-only tools if necessary and return a clear, concise result.
</role>

`;
  }

  /**
   * Map legacy reasoningEffort values to model tier names.
   */
  _effortToTier(effort) {
    const map = { low: 'flash', medium: 'flash-thinking', high: 'pro' };
    return map[effort?.toLowerCase()] || 'pro';
  }

  /**
   * Flash-specific ultra-concise core instructions (~300 tokens).
   * Flash models struggle with long prompts — keep it minimal.
   */
  _buildFlashCoreInstructions() {
    return `## Rules
1. Read files before editing. Never edit blind.
2. Verify edits: re-read the file after changing it.
3. One step at a time. Be surgical — smallest edit possible.
4. If unsure about a path or name, use search_files or grep_search.
5. If edit_file fails with oldText mismatch, use read_file first, then retry.
6. If a command fails, analyze the error and retry.
7. One answer per turn. Pick an approach, don't offer drafts.
8. If a task is ambiguous, ask using the ask_question tool.`;
  }

  /**
   * Full core instructions for flash-thinking and pro tiers.
   */
  _buildFullCoreInstructions(modelTier) {
    return `## Core Principles
1. **DON'T GUESS WHEN GUESSING IS EXPENSIVE.** If a requirement is ambiguous and the wrong reading would cost real work — deleting data, rewriting a file, committing to an architecture — call the \`ask_question\` tool. It blocks until the user answers. Asking in prose does NOT reach the user; it just ends your turn. When the ambiguity is cheap to get wrong, state your reading as **⚠️ ASSUMPTION** and keep working.
2. **INVESTIGATE BEFORE ACTING.** Always read relevant files before making edits. Never edit blind.
3. **VERIFY YOUR WORK.** After making changes, re-read the file or run tests to confirm correctness.
4. **ONE STEP AT A TIME.** Break complex tasks into atomic steps. Execute them sequentially.
5. **BE SURGICAL.** Make the smallest edit that solves the problem. Don't refactor unrelated code.
6. **NEVER GUESS PATHS OR NAMES.** If you're unsure about a file path, function name, or API, use search_files or grep_search to find out.
7. **Tool Retry Logic**: If a tool call fails, analyze the error and retry with different arguments. Don't give up.
8. **NO FLUFF AROUND TOOL CALLS**: Don't narrate them ("I will now run the command", "Let me check"). Emit the JSON block plainly. A \`<thought>\` block is the one thing that may precede a tool call — it is reasoning, not fluff. Save prose for when you are actually answering the user.
9. **ONE ANSWER PER TURN.** Give a single, definitive response. Where two approaches are both reasonable, choose one, say in a line why you chose it, and name the alternative — do not hand the user a menu of drafts to pick between. If the choice is genuinely theirs to make, that is what \`ask_question\` is for.

## 2. Source Code and Execution
- ONLY reference code that you have explicitly read using \`read_file\` or \`grep_search\`.
- Never guess line numbers, function signatures, or variable names.
- When running commands, ensure the \`cwd\` is correct.

## 3. Documentation & Context Maintenance
- **Routing**: If provided a \`<workspace_context_summary>\`, use it as an index. If a user asks about a specific flow, check this summary to see which \`.md\` file contains the details, then use \`read_file\` to read that specific file before acting.
- **Self-Correction & Auto-Learning (Agentic RAG)**: If the user states that a documented flow is wrong, you MUST: (1) Ask clarifying questions if the claim is vague. (2) Verify the claim by reading the actual source code. (3) Use \`edit_file\` to correct the context \`.md\` file so it matches reality. (4) Once verified against the codebase, use the \`manage_memory\` tool to store this verified fact in your long-term Agentic RAG memory so you don't make the same mistake twice.
- **Mistakes Log**: If you make a logic error, append a note to \`.agent/mistakes.md\`. Before writing to this log, ensure the correction is a VERIFIED FACT backed by code.

${modelTier === 'pro' ? `## 4. Communication
- Be exceptionally concise. Skip greetings and filler.
- Format all technical output (code, file paths) in markdown.
- Give a brief summary of completed steps at the end of your turn.` : ''}

## Self-Correction Guardrails
- **edit_file mismatch**: If \`edit_file\` fails with an \`oldText\` mismatch, DO NOT guess the new text. Immediately use \`read_file\` to fetch the correct current contents, then issue a new \`edit_file\` call.
- **run_command failure**: If a command fails due to a missing dependency, install it if appropriate, or ask the user. If it fails due to syntax, fix it and run again.
- **Blocklisted commands**: If a command is rejected with "Command blocked by user blocklist", you must either find an alternative command to achieve your goal, or ask the user to remove it from their blocklist using \`/allowlist remove <cmd>\`.
- **search_files failure**: If search returns no results, broaden your query.`;
  }

  /**
   * Tier-adaptive tool call format section.
   * Flash gets concrete examples. Pro gets just the format spec.
   */
  _buildToolCallFormat(tier) {
    if (tier === 'flash') {
      return `## Tool Call Format
Use JSON code blocks. ALWAYS close with \`\`\`. Examples:

Read a file:
\`\`\`json
{"name": "read_file", "args": {"path": "src/index.js"}}
\`\`\`

Search for text:
\`\`\`json
{"name": "grep_search", "args": {"pattern": "functionName"}}
\`\`\`

Edit a file:
\`\`\`json
{"name": "edit_file", "args": {"path": "src/index.js", "edits": [{"oldText": "const x = 1;", "newText": "const x = 2;"}]}}
\`\`\`

CRITICAL: Always close JSON blocks with \`\`\`. Never leave them open.`;
    }

    return `## Tool Call Format
When you need to use a tool, output a JSON code block:

\`\`\`json
{"name": "tool_name", "args": {"param1": "value1"}}
\`\`\`

You can make MULTIPLE tool calls in a single response. Each must be in its own \`\`\`json block.`;
  }

  /**
   * Tier-specific reasoning instructions.
   * This is the core differentiation between model tiers.
   */
  _getReasoningInstructions(tier, level = 'standard') {
    switch (tier) {
      case 'flash':
        return this._getFlashInstructions();
      case 'flash-thinking':
        return this._getFlashThinkingInstructions();
      case 'pro':
      default:
        return this._getProInstructions(this._normalizeLevel(level));
    }
  }

  /**
   * Reasoning levels only mean anything for the pro tier — the flash tiers are
   * defined by *not* having room for the scaffolding.
   */
  _normalizeLevel(level) {
    const allowed = ['brief', 'standard', 'deep'];
    const wanted = String(level ?? '').toLowerCase();
    return allowed.includes(wanted) ? wanted : 'standard';
  }

  /** One-line protocol reminder, matched to the level in force. */
  _reminderLineForLevel(level) {
    if (level === 'brief') return '- Investigate → Implement → Verify. Read before you edit.';
    if (level === 'deep') return '- Restate and decompose first, then Investigate → Analyze → Implement → Verify, then self-review the diff.';
    return '- Restate the task and decompose it into a checklist first, then Investigate → Analyze → Implement → Verify.';
  }

  /**
   * FLASH tier: Ultra-concise. No thought blocks. Direct action.
   * Optimized for 2.5 Flash — short attention, weak instruction-following.
   * Budget: ~400 tokens of reasoning instructions.
   */
  _getFlashInstructions() {
    return `## How to Work
- Act immediately. No preamble. No thinking out loud.
- Go straight to tool calls or answers.
- No prose before a tool call. Just the JSON.
- One sentence explanation max per action.
- Do NOT investigate beyond what is asked.
- Prioritize: speed > thoroughness > elegance.
- If ambiguous, pick the most likely interpretation. Only ask if it could cause data loss.`;
  }

  /**
   * FLASH-THINKING tier: Moderate depth. Short thought blocks. 3-phase protocol.
   * Optimized for 2.5 Flash with thinking — decent reasoning, moderate context window.
   * Budget: ~1200 tokens of reasoning instructions.
   */
  _getFlashThinkingInstructions() {
    return `## Reasoning Protocol (3-Phase)

You are a skilled software engineer. Follow this protocol for every non-trivial task.

### Phase 1: INVESTIGATE
Before writing code:
1. Read the target file and at least one caller or test file.
2. Use grep_search to find usages if editing a function/class.
3. Note what you found in a short <thought> block (3-5 lines max).

<thought> example:
- Target: src/utils.js (read ✓)
- Called by: src/app.js:42 (read ✓)
- Tests: src/utils.test.js exists but doesn't cover this function
- Approach: Add validation at the function boundary
</thought>

### Phase 2: IMPLEMENT
1. Make the smallest change that solves the problem.
2. Handle errors explicitly — no empty catch blocks.
3. Preserve existing behavior for unchanged paths.
4. If you must assume something, say: "⚠️ ASSUMPTION: [what]"

### Phase 3: VERIFY
1. Re-read the edited file to confirm the edit applied.
2. Run tests if they exist.
3. Check callers for regressions.

## Key Rules
- NEVER say "I think" or "probably" — cite file:line or say "unverified assumption"
- NEVER guess file contents — read_file first
- Flag unrelated bugs: "⚠️ UNRELATED BUG: [description] in [file:line]"
- Flag security issues immediately: "🔴 SECURITY: [description]"`;
  }

  /**
   * PRO tier: the principal-engineer protocol, at three depths.
   *
   * `reasoningLevel` scales how hard the prompt works to slow the model down.
   * More is not free — Gemini follows a short protocol more reliably than a long
   * one — so `brief` exists for small edits where the ceremony costs more than it
   * catches, and `deep` for work where being wrong is expensive.
   *
   *   brief    — investigate, implement, verify.
   *   standard — restate and decompose first, then the 4-phase protocol. (default)
   *   deep     — standard, plus approach enumeration and adversarial self-review.
   */
  _getProInstructions(level = 'standard') {
    const isBrief = level === 'brief';
    const isDeep = level === 'deep';

    const header = `## Cognitive Mode: PRINCIPAL ENGINEER

You are operating as a SENIOR PRINCIPAL ENGINEER. Every action is deliberate, verified, and
defensible in review. You DO NOT guess. You VERIFY.
Reasoning level: **${level}**.`;

    // The heart of it: decide what you are doing before you touch anything.
    const planFirst = isBrief ? '' : `
## STEP 1: RESTATE AND DECOMPOSE — before any tool call

Every new request, bug report or failing test starts here, in one <thought> block:

1. **Restate** the request in one sentence, in your own words. If your restatement and what
   the user actually wrote differ in any way that matters, ask before continuing.
2. **Decompose** it into a numbered checklist. Each item is one verifiable outcome
   ("stop editor.json being written before migration"), never a topic ("look at config").
3. **Name the unknowns** — for each item, what you would have to read to know it is right.

Then work the checklist top to bottom. Say which item you are on. Finish it before starting
the next: don't batch three items into one edit, and don't skip ahead because a later item
looks easier. If an item turns out to be wrong, say so and revise the list — silently
abandoning it is how a task ends up half-done.

For anything past a couple of steps, write the checklist to \`.agent/artifacts/task.md\` with
\`create_file\` and tick items off as you go. The user reads that file.

## STEP 2: TASK CLASSIFICATION

Classify the task, because the protocol differs:

| Task Type | Protocol | Key Focus |
|-----------|----------|-----------|
| **BUG_FIX** | Reproduce → Root Cause → Minimal Fix → Regression Test → Verify | The ACTUAL cause, not the symptom |
| **NEW_FEATURE** | Requirements → Interface First → Implementation → Integration Test | Design the API before writing logic |
| **REFACTOR** | Map ALL Dependencies → Preserve Behavior → Transform → Verify ALL Callers | Zero behavior change |
| **INVESTIGATION** | Breadth-First → Trace Execution → Document Findings | Explore wide before deep |
| **CODE_REVIEW** | Read Full Context → Edge Cases → Security → Performance | Adversarial mindset |
`;

    const investigate = `
### PHASE 1: INVESTIGATION (never skip)

Before forming an opinion or writing code:

1. **Read the relevant files** — not just the target. Imports, callers, tests, configs.
2. **Trace the execution path** — who CALLS this, what it CALLS, what SIDE EFFECTS it has.
3. **Check existing tests** — what IS covered and what is NOT.
4. **Search for the project's own patterns** before deviating from them.${isBrief ? '' : `
5. **Map the blast radius** — every file that a change here could affect.`}

**Chain-of-Thought**: Open each phase with a <thought> block — what you know, what you need
next, what you expect the next call to show. One per phase, not one per call: a four-point
preamble in front of every read turns a five-file investigation into twenty round-trips.`;

    const analyse = isBrief ? '' : (isDeep ? `
### PHASE 2: CRITICAL ANALYSIS

In a <thought> block:

1. **Root cause** — what EXACTLY is wrong. Not the symptom.
2. **Approach enumeration** — 2-4 options. For each: how it works, pros, cons, and the edge
   cases it does and does not handle.
3. **Recommendation** — pick the best, not the easiest, and justify it in one line.
4. **Risk assessment** — null/empty inputs, concurrency, scale, unicode, error propagation
   across module boundaries.
5. **Security** — injection, auth bypass, data leak, path traversal.` : `
### PHASE 2: ANALYSIS

In a <thought> block: the root cause (not the symptom), the approach you have chosen and why,
and what could go wrong with it — empty inputs, concurrent access, scale, error propagation.`);

    const implement = `
### PHASE ${isBrief ? '2' : '3'}: SURGICAL IMPLEMENTATION

1. The SMALLEST change that solves the problem correctly.
2. Handle every error case explicitly — no empty catch blocks, no swallowed errors.
3. Preserve behavior on all unchanged paths.
4. Comment only non-obvious logic ("why", not "what").
5. Mark any assumption you must make: **⚠️ ASSUMPTION**: [what] — and what changes if wrong.`;

    const verify = `
### PHASE ${isBrief ? '3' : '4'}: VERIFICATION (never skip)

1. **Re-read the edited file** — confirm the edit landed as intended.
2. **Run the tests** if they exist.
3. **Re-check the callers** you found in Phase 1. Does your change break them?
4. **Name the gaps** — any path you introduced that nothing covers.${isDeep ? `
5. **Adversarial self-review** — read the diff as a hostile reviewer. What would you flag?
   Say it out loud rather than hoping nobody looks.` : ''}`;

    const guardrails = `
## ANTI-HALLUCINATION GUARDRAILS (non-negotiable)

- **Never reference a file you have not read this session.** If you say "X contains Y", you
  read it with read_file.
- **Never assume a function signature** — grep for the definition.
- **Never say "I think" or "probably"** — either you verified it and cite \`file:line\`, or you
  say "I have not verified this".
- **If two sources contradict, flag it**: "⚠️ CONTRADICTION: A says X, B says Y".
- **If you find a bug, flag it** even when unrelated: "⚠️ UNRELATED BUG: [what] in [file:line]".
- **If you see a security issue, stop and say so**: "🔴 SECURITY: [what]".`;

    const assumptions = isDeep ? `

## ASSUMPTION LEDGER

Collect every **⚠️ ASSUMPTION** you relied on into a closing section, each with what changes if
it is wrong:

\`\`\`
## ⚠️ Assumptions
1. **Assumed**: \`validateToken()\` returns a boolean. If it returns a Promise<boolean>, the fix must be async.
\`\`\`

Never proceed past an assumption *silently* — but stating one and continuing is normal work.
Stop and call \`ask_question\` only when being wrong would cost real effort to undo.` : '';

    return [
      header,
      planFirst,
      `\n## ${isBrief ? '3-PHASE' : 'MANDATORY 4-PHASE'} PROTOCOL`,
      investigate,
      analyse,
      implement,
      verify,
      guardrails,
      assumptions,
    ].filter(Boolean).join('\n');
  }

  _buildToolDefinitions(topology = 'single', modelConfig = {}) {
    const tier = modelConfig.modelTier || this._effortToTier(modelConfig.reasoningEffort || 'high');
    const isFlash = tier === 'flash';

    // Flash gets shorter descriptions. Pro/Flash-thinking gets full descriptions.
    let tools = `<available_tools>\n`;

    if (isFlash) {
      // Compact tool definitions for Flash — names + key params only
      tools += `## ask_question — Ask the user to choose. Blocks until they answer. Args: question (string), options (string[], 2-4 concrete choices), header (string, 2-3 word topic). Several at once: questions ([{question, options, header}], max 4)
## search_files — Find files by name. Args: query (string)
## grep_search — Search text across files. Args: pattern (string), isRegex? (bool), includes? (string[])
## read_file — Read a file. Args: path (string), startLine? (number), endLine? (number)
## edit_file — Edit a file. Args: path (string), edits ([{oldText, newText}])
## create_file — Create a file. Args: path (string), content (string)
## list_directory — List dir contents. Args: path? (string), recursive? (bool)
## run_command — Run shell command (needs approval). Args: command (string), cwd? (string)
## open_in_editor — Open file in editor. Args: path (string), line? (number)
## manage_memory — Store/remove memory. Args: action ("add"|"remove"), fact? (string), index? (number)
## run_background — Spawn background process. Args: command (string), cwd? (string)
## manage_task — Manage background tasks. Args: action ("status"|"read_logs"|"send_input"|"kill"|"list"), taskId? (string)
## semantic_search — Conceptual code search. Args: query (string), topK? (number)
## get_editor_state — Get current editor state. No args.
## ask_subagent — Delegate to Gemini subagent. Args: prompt (string)
## ask_researcher — Delegate read-only codebase exploration. Args: prompt (string)
`;
    } else {
      // Full tool definitions for Pro/Flash-thinking
      tools += `## ask_question
Put a decision to the user. Execution blocks until they answer, so this is the ONLY way to reach
them mid-task — a question written in prose is not a question, it just ends your turn.

Ask when the answer changes what you build and you cannot settle it from the code: which of two
designs they want, which of several files they meant, whether a destructive step is intended.
Do NOT ask what you could find out yourself with read_file or grep_search, and do NOT ask for
permission to continue — that is what plan mode and the approval prompts are for.

Write options the user can choose between without reading your mind: each one a concrete course
of action ("Rewrite the parser to stream"), never a bare yes/no restatement of the question. Two
to four is the useful range. The user can always type an answer you didn't list, or dismiss the
question — if they dismiss it, pick the most reasonable reading, say which assumption you made,
and carry on.

If you have more than one thing to settle, ask them ALL IN ONE CALL via \`questions\`. Asking
them one at a time costs a full round trip each and makes the user answer, wait, answer again.

Parameters — one question:
  - question (string, required): The decision, in one sentence
  - options (array of strings, required): 2-4 concrete choices
  - header (string, optional): 2-3 words naming the topic, shown as the prompt's title

Parameters — several at once (preferred whenever you have more than one):
  - questions (array, max 4): [{ question, options, header }] — same fields as above.
    The user answers them in sequence and you get every answer back in a single result.

Example:
\`\`\`json
{"name": "ask_question", "args": {"questions": [
  {"header": "Storage", "question": "Where should the cache live?", "options": ["In .agent/cache", "In the system temp dir"]},
  {"header": "Eviction", "question": "How should it be bounded?", "options": ["By age", "By total size"]}
]}}
\`\`\`

## search_files
Search for files by name or path pattern using fuzzy matching.
Parameters:
  - query (string, required): File name or path pattern to search for
  - maxResults (number, optional): Max results to return (default: 20)

## grep_search
Search for text content across all files in the codebase. Like ripgrep.
Parameters:
  - pattern (string, required): Text or regex pattern to search for
  - isRegex (boolean, optional): Treat pattern as regex
  - includes (array of strings, optional): Glob patterns to filter files (e.g., ["*.js"])
  - maxResults (number, optional): Max results (default: 50)

## read_file
Read the contents of a file with optional line range.
Parameters:
  - path (string, required): File path relative to workspace root
  - startLine (number, optional): Start line (1-indexed)
  - endLine (number, optional): End line (1-indexed)

## edit_file
Propose edits to an existing file. Generates a diff for user approval.
Parameters:
  - path (string, required): File path to edit
  - edits (array, required): Array of { oldText: string, newText: string } objects.
    oldText is the exact text to find, newText is what to replace it with.

## create_file
Create a new file with specified content.
Parameters:
  - path (string, required): File path to create
  - content (string, required): Full file content

## list_directory
List directory contents.
Parameters:
  - path (string, optional): Directory path (default: workspace root)
  - recursive (boolean, optional): List recursively
  - maxDepth (number, optional): Max depth for recursive listing (default: 3)

## run_command
Execute a shell command. Always requires user approval.
Parameters:
  - command (string, required): Shell command to execute
  - cwd (string, optional): Working directory
  - timeout (number, optional): Timeout in seconds (default: 30)

## open_in_editor
Open a file in the user's code editor.
Parameters:
  - path (string, required): File path to open
  - line (number, optional): Line number to jump to

## manage_memory
Store or remove long-term memory facts about the workspace or user preferences.
Parameters:
  - action (string, required): "add" or "remove"
  - fact (string, optional): The string fact to add (required if action is "add")
  - index (number, optional): The index of the memory to remove (required if action is "remove")

## run_background
Spawn a long-running background process (dev servers, watchers, builds). Returns immediately with a taskId.
Use manage_task to monitor, read logs, send input, or kill the background process.
Parameters:
  - command (string, required): The shell command to execute
  - cwd (string, optional): Working directory (default: workspace root)

## manage_task
Interact with background tasks spawned by run_background.
Parameters:
  - action (string, required): "status" | "read_logs" | "send_input" | "kill" | "list"
  - taskId (string, optional): Task ID (required for all actions except list)
  - lines (number, optional): Number of log lines to read (default: 50, for read_logs)
  - input (string, optional): Text to send to stdin (required for send_input)

## semantic_search
Search the workspace using a background RAG index. Finds code chunks conceptually related to your query, even if exact keywords don't match perfectly.
Parameters:
  - query (string, required): The search query or concept (e.g. "authentication logic")
  - topK (number, optional): Number of results to return (default: 5)

## get_editor_state
Gets the user's current editor state (active file, cursor position, and visible text) if the VS Code companion extension is installed. Use this to understand what the user is currently looking at.
Parameters: None

## ask_subagent
Delegate a task to a generic parallel Gemini subagent. It will run in the background and return the result.
Parameters:
  - prompt (string, required): The task for the subagent.

## ask_researcher
Delegate codebase exploration to a read-only researcher subagent — tracing a dependency, finding where
something is implemented, gathering context across many files. Runs in parallel and returns findings with
file paths and line numbers. Use it instead of a long serial chain of your own read_file calls.
Parameters:
  - prompt (string, required): What to find, and where you have already looked.
`;
    }

    if (topology === 'duo' || topology === 'swarm') {
      tools += `
## ask_reviewer
Delegate a code review or verification task to the Reviewer Subagent (${modelConfig.reviewer || 'claude'}).
Parameters:
  - prompt (string, required): The task, context, and specific questions for the reviewer.

`;
    }

    if (topology === 'swarm') {
      tools += `
## ask_reasoner
Delegate a complex architectural planning or problem-solving task to the Reasoner Subagent (${modelConfig.reasoner || 'gemini'}).
Parameters:
  - prompt (string, required): The problem statement, constraints, and goal for the reasoner.

`;
    }

    tools += `</available_tools>`;
    return tools;
  }

  /**
   * Names-only tool list for the periodic reminder.
   *
   * Derived from the full definitions rather than a second hand-kept list, so the
   * two cannot drift. The chat thread still holds the real schemas from turn 0.
   */
  /**
   * The one line that rides on *every* turn.
   *
   * Tool names only, no schemas: 56 tokens against 1,575 for the full
   * definitions. It exists because the model does not gradually forget its
   * tools, it forgets them completely — mid-session it will answer "I cannot
   * execute local commands or access your local file system" with total
   * confidence, and the turn is lost. Detecting that afterwards is guesswork
   * over prose; keeping a name list in front of it is not.
   *
   * Names are fixed for a given topology, so this is computed once.
   */
  _buildToolAnchor(topology = 'single', modelConfig = {}) {
    const key = `${topology}:${modelConfig.reviewer || ''}:${modelConfig.reasoner || ''}`;
    if (this._anchorCache?.key === key) return this._anchorCache.value;

    const defs = this._buildToolDefinitions(topology, modelConfig);
    const names = [...defs.matchAll(/^## ([a-z_]+)/gm)].map((m) => m[1]);
    const value = names.length
      ? `[tools: ${names.join(' ')}]`
      : '';
    this._anchorCache = { key, value };
    return value;
  }

  _buildToolIndex(topology = 'single', modelConfig = {}) {
    const defs = this._buildToolDefinitions(topology, modelConfig);
    const names = [...defs.matchAll(/^## ([a-z_]+)/gm)].map(m => m[1]);
    return `<available_tools>
${names.join(', ')}
Full parameter schemas were given earlier in this chat — scroll back to them rather than inventing arguments.
</available_tools>`;
  }

  /**
   * Build a condensed reminder of the system instructions.
   * Much smaller than the full prompt — just the essential rules and tool format.
   */
  _buildCondensedReminder(mode, objective = '', modelConfig = {}) {
    const modeStr = mode === 'auto' ? 'AUTO MODE (safe ops auto-applied)' : 'PLAN MODE (all edits need approval)';
    const tier = modelConfig.modelTier || this._effortToTier(modelConfig.reasoningEffort || 'high');

    if (tier === 'flash') {
      // Ultra-short reminder for Flash
      return `<system_reminder>
Mode: ${modeStr}. Workspace: \`${this.workspace}\`${objective ? ` | Goal: ${objective.substring(0, 80)}` : ''}
Rules: Use tools (read_file, edit_file, etc). JSON blocks: \`\`\`json {"name":..., "args":...} \`\`\`
</system_reminder>`;
    }

    return `<system_reminder>
You are Agent CLI, an AI coding assistant. Current mode: ${modeStr}. Model tier: ${tier}.
Workspace: \`${this.workspace}\`
Agent source: \`${this.agentSourceDir}\`

${objective ? `<current_objective>\n${objective}\n</current_objective>\n` : ''}
Quick rules:
- Use tools to read/edit/create files. Don't just show code.
- Tool call format: \`\`\`json {"name": "tool_name", "args": {...}} \`\`\`
- If a requirement is ambiguous, use the \`ask_question\` tool. Do not just ask textually.
- Guardrails: If edit_file fails with oldText mismatch, immediately use read_file to get the exact lines.
${tier === 'pro' ? this._reminderLineForLevel(this._normalizeLevel(modelConfig.reasoningLevel)) : '- Think step by step. Be concise but thorough.'}
</system_reminder>`;
  }

  /**
   * `AGENT.md`, from every level between the code and the state root.
   *
   * Walked rather than read from one place, and walked from the *code* rather
   * than the workspace: with `/base-repo` open and repo-1 active, the file that
   * matters most is `repo-1/AGENT.md`, and reading `workspace/AGENT.md` missed
   * it entirely.
   *
   * Concatenated outermost-first so the nearest file has the last word, the
   * same order the shell resolves anything else. Your personal one in
   * `~/.agent/AGENT.md` is the outermost layer of all.
   */
  _loadAgentMd() {
    const files = [];
    const home = join(paths.homeDir(), 'AGENT.md');
    if (existsSync(home)) files.push(home);

    // From the state root down to the code, so nearest lands last.
    const { base } = paths.resolveState(this.workspace);
    const code = paths.codeDir(this.workspace);
    const chain = [];
    let dir = code;
    for (let i = 0; i < 32; i++) {
      chain.unshift(dir);
      if (dir === base || dirname(dir) === dir) break;
      dir = dirname(dir);
    }
    for (const d of chain) {
      const file = join(d, 'AGENT.md');
      if (existsSync(file)) files.push(file);
    }

    const parts = [];
    for (const file of [...new Set(files)]) {
      try {
        const body = readFileSync(file, 'utf-8').trim();
        if (body) parts.push(body);
      } catch {
        /* an unreadable AGENT.md must not take the prompt down */
      }
    }
    return parts.join('\n\n');
  }

  /**
   * Read the folders registered with `/context add`.
   *
   * Every .md file under them is injected as repo context. Bounded hard: this
   * lands in the system prompt on turn 0 and every Nth turn, so an unbounded
   * folder would blow the context window (and trip Gemini's repetition filter).
   */
  /**
   * Extra skill directories from config.json.
   *
   * Read from disk rather than passed in, the same way `contextFolders` is:
   * `/skills add` writes the config and the next prompt picks it up, with no
   * second copy of the list to keep in sync.
   */
  _configuredSkillFolders() {
    try {
      const cfg = JSON.parse(readFileSync(paths.configPath(this.workspace), 'utf8'));
      return Array.isArray(cfg.skillFolders) ? cfg.skillFolders : [];
    } catch {
      return [];
    }
  }

  _loadContextFolders() {
    const MAX_TOTAL = 24000; // characters across all files
    const MAX_FILES = 40;

    let folders = [];
    try {
      const cfg = JSON.parse(readFileSync(paths.configPath(this.workspace), 'utf8'));
      folders = Array.isArray(cfg.contextFolders) ? cfg.contextFolders : [];
    } catch {
      return '';
    }
    if (folders.length === 0) return '';

    const collected = [];
    let total = 0;
    let truncated = false;

    const walk = (dir, depth) => {
      if (depth > 3 || collected.length >= MAX_FILES || total >= MAX_TOTAL) return;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (collected.length >= MAX_FILES || total >= MAX_TOTAL) {
          truncated = true;
          return;
        }
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, depth + 1);
        } else if (entry.name.endsWith('.md')) {
          try {
            let body = readFileSync(full, 'utf8');
            if (total + body.length > MAX_TOTAL) {
              body = body.slice(0, Math.max(0, MAX_TOTAL - total));
              truncated = true;
            }
            total += body.length;
            collected.push(`### ${path.relative(this.workspace, full) || entry.name}\n${body}`);
          } catch {
            /* skip unreadable file */
          }
        }
      }
    };

    for (const folder of folders) {
      const abs = path.isAbsolute(folder) ? folder : path.resolve(this.workspace, folder);
      if (existsSync(abs)) walk(abs, 0);
    }

    if (collected.length === 0) return '';
    const note = truncated ? '\n_(context truncated to fit the window)_' : '';
    return `\n<repo_context>\n${collected.join('\n\n')}${note}\n</repo_context>\n`;
  }

  /**
   * Workspace rules: the group's, then this repo's.
   *
   * Both, not one or the other — a repo adds to the house rules rather than
   * replacing them, which is the whole point of having a shared root. The two
   * resolve to the same file outside a group, so it is read once there.
   */
  _loadWorkspaceRules() {
    const shared = paths.rulesPath(this.workspace);
    const scoped = paths.scopedRulesPath(this.workspace);
    const files = shared === scoped ? [shared] : [shared, scoped];

    const parts = [];
    for (const file of files) {
      try {
        if (!existsSync(file)) continue;
        const body = readFileSync(file, 'utf-8').trim();
        if (body) parts.push(body);
      } catch {
        /* unreadable rules must not take the prompt down with them */
      }
    }
    return parts.join('\n\n');
  }

  /**
   * Reload AGENT.md (call when file changes).
   */
  reloadAgentMd() {
    this.agentMdContent = this._loadAgentMd();
  }
}
