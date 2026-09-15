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
import { readFileSync, existsSync } from 'fs';
import os from 'os';
import { resolve, relative, join, dirname } from 'path';
import { CodeMinifier } from '../context/code-minifier.js';
import { skillCatalogue } from './skills.js';
import { resolveEffort } from './effort.js';
import { renderToolDefinitions } from './tool-catalog.js';
import { prompt } from './prompt-loader.js';
import { parseMemory, readMemoryEnabled } from '../context/memory-manager.js';

// How often to send the condensed reminder, counted in MESSAGES pushed to the tab —
// not user turns. One user turn can be a dozen tool round-trips, so a turn-based
// counter drifts by an order of magnitude in tool-heavy work and fires far too
// eagerly in a chatty Q&A session.
const REFRESH_INTERVAL_MESSAGES = 20;

/**
 * Is this file saying anything?
 *
 * `loaded` is the ordinary case. `empty` is a file that exists and has nothing
 * in it. `template` is the one worth naming: the stock `AGENT.md` ships with six
 * headings and five HTML comments reading "describe your project here", and
 * `_loadAgentMd` only skips a file whose *trimmed body* is empty — a template
 * full of headings is not empty, so it goes into every turn-0 prompt, presented
 * to the model as this project's context. This repo's own AGENT.md is one.
 */
export function agentMdState(body) {
  if (!body) return 'empty';
  const placeholders = (body.match(/<!--[^>]*-->/g) || []).length;
  const prose = body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^#.*$/gm, '')
    .replace(/^```[\s\S]*?```$/gm, '')
    .trim();
  if (placeholders >= 3 && prose.length < 400) return 'template';
  return 'loaded';
}

