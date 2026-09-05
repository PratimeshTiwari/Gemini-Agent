/**
 * Risk Classifier
 *
 * Classifies MCP tool calls as safe or risky for Auto Mode.
 * Safe operations execute immediately; risky ones require user approval.
 */

import fs from 'fs';
import { configPath as configPathFor } from './paths.js';
import path from 'path';

// Files that are always considered high-risk to modify
const SENSITIVE_FILE_PATTERNS = [
  /package\.json$/,
  /package-lock\.json$/,
  /yarn\.lock$/,
  /\.env/,
  /\.gitignore$/,
  /tsconfig\.json$/,
  /webpack\.config/,
  /vite\.config/,
  /next\.config/,
  /docker/i,
  /\.github\//,
  /ci\//,
  /deploy/i,
];

export class RiskClassifier {
  constructor(workspacePath) {
    this.workspacePath = workspacePath;
    this.overrides = new Map(); // tool_name -> 'safe' | 'risky'
  }

  /**
   * Classify a tool call as 'safe' or 'risky'.
   *
   * @param {string} toolName - The MCP tool being called
   * @param {object} args - The tool's arguments
   * @returns {{ level: 'safe' | 'risky', reason: string }}
   */
  classify(toolName, args) {
    // Check overrides first
    if (this.overrides.has(toolName)) {
      const level = this.overrides.get(toolName);
      return { level, reason: 'User override' };
    }

    switch (toolName) {
      // Always safe — read-only operations
      case 'search_files':
      case 'grep_search':
      case 'read_file':
      case 'list_directory':
        return { level: 'safe', reason: 'Read-only operation' };

      // Always safe — opening files in editor
      case 'open_in_editor':
        return { level: 'safe', reason: 'Opens file in editor (no modifications)' };

      // Conditional — shell commands
      case 'run_command':
        return this._classifyCommand(args);

      // Conditional — file creation
      case 'create_file':
        return this._classifyCreate(args);

      // Conditional — file editing
      case 'edit_file':
        return this._classifyEdit(args);

      default:
        return { level: 'risky', reason: 'Unknown tool' };
    }
  }

  _classifyCreate(args) {
    const { path: filePath } = args;

    // Check if overwriting an existing file
    if (args.overwrite) {
      return { level: 'risky', reason: 'Overwrites existing file' };
    }

    // Check if it's a sensitive file
    if (this._isSensitiveFile(filePath)) {
      return { level: 'risky', reason: `Sensitive file: ${filePath}` };
    }

    return { level: 'safe', reason: 'New file creation (non-sensitive)' };
  }

  _classifyEdit(args) {
    const { path: filePath, edits } = args;

    // Sensitive files always risky
    if (this._isSensitiveFile(filePath)) {
      return { level: 'risky', reason: `Sensitive file: ${filePath}` };
    }

    // Check edit size
    if (edits && Array.isArray(edits)) {
      let totalDeletedLines = 0;
      let totalAddedLines = 0;

      for (const edit of edits) {
        if (edit.oldText) {
          totalDeletedLines += (edit.oldText.match(/\n/g) || []).length + 1;
        }
        if (edit.newText) {
          totalAddedLines += (edit.newText.match(/\n/g) || []).length + 1;
        }
      }

      // Large deletions are risky
      if (totalDeletedLines > 20) {
        return { level: 'risky', reason: `Large deletion: ${totalDeletedLines} lines removed` };
      }

      // Large rewrites are risky (significant deletion + addition)
      if (totalDeletedLines > 10 && totalAddedLines > 10) {
        return { level: 'risky', reason: `Large rewrite: ${totalDeletedLines} lines removed, ${totalAddedLines} added` };
      }

      // Addition-only edits on non-sensitive files are safe
      if (totalDeletedLines === 0 && totalAddedLines > 0) {
        return { level: 'safe', reason: 'Addition-only edit' };
      }

      // Small modifications are safe
      if (totalDeletedLines <= 20) {
        return { level: 'safe', reason: `Small edit: ${totalDeletedLines} lines changed` };
      }
    }

    // Default to risky for unknown patterns
    return { level: 'risky', reason: 'Could not determine edit safety' };
  }

  _isSensitiveFile(filePath) {
    return SENSITIVE_FILE_PATTERNS.some(pattern => pattern.test(filePath));
  }

  _classifyCommand(args) {
    const { command, cwd } = args;
    if (!command) return { level: 'risky', reason: 'Empty command' };

    const cmdStr = command.trim();
    const binary = cmdStr.split(/\s+/)[0].toLowerCase();
    
    // Read-only commands
    const safeBinaries = ['ls', 'cat', 'grep', 'find', 'echo', 'pwd', 'whoami', 'head', 'tail', 'less', 'more', 'rg', 'ag', 'awk', 'sed'];
    // sed can mutate if it uses -i, but usually in a pipeline it's read-only. Let's be stricter.
    const strictSafeBinaries = ['ls', 'cat', 'grep', 'find', 'echo', 'pwd', 'whoami', 'head', 'tail', 'less', 'more', 'rg', 'ag'];

    if (strictSafeBinaries.includes(binary)) {
      return { level: 'safe', reason: 'Read-only shell command' };
    }

    if (binary === 'git') {
      const gitSubcommand = cmdStr.split(/\s+/)[1]?.toLowerCase();
      const safeGit = ['status', 'log', 'diff', 'show', 'branch', 'remote'];
      if (safeGit.includes(gitSubcommand)) {
        return { level: 'safe', reason: 'Read-only git command' };
      }
    }

    // Mutating commands need directory scoping check
    const execCwd = cwd || this.workspacePath;
    const isInsideWorkspace = execCwd.startsWith(this.workspacePath);

    if (!isInsideWorkspace) {
      // Check whitelist from .gemini/config.json
      if (this._isAllowedGlobal(cmdStr)) {
        return { level: 'risky', reason: 'Allowed global mutating command' };
      }
      return { level: 'critical', reason: 'Global system modification outside workspace' };
    }

    return { level: 'risky', reason: 'Mutating shell command within workspace' };
  }

  _isAllowedGlobal(cmdStr) {
    if (!this.workspacePath) return false;
    
    const configPath = configPathFor(this.workspacePath);
    
    if (fs.existsSync(configPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (config.allowedGlobal && Array.isArray(config.allowedGlobal)) {
          return config.allowedGlobal.some(allowedCmd => cmdStr.startsWith(allowedCmd));
        }
      } catch (e) {
        // Ignore JSON parse errors
      }
    }
    return false;
  }

  /**
   * Override classification for a specific tool.
   */
  setOverride(toolName, level) {
    this.overrides.set(toolName, level);
  }

  /**
   * Remove an override.
   */
  removeOverride(toolName) {
    this.overrides.delete(toolName);
  }
}
