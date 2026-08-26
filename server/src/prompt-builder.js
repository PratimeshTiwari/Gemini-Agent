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

import { readFileSync, existsSync } from 'fs';
import { resolve, relative } from 'path';

// How often to resend the full system prompt as a reminder
const SYSTEM_PROMPT_REFRESH_INTERVAL = 10;

export class PromptBuilder {
  constructor(workspace, agentSourceDir) {
    this.workspace = workspace;
    this.agentSourceDir = agentSourceDir;
    this.agentMdContent = this._loadAgentMd();
    this.turnCounter = 0; // Tracks turns since last full system prompt
    this.hasSeenSystemPrompt = false; // Has the current chat session received a system prompt?
  }

  /**
   * Reset prompt state (call after /compact or /clear which start a new Gemini chat).
   */
  resetPromptState() {
    this.turnCounter = 0;
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
   * @param {Array} options.conversationHistory - Previous turns (used for token counting only)
   * @param {string} options.workspaceSummary - Workspace overview
   * @param {string} options.mode - 'plan' or 'auto'
   * @returns {string} The complete prompt to inject
   */
  buildPrompt({ userMessage, conversationHistory = [], workspaceSummary = '', mode = 'plan', topology = 'single', modelConfig = {} }) {
    const parts = [];

    const needsFullPrompt = !this.hasSeenSystemPrompt;
    const needsRefresh = this.turnCounter > 0 && (this.turnCounter % SYSTEM_PROMPT_REFRESH_INTERVAL === 0);

    if (needsFullPrompt) {
      // First turn in this chat session — send everything
      parts.push(this._buildSystemInstructions(mode, topology, modelConfig));
      parts.push(this._buildToolDefinitions(topology, modelConfig));

      if (workspaceSummary) {
        parts.push(`<workspace_context>\n${workspaceSummary}\n</workspace_context>`);
      }
      if (this.agentMdContent) {
        parts.push(`<agent_instructions>\n${this.agentMdContent}\n</agent_instructions>`);
      }

      const workspaceRules = this._loadWorkspaceRules();
      if (workspaceRules) {
        parts.push(`<workspace_rules>\n${workspaceRules}\n</workspace_rules>`);
      }

      this.hasSeenSystemPrompt = true;
    } else if (needsRefresh) {
      // Periodic refresh — condensed reminder of instructions and tools
      parts.push(this._buildCondensedReminder(mode));
      parts.push(this._buildToolDefinitions(topology, modelConfig));
    } else {
      // Regular turn — just a brief context line
      parts.push(`[Workspace: ${this.workspace} | Mode: ${mode}]`);
    }

    // Current user message
    parts.push(`<user_message>\n${userMessage}\n</user_message>`);
    
    // Single-response instruction (always include, it's tiny)
    parts.push(`**IMPORTANT**: Provide exactly ONE response. No drafts, no A/B options.`);

    this.turnCounter++;

    return parts.join('\n\n');
  }

  /**
   * Build a follow-up prompt after a tool call result.
   */
  buildToolResultPrompt(toolName, result) {
    return [
      `<tool_result>`,
      `Tool: ${toolName}`,
      `Result:`,
      typeof result === 'string' ? result : JSON.stringify(result, null, 2),
      `</tool_result>`,
      '',
      'Continue with your analysis. If you need to use more tools, do so. ' +
      'If you are ready to respond to the user, provide your final response. ' +
      'If you need to propose file edits, use the edit_file or create_file tools.',
      '',
      '**IMPORTANT**: Provide exactly ONE response. No drafts, no options.'
    ].join('\n');
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

    // Core instructions shared across all topologies
    const coreInstructions = `
## Core Principles
1. **NEVER ASSUME. ALWAYS ASK.** If a requirement is ambiguous, underspecified, or could be interpreted multiple ways, you MUST ask the user for clarification using: \`QUESTION: <your question here>\`. The CLI will pause and prompt the user. Do NOT guess, infer, or make assumptions about what the user wants. The only exception is when the user explicitly tells you to "be creative" or "use your judgment".
2. **INVESTIGATE BEFORE ACTING.** Always read relevant files before making edits. Never edit blind.
3. **VERIFY YOUR WORK.** After making changes, re-read the file or run tests to confirm correctness.
4. **ONE STEP AT A TIME.** Break complex tasks into atomic steps. Execute them sequentially.
5. **BE SURGICAL.** Make the smallest edit that solves the problem. Don't refactor unrelated code.
6. **NEVER GUESS PATHS OR NAMES.** If you're unsure about a file path, function name, or API, use search_files or grep_search to find out.
7. **Tool Retry Logic**: If a tool call fails, analyze the error and retry with different arguments. Don't give up.
8. **CRITICAL**: Never output multiple drafts. Provide a single, definitive response.

<Self-Awareness>
You are currently operating in the user's workspace at: \`${this.workspace}\`
Your OWN source code (the Gemini-Agent server) is at: \`${this.agentSourceDir}\`
If the user asks you to modify yourself, you can read/write files directly in \`${this.agentSourceDir}\`.
</Self-Awareness>

## Tool Call Format
When you need to use a tool, output a JSON code block:

\`\`\`json
{"name": "tool_name", "args": {"param1": "value1"}}
\`\`\`

You can make MULTIPLE tool calls in a single response. Each must be in its own \`\`\`json block.

## Response Guidelines
- Show your reasoning briefly before tool calls
- After getting tool results, analyze them and decide next steps
- When proposing edits, explain WHAT and WHY
- Be concise. Don't over-explain.`;

    // Topology-specific instructions
    let topologyInstructions = '';

    if (topology === 'single') {
      topologyInstructions = `
## Role: Solo Agent
You are the SOLE agent. There are no other models to delegate to. You handle everything yourself:
planning, research, implementation, review, and testing.

- When tasks are complex, create a plan first (save it to \`.gemini/plan.md\`)
- After implementing changes, self-review: re-read the edited files and verify correctness
- If you're not confident in a change, tell the user explicitly rather than guessing`;

    } else if (topology === 'duo') {
      const reviewer = modelConfig.reviewer || 'claude';
      topologyInstructions = `
## Role: Primary Agent (Duo System)
You are the PRIMARY coding agent in a 2-agent system.
You have a Reviewer subagent (${reviewer}) available via the \`ask_reviewer\` tool.

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
  - **Reasoner** (${reasoner}) via \`ask_reasoner\`: Deep architectural thinking, algorithm design, tradeoff analysis
  - **Reviewer** (${reviewer}) via \`ask_reviewer\`: Code review, bug hunting, security analysis

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

    return `<system>
${modeInstructions}

${coreInstructions}

${topologyInstructions}
</system>`;
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
    }
    return '';
  }

  _buildToolDefinitions(topology = 'single', modelConfig = {}) {
    let tools = `<available_tools>
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
`;

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
   * Build a condensed reminder of the system instructions.
   * Much smaller than the full prompt — just the essential rules and tool format.
   */
  _buildCondensedReminder(mode) {
    const modeStr = mode === 'auto' ? 'AUTO MODE (safe ops auto-applied)' : 'PLAN MODE (all edits need approval)';

    return `<system_reminder>
You are Gemini Agent, an AI coding assistant. Current mode: ${modeStr}.
Workspace: \`${this.workspace}\`
Agent source: \`${this.agentSourceDir}\`

Quick rules:
- Use tools to read/edit/create files. Don't just show code.
- Tool call format: \`\`\`json {"name": "tool_name", "args": {...}} \`\`\`
- ONE response per turn. No drafts.
- Be concise. Think step by step.
</system_reminder>`;
  }

  _buildConversationHistory(history) {
    const formatted = history.map(turn => {
      const prefix = turn.role === 'user' ? 'User' : turn.role === 'agent' ? 'Agent' : 'System';

      if (turn.type === 'tool_call') {
        return `[Agent → Tool] ${turn.toolName}(${JSON.stringify(turn.args).substring(0, 200)})`;
      }
      if (turn.type === 'tool_result') {
        const resultStr = typeof turn.result === 'string'
          ? turn.result.substring(0, 500)
          : JSON.stringify(turn.result).substring(0, 500);
        return `[Tool → Agent] ${turn.toolName}: ${resultStr}${resultStr.length >= 500 ? '...' : ''}`;
      }
      if (turn.type === 'compaction_summary') {
        return `[Context Summary]\n${turn.content}`;
      }

      return `[${prefix}]: ${turn.content}`;
    });

    return `<conversation_history>\n${formatted.join('\n\n')}\n</conversation_history>`;
  }

  _loadAgentMd() {
    const agentMdPath = resolve(this.workspace, 'AGENT.md');
    if (existsSync(agentMdPath)) {
      try {
        return readFileSync(agentMdPath, 'utf-8');
      } catch {
        return null;
      }
    }
    return null;
  }

  _loadWorkspaceRules() {
    try {
      const rulesPath = resolve(this.workspace, '.gemini/rules.md');
      if (existsSync(rulesPath)) {
        return readFileSync(rulesPath, 'utf-8');
      }
    } catch (e) {
      // ignore
    }
    return '';
  }

  /**
   * Reload AGENT.md (call when file changes).
   */
  reloadAgentMd() {
    this.agentMdContent = this._loadAgentMd();
  }
}
