/**
 * MCP Server
 *
 * Registers all filesystem tools and handles tool invocation.
 * Uses a custom in-process transport (not stdio) since we bridge
 * through the WebSocket server to the Chrome Extension.
 */

import { searchFiles } from './tools/search-files.js';
import { grepSearch } from './tools/grep-search.js';
import { readFile } from './tools/read-file.js';
import { editFile } from './tools/edit-file.js';
import { createFile } from './tools/create-file.js';
import { listDirectory } from './tools/list-directory.js';
import { runCommand } from './tools/run-command.js';
import { openInEditor } from './tools/open-in-editor.js';
import { runBackground } from './tools/run-background.js';
import { manageTask } from './tools/manage-task.js';
import semanticSearch from './tools/semantic-search.js';
import getEditorState from './tools/get-editor-state.js';

// Tool registry with schemas
const TOOL_DEFINITIONS = [
  {
    name: 'search_files',
    description: 'Search for files by name or path pattern using fuzzy matching. Use this to find files in the codebase.',
    parameters: {
      query: { type: 'string', description: 'File name or path pattern to search for', required: true },
      maxResults: { type: 'number', description: 'Maximum number of results to return (default: 20)', required: false },
    },
    handler: searchFiles,
  },
  {
    name: 'grep_search',
    description: 'Search for text content across all files in the codebase. Like ripgrep. Use for finding code patterns, function definitions, imports, etc.',
    parameters: {
      pattern: { type: 'string', description: 'The text or regex pattern to search for', required: true },
      isRegex: { type: 'boolean', description: 'If true, treat pattern as a regex', required: false },
      includes: { type: 'array', description: 'Glob patterns to filter files (e.g., ["*.js", "*.ts"])', required: false },
      maxResults: { type: 'number', description: 'Maximum results (default: 50)', required: false },
    },
    handler: grepSearch,
  },
  {
    name: 'read_file',
    description: 'Read the contents of a file. You can optionally specify a line range to read only a portion.',
    parameters: {
      path: { type: 'string', description: 'File path (relative to workspace root or absolute)', required: true },
      startLine: { type: 'number', description: 'Start line (1-indexed, inclusive)', required: false },
      endLine: { type: 'number', description: 'End line (1-indexed, inclusive)', required: false },
    },
    handler: readFile,
  },
  {
    name: 'edit_file',
    description: 'Propose edits to an existing file. Each edit specifies old text to find and new text to replace it with. The edit will be shown as a diff for user approval before being applied.',
    parameters: {
      path: { type: 'string', description: 'File path to edit', required: true },
      edits: {
        type: 'array',
        description: 'Array of edits. Each edit has { oldText: string, newText: string }',
        required: true,
      },
    },
    handler: editFile,
  },
  {
    name: 'create_file',
    description: 'Create a new file with the specified content. Parent directories will be created automatically. The file creation will be shown for user approval.',
    parameters: {
      path: { type: 'string', description: 'File path to create', required: true },
      content: { type: 'string', description: 'File content', required: true },
    },
    handler: createFile,
  },
  {
    name: 'list_directory',
    description: 'List the contents of a directory. Shows files and subdirectories with their sizes.',
    parameters: {
      path: { type: 'string', description: 'Directory path (default: workspace root)', required: false },
      recursive: { type: 'boolean', description: 'If true, list recursively', required: false },
      maxDepth: { type: 'number', description: 'Max depth for recursive listing (default: 3)', required: false },
    },
    handler: listDirectory,
  },
  {
    name: 'run_command',
    description: 'Execute a shell command. ALWAYS requires user approval. Use for running tests, builds, installs, etc.',
    parameters: {
      command: { type: 'string', description: 'The shell command to execute', required: true },
      cwd: { type: 'string', description: 'Working directory (default: workspace root)', required: false },
      timeout: { type: 'number', description: 'Timeout in seconds (default: 30)', required: false },
    },
    handler: runCommand,
  },
  {
    name: 'open_in_editor',
    description: 'Open a file in the user\'s code editor. Use this to show plans, files for review, or navigate the user to a specific location.',
    parameters: {
      path: { type: 'string', description: 'File path to open', required: true },
      line: { type: 'number', description: 'Line number to jump to', required: false },
    },
    handler: openInEditor,
  },
  {
    name: 'run_background',
    description: 'Spawn a long-running background process (dev servers, watchers, builds). Returns immediately with a taskId. Use manage_task to interact with it.',
    parameters: {
      command: { type: 'string', description: 'The shell command to execute', required: true },
      cwd: { type: 'string', description: 'Working directory (default: workspace root)', required: false },
    },
    handler: runBackground,
  },
  {
    name: 'manage_task',
    description: 'Interact with background tasks. Actions: status (check if running), read_logs (read output), send_input (send stdin text), kill (terminate), list (show all tasks).',
    parameters: {
      action: { type: 'string', description: 'Action: status, read_logs, send_input, kill, list', required: true },
      taskId: { type: 'string', description: 'Task ID (required for all actions except list)', required: false },
      lines: { type: 'number', description: 'Number of log lines to read (default: 50)', required: false },
      input: { type: 'string', description: 'Text to send to stdin (required for send_input)', required: false },
    },
    handler: manageTask,
  },
  {
    name: semanticSearch.name,
    description: semanticSearch.description,
    parameters: semanticSearch.schema.properties,
    handler: semanticSearch.execute,
  },
  {
    name: getEditorState.name,
    description: getEditorState.description,
    parameters: getEditorState.schema.properties,
    handler: getEditorState.execute,
  },
];