/** The checklist is model-written and nothing prunes it, so it is bounded. */
const MAX_TASK_ITEMS = 40;
const MAX_TASK_CHARS = 2000;

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

      // What the agent learned here on earlier runs. This is the half that was
      // missing: `manage_memory` wrote facts to disk and no prompt ever carried
      // them, so the model paid a tool call per fact and got nothing back.
      const memory = this._loadMemory();
      if (memory) {
        parts.push(`<memory>\n${memory}\n</memory>`);
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

    // The checklist it wrote, so it can tick the exact line rather than guess
    // at one. Every turn, because ticking is a per-turn act — see _loadTaskList.
    const taskList = this._loadTaskList();
    if (taskList) {
      parts.push(`<task_checklist path=".agent/artifacts/task.md">\n${taskList}\n</task_checklist>`);
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

    // One setting decides both. They used to be stored separately and could
    // disagree — "flash tier, deep reasoning" was representable and meant
    // nothing, because the flash profile has no reasoning section to deepen.
    const effort = resolveEffort(modelConfig.effort);
    const modelTier = effort.tier;
    const reasoningLevel = effort.level || 'standard';

    // Tier-adaptive core instructions
    const coreInstructions = modelTier === 'flash'
      ? this._buildFlashCoreInstructions()
      : this._buildFullCoreInstructions(modelTier);

    const reasoningInstructions = this._getReasoningInstructions(modelTier, reasoningLevel);

    // Tool call format (Flash gets examples, Pro gets description only)
    const toolCallFormat = this._buildToolCallFormat(modelTier);

    const selfAwareness = `
<self_awareness>
You are currently operating in the user's workspace at: \`${this.workspace}\`
Your OWN source code (the Gemini-Agent server) is at: \`${this.agentSourceDir}\`
If the user asks you to modify yourself, you can read/write files directly in \`${this.agentSourceDir}\`.
Effort: ${effort.id} — ${effort.blurb}
</self_awareness>`;

    const combined = `
${selfAwareness}
${coreInstructions}

${reasoningInstructions}
`;

    // Topology-specific instructions
    let topologyInstructions = '';

    if (topology === 'single') {
      topologyInstructions = `
## Role: Solo Agent
You are the only *model* on this task — there is no reviewer to defer to, so
planning, implementation, review and testing are all yours. You can still fan work out to
parallel tabs of yourself: \`ask_researcher\` for read-only exploration you would otherwise do
with a long serial chain of read_file calls, \`ask_subagent\` for a self-contained side task.
They run in parallel and return to you. Delegating judgement is what you cannot do here.

- When tasks are complex, create a plan first (save it to \`.agent/artifacts/implementation_plan.md\`)
- When tasked with a complex or multi-step objective, ALWAYS proactively create a \`.agent/artifacts/task.md\` checklist using the \`create_file\` tool to plan your work, similar to Antigravity IDE. Its current contents are given back to you in \`<task_checklist>\` on every turn — tick an item the moment it is done, with \`edit_file\` replacing that exact line's \`- [ ]\` with \`- [x]\`. The user is reading that file to see where you are.
- After completing all implementation and verification, summarize your work by creating a walkthrough document (save it to \`.agent/artifacts/walkthrough.md\`). Document changes made, what was tested, and validation results.
- After implementing changes, self-review: re-read the edited files and verify correctness
- If you're not confident in a change, tell the user explicitly rather than guessing`;

    } else if (topology === 'duo') {
      const reviewer = modelConfig.reviewer || 'chatgpt';
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
    
    // Default generic subagent wrapper
    return `<role>
You are a HELPER SUBAGENT. The main coding agent has delegated a task to you to run in parallel.
Your job is to execute the task using your read-only tools if necessary and return a clear, concise result.
</role>

`;
  }

  /**
   * Flash-specific ultra-concise core instructions (~300 tokens).
   * Flash models struggle with long prompts — keep it minimal.
   */
  /**
   * Flash-specific ultra-concise core instructions (~300 tokens).
   * Flash models struggle with long prompts — keep it minimal.
   */
  _buildFlashCoreInstructions() {
    return prompt('core-flash');
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
- **Project instructions**: \`AGENT.md\` is where a project's standing rules live, walked from the code upward. If the user tells you a convention that should hold for every future turn, offer to add it there — do not keep it only in your own memory.
- **Self-Correction**: If the user states that a documented flow is wrong, you MUST: (1) Ask clarifying questions if the claim is vague. (2) Verify the claim by reading the actual source code. (3) Use \`edit_file\` to correct the document so it matches reality. (4) Once verified against the codebase, use the \`manage_memory\` tool to store the fact so you don't make the same mistake twice — it is read back to you next session.

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
  /**
   * How to write a tool call.
   *
   * Flash gets worked examples and pro gets the spec: the smaller model copies
   * a shape far more reliably than it follows a description, and the larger one
   * does not need the tokens spent on showing it.
   */
  _buildToolCallFormat(tier) {
    return prompt(tier === 'flash' ? 'tool-call-format-flash' : 'tool-call-format-full');
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
  /** The flash tier's reasoning protocol: there is deliberately almost none. */
  _getFlashInstructions() {
    return prompt('reasoning-flash');
  }

  /**
   * FLASH-THINKING tier: Moderate depth. Short thought blocks. 3-phase protocol.
   * Optimized for 2.5 Flash with thinking — decent reasoning, moderate context window.
   * Budget: ~1200 tokens of reasoning instructions.
   */
  /** Flash-thinking: a three-phase protocol, still a short prompt. */
  _getFlashThinkingInstructions() {
    return prompt('reasoning-flash-thinking');
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
    const planFirst = isBrief ? '' : `\n${prompt('pro-plan-first')}\n`;

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

    const guardrails = `\n${prompt('pro-guardrails')}`;

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

  /**
   * What the model is told it can call.
   *
   * Assembled from `core/tool-catalog.js` rather than written out here. It used
   * to be two prose blocks in this method — one per tier — with a third list in
   * `agent-loop.js` and the runnable registry in `mcp/mcp-server.js`, and
   * nothing making any of them agree. `recall_history` and `get_diagnostics`
   * were registered, implemented and unreachable for exactly that reason.
   *
   * The text is unchanged: it was moved byte-for-byte and `tool-catalog.test.js`
   * pins every tier x topology shape against what this method used to return.
   */
  _buildToolDefinitions(topology = 'single', modelConfig = {}) {
    const tier = resolveEffort(modelConfig.effort).tier;
    return renderToolDefinitions(tier, topology, modelConfig);
  }

  /**
   * Names-only tool list for the periodic reminder.
   *
   * Derived from the full definitions rather than a second hand-kept list, so the
   * two cannot drift. The chat thread still holds the real schemas from turn 0.
   */
  /**
   * The checklist the model wrote, handed back to it.
   *
   * **The same write-only trap as memory, in a second place.** The system
   * prompt tells the model to create `.agent/artifacts/task.md` and "tick items
   * off as you go", and the file it writes is read by exactly one thing: the
   * UI, to draw a row above the prompt. No prompt has ever carried its contents
   * back. Measured: absent from turn 0, from every tool-result turn, and from
   * twenty-five further turns including refreshes.
   *
   * So ticking a box meant the model either guessing the exact line text for
   * `edit_file` — which fails outright on a mismatch — or rewriting the whole
   * file from a memory that compaction erodes. Neither is something a model
   * does reliably, and the observed behaviour was the predictable one: the
   * checklist gets created and never updated.
   *
   * Unlike memory this rides on **every** turn, because ticking is a per-turn
   * act. It is the same argument as the tool anchor: a small payload that
   * prevents a failure beats a large one that detects it. A checklist is a few
   * hundred characters; the turn that silently stops tracking progress costs
   * more than that.
   *
   * Bounded like memory, for the same reason — it is model-written and nothing
   * prunes it.
   */
  _loadTaskList() {
    try {
      const file = paths.artifactPath(this.workspace, 'task.md');
      if (!existsSync(file)) return '';
      const body = readFileSync(file, 'utf-8').trim();
      if (!body) return '';

      const lines = body.split('\n');
      const items = lines.filter((l) => /^\s*[-*]\s*\[[ xX]\]/.test(l));
      // Only the checklist itself. A long preamble is the model's own prose,
      // which it does not need read back to it.
      const kept = (items.length ? items : lines).slice(0, MAX_TASK_ITEMS);
      let text = kept.join('\n');
      if (text.length > MAX_TASK_CHARS) text = `${text.slice(0, MAX_TASK_CHARS)}\n…`;
      const dropped = (items.length ? items.length : lines.length) - kept.length;
      return dropped > 0 ? `${text}\n… and ${dropped} more` : text;
    } catch {
      // An unreadable artifact must not take the prompt down.
      return '';
    }
  }

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
    const key = `${topology}:${modelConfig.reviewer || ''}`;
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
    const tier = resolveEffort(modelConfig.effort).tier;

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
${tier === 'pro' ? this._reminderLineForLevel(resolveEffort(modelConfig.effort).level) : '- Think step by step. Be concise but thorough.'}
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
    const found = [];
    for (const file of [...new Set(files)]) {
      try {
        const body = readFileSync(file, 'utf-8').trim();
        if (body) parts.push(body);
        found.push({ path: file, bytes: body.length, state: agentMdState(body) });
      } catch (err) {
        // An unreadable AGENT.md must not take the prompt down — but it should
        // not vanish either. Reported, so the one screen that lists sources can
        // say why a file you wrote is not in the prompt.
        found.push({ path: file, bytes: 0, state: 'unreadable', detail: err.message });
      }
    }

    // Kept, rather than discarded with the local variable it used to live in.
    // The walk is the only thing that knows which files are in play, it ran on
    // every full prompt, and nothing could ask it afterwards — so there was no
    // way to find out that the AGENT.md being sent was an unedited template.
    this.lastAgentMdFiles = found;
    return parts.join('\n\n');
  }

  /**
   * `memory.md`, numbered, and hard-bounded.
   *
   * Memory is the one context source that grows on its own — every turn can
   * add to it and nothing prunes it — so it is the one that must not be
   * allowed to grow the prompt in step. Past the cap the prompt carries the
   * count and the path instead of the contents, and the model reads the file
   * with `read_file` if it wants the rest. The prompt is retyped into a
   * browser tab; a system prompt that creeps upward for months is how you
   * arrive at Gemini's repetition filter without ever making a decision.
   *
   * Numbered because `manage_memory remove` takes a position, and until now
   * the model was choosing indices into a list it had never been shown.
   */
  _loadMemory() {
    const MAX_FACTS = 40;
    const MAX_CHARS = 4000;

    if (!readMemoryEnabled(this.workspace)) return '';

    let facts;
    try {
      facts = parseMemory(readFileSync(paths.memoryPath(this.workspace), 'utf8'));
    } catch {
      return ''; // no memory file yet, or an unreadable one
    }
    if (facts.length === 0) return '';

    const lines = [];
    let total = 0;
    for (const [i, fact] of facts.entries()) {
      if (i >= MAX_FACTS || total + fact.length > MAX_CHARS) {
        lines.push(
          `_${facts.length - i} more in ${paths.memoryPath(this.workspace)} — `
          + 'read_file it if this task needs them._',
        );
        break;
      }
      total += fact.length;
      lines.push(`${i + 1}. ${fact}`);
    }
    return lines.join('\n');
  }

  /**
   * Extra skill directories from config.json.
   *
   * Read from disk rather than passed in: `/skills dir add` writes the config
   * and the next prompt picks it up, with no second copy of the list to keep
   * in sync.
   */
  _configuredSkillFolders() {
    try {
      const cfg = JSON.parse(readFileSync(paths.configPath(this.workspace), 'utf8'));
      return Array.isArray(cfg.skillFolders) ? cfg.skillFolders : [];
    } catch {
      return [];
    }
  }

  /**
   * Reload AGENT.md (call when file changes).
   */
  reloadAgentMd() {
    this.agentMdContent = this._loadAgentMd();
  }
}

/**
 * Replace an inlined image with a note that one was sent.
 *
 * `/image` puts the whole file into the prompt as a base64 data URL, because
 * the content script rebuilds it there into a real File and pastes it into the
 * chat — there is no upload endpoint to use instead. That is fine going out and
 * ruinous going into the record: the conversation history, both session files,
 * every later compaction prompt and the retry objective would each carry a
 * megabyte of base64 that no one can read and the model has already seen.
 */
export function stripImageData(text) {
  return String(text ?? '').replace(
    /<image_data>\n?data:[^\n]+\n?<\/image_data>/g,
    '<image_data>(the image was delivered to the chat tab)</image_data>',
  );
}
