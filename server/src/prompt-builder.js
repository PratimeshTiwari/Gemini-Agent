/**
 * Prompt Builder
 *
 * Constructs the system prompt with tool definitions, workspace context,
 * and conversation history. Manages what gets injected into each Gemini interaction.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, relative } from 'path';

export class PromptBuilder {
  constructor(workspace) {
    this.workspace = workspace;
    this.agentMdContent = this._loadAgentMd();
  }

  /**
   * Build the full system prompt for a Gemini interaction.
   *
   * @param {object} options
   * @param {string} options.userMessage - The user's current message
   * @param {Array} options.conversationHistory - Previous turns
   * @param {string} options.workspaceSummary - Workspace overview
   * @param {string} options.mode - 'plan' or 'auto'
   * @returns {string} The complete prompt to inject
   */
  buildPrompt({ userMessage, conversationHistory = [], workspaceSummary = '', mode = 'plan' }) {
    const parts = [];

    // System instructions and tools (always sent to ensure Gemini never loses context)
    parts.push(this._buildSystemInstructions(mode));
    parts.push(this._buildToolDefinitions());

    // Workspace context and AGENT.md
    if (workspaceSummary) {
      parts.push(`<workspace_context>\n${workspaceSummary}\n</workspace_context>`);
    }
    if (this.agentMdContent) {
      parts.push(`<agent_instructions>\n${this.agentMdContent}\n</agent_instructions>`);
    }

    // Conversation history
    if (conversationHistory.length > 0) {
      parts.push(this._buildConversationHistory(conversationHistory));
    }

    // Current user message
    parts.push(`<user_message>\n${userMessage}\n</user_message>`);
    
    // Explicitly demand a single response (prevents A/B test modals)
    parts.push(`\n**IMPORTANT**: You must provide exactly ONE response. Do NOT provide multiple drafts, and do NOT ask the user to choose between options. Just execute the tools or provide your final answer.`);

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

  _buildSystemInstructions(mode) {
    const modeInstructions = mode === 'auto'
      ? 'You are in AUTO MODE. Safe operations (reads, searches, small additions) will be auto-applied. Risky operations (large rewrites, deletions, commands) will still require user approval.'
      : 'You are in PLAN MODE. All file modifications and command executions require user approval before being applied.';

    return `<system>
You are Gemini Agent, an expert AI coding assistant operating on the user's local filesystem.
You are similar to Claude Code — a powerful agentic coding tool.

${modeInstructions}

## Core Behavior
- You have access to tools that let you search, read, edit, and create files in the user's workspace.
- When asked to make changes, ALWAYS use the edit_file or create_file tools. Never just show code in your response.
- When planning complex changes, always save your plans or scratchpad files inside a \`.gemini/\` folder (e.g., \`.gemini/plan.md\`) to avoid cluttering the user's root project directory.
- Think step by step. Read relevant files before making edits.
- If a user's request is ambiguous or underspecified, ASK clarifying questions before creating plans or executing tools!
- Be concise in your responses. Show what you're doing, but don't over-explain.
- **CRITICAL**: Never output multiple drafts. Provide a single, definitive answer.

## Tool Call Format
When you need to use a tool, output a markdown JSON code block like this:

\`\`\`json
{"name": "tool_name", "args": {"param1": "value1", "param2": "value2"}}
\`\`\`

You can make MULTIPLE tool calls in a single response. Each must be in its own \`\`\`json block.
After tool results are provided, continue your work or respond to the user.

## Response Guidelines
- Show your reasoning briefly before tool calls
- After getting tool results, analyze them and decide next steps
- When proposing edits, explain WHAT you're changing and WHY
- If a task is complex, break it into steps and work through them
- Use the open_in_editor tool to show plans, important files, or results to the user
</system>`;
  }

  _buildToolDefinitions() {
    return `<available_tools>
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
</available_tools>`;
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

  /**
   * Reload AGENT.md (call when file changes).
   */
  reloadAgentMd() {
    this.agentMdContent = this._loadAgentMd();
  }
}