export class MCPServer {
  constructor(workspace, diffEngine) {
    this.workspace = workspace;
    this.diffEngine = diffEngine;
    this.tools = new Map();

    // Register all tools
    for (const def of TOOL_DEFINITIONS) {
      this.tools.set(def.name, def);
    }
  }

  /**
   * Get all tool definitions (for prompt building).
   */
  getToolDefinitions() {
    return TOOL_DEFINITIONS.map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    }));
  }

  /**
   * Execute a tool call.
   *
   * @param {string} name - Tool name
   * @param {object} args - Tool arguments
   * @param {object} context - Execution context { workspace, diffEngine, callbacks }
   * @returns {Promise<{ success: boolean, result: any, error?: string }>}
   */
  async executeTool(name, args, context = {}) {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        success: false,
        error: `Unknown tool: ${name}. Available tools: ${[...this.tools.keys()].join(', ')}`,
      };
    }

    let retries = 0;
    let lastErr = null;

    while (retries < 3) {
      try {
        const result = await tool.handler(args, {
          workspace: this.workspace,
          diffEngine: this.diffEngine,
          ...context,
        });
        return { success: true, result };
      } catch (err) {
        lastErr = err;
        // Only retry on transient OS-level file errors
        if (['EBUSY', 'EACCES', 'EAGAIN', 'EMFILE', 'EPERM'].includes(err.code)) {
          retries++;
          // Exponential backoff: 500ms, 1000ms, 2000ms
          await new Promise(r => setTimeout(r, 250 * Math.pow(2, retries)));
          continue;
        }
        break; // Non-retriable error
      }
    }

    // Format OS errors into human-readable instructions for the LLM
    let errorMsg = lastErr.message;
    if (lastErr.code === 'EACCES' || lastErr.code === 'EPERM') {
      errorMsg = `Permission denied. The file is locked by the OS and may be open in another process. Please ask the user to close it or fix permissions.`;
    } else if (lastErr.code === 'EBUSY') {
      errorMsg = `The file is currently busy/locked by another process (like a dev server). Please try again or ask the user.`;
    } else if (lastErr.code === 'ENOENT') {
      errorMsg = `The file or directory does not exist. Double-check the path.`;
    }

    return {
      success: false,
      error: `Tool ${name} failed: ${errorMsg}`,
    };
  }

  /**
   * List available tools (for debugging / status).
   */
  listTools() {
    return [...this.tools.keys()];
  }
}
