/**
 * Risk Classifier
 *
 * Classifies MCP tool calls as safe or risky for Auto Mode.
 * Safe operations execute immediately; risky ones require user approval.
 */

import fs from 'fs';
import { configPath as configPathFor } from './paths.js';
import path from 'path';
import os from 'os';
import { splitCommands, binaryOf, redirectTargets } from './shell-split.js';

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

/** Ordering, so the worst segment of a command line can win. */
const RANK = { safe: 0, risky: 1, critical: 2 };

/**
 * Binaries that cannot change anything on their own.
 *
 * `sed` and `awk` are deliberately absent: `sed -i` edits in place and `awk`
 * can open files for writing, and neither is visible in the first word.
 */
const READ_ONLY_BINARIES = new Set([
  'ls', 'cat', 'grep', 'find', 'echo', 'pwd', 'whoami', 'head', 'tail',
  'less', 'more', 'rg', 'ag', 'wc', 'file', 'stat', 'dirname', 'basename',
  'which', 'type', 'date', 'env', 'printenv', 'uname', 'df', 'du', 'tree', 'sleep', 'true', 'false',
]);

/** `find` actions that turn a search into arbitrary execution. */
const FIND_EXECUTES = /(^|\s)-(exec|execdir|ok|okdir|delete|fprint\w*)(\s|$)/;

const READ_ONLY_GIT = new Set([
  'status', 'log', 'diff', 'show', 'branch', 'remote', 'blame', 'describe',
  'rev-parse', 'rev-list', 'ls-files', 'ls-remote', 'shortlog', 'config',
]);

/** Never auto-approved, wherever they run. */
const PRIVILEGE_BINARIES = new Set(['sudo', 'su', 'doas', 'pkexec', 'runas']);

/** Keep a reason readable when it quotes the offending segment. */
const truncate = (text, max = 60) => {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

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

  /**
   * How risky is a shell command?
   *
   * The whole command line, not its first word. This used to read
   * `command.split(/\s+/)[0]`, so `echo hi; rm -rf /tmp/x` was an `echo` and
   * auto mode ran it without asking. Every operator was invisible: `;`, `&&`,
   * `||`, a pipe, a redirection, a `$(…)`. See core/shell-split.js.
   *
   * Every segment is classified and the **worst one wins**. A command line is
   * exactly as safe as its most dangerous part, and there is no useful sense in
   * which `grep x . || npm publish` is a read-only grep.
   */
  _classifyCommand(args) {
    const { command, cwd } = args;
    if (!command || !String(command).trim()) return { level: 'risky', reason: 'Empty command' };

    const segments = splitCommands(command);
    if (segments.length === 0) return { level: 'risky', reason: 'Empty command' };

    const verdicts = segments.map((segment) => this._classifySegment(segment, cwd));
    const rank = Math.max(...verdicts.map((v) => RANK[v.level]));
    const level = Object.keys(RANK).find((k) => RANK[k] === rank);
    if (level === 'safe') return { level, reason: 'Read-only shell command' };

    // Name the parts that are actually the problem — all of them at the worst
    // level, not just the first one found. Reporting the first meant
    // `sleep 1 & rm -rf /tmp/x` blamed `sleep 1`, which reads as harmless and
    // sends the user looking in the wrong place.
    const blamed = verdicts.filter((v) => RANK[v.level] === rank);
    const reason = blamed[0].reason;
    if (segments.length === 1) return { level, reason };

    const quoted = blamed.slice(0, 2).map((v) => `\`${truncate(v.segment, 40)}\``).join(', ');
    const more = blamed.length > 2 ? `, +${blamed.length - 2} more` : '';
    return { level, reason: `${reason} — ${quoted}${more}` };
  }

  /** One command, already separated from its neighbours. */
  _classifySegment(segment, cwd) {
    const binary = binaryOf(segment);
    const tag = (level, reason) => ({ level, reason, segment });

    // Privilege escalation is never auto-approved, wherever it runs.
    if (PRIVILEGE_BINARIES.has(binary)) {
      return tag('critical', `Runs as another user (\`${binary}\`)`);
    }

    // A read-only binary writing through a redirection is not read-only.
    // `cat key.pub > ~/.ssh/authorized_keys` is a `cat` to anything that only
    // looks at the first word.
    // `redirectTargets`, not "has a redirection": `2>&1` duplicates a file
    // descriptor and writes nothing, and `< input` reads. Only a named output
    // target turns a read-only binary into a writer.
    const targets = redirectTargets(segment);
    if (targets.length > 0) {
      // Where it writes decides how bad it is. The cwd says nothing here:
      // `cat key > ~/.ssh/authorized_keys` runs perfectly happily from inside
      // the workspace.
      const outside = targets.find((t) => !this._insideWorkspace(t));
      if (outside) {
        return tag('critical', `Writes outside the workspace (\`${truncate(outside, 40)}\`)`);
      }
      return this._scopedMutation(segment, cwd, 'Redirects output to a file');
    }

    if (READ_ONLY_BINARIES.has(binary)) {
      // `find` is read-only right up until the flag that makes it not.
      if (binary === 'find' && FIND_EXECUTES.test(segment)) {
        return this._scopedMutation(segment, cwd, '`find` with an executing or deleting action');
      }
      return tag('safe', 'Read-only shell command');
    }

    if (binary === 'git') {
      const sub = segment.trim().split(/\s+/)[1]?.toLowerCase();
      if (READ_ONLY_GIT.has(sub)) return tag('safe', 'Read-only git command');
    }

    return this._scopedMutation(segment, cwd, 'Mutating shell command');
  }

  /**
   * A mutation is worse outside the workspace than inside it.
   *
   * Inside, the diff engine's backups and `/undo` are a safety net. Outside,
   * nothing is, so it is `critical` unless the user has said otherwise.
   */
  _scopedMutation(segment, cwd, reason) {
    const execCwd = cwd || this.workspacePath;
    const inside = this.workspacePath && String(execCwd).startsWith(this.workspacePath);

    if (!inside) {
      if (this._isAllowedGlobal(segment)) {
        return { level: 'risky', reason: `${reason} (allowed outside the workspace)`, segment };
      }
      return { level: 'critical', reason: `${reason}, outside the workspace`, segment };
    }
    return { level: 'risky', reason, segment };
  }

  /**
   * Is this path inside the workspace?
   *
   * `~` is expanded because a redirection to `~/.bashrc` is exactly the case
   * this exists to catch, and the shell would have expanded it before the file
   * was ever opened.
   */
  _insideWorkspace(target) {
    if (!this.workspacePath) return false;
    const expanded = target.startsWith('~')
      ? path.join(os.homedir(), target.slice(1))
      : target;
    const abs = path.resolve(this.workspacePath, expanded);
    const root = path.resolve(this.workspacePath);
    return abs === root || abs.startsWith(`${root}${path.sep}`);
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
