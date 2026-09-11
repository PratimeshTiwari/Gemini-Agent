/**
 * Tool: run_command
 *
 * Execute shell commands with timeout and safety guards.
 * ALWAYS requires user approval, even in Auto Mode.
 */

import { exec } from 'child_process';
import { configPath as configPathFor } from '../../core/paths.js';
import { resolve } from 'path';

const DEFAULT_TIMEOUT = 30000; // 30 seconds
const MAX_OUTPUT = 50000;      // 50KB max output

/**
 * Environment for a command with nobody sitting in front of it.
 *
 * The agent has no terminal to offer, so anything that tries to interact has to
 * be told to fail instead of wait. On a corporate machine `git show` or
 * `git diff` routinely wants a credential helper, a GPG passphrase or a pager —
 * each of which blocks on a tty that does not exist, so the command burned the
 * whole 30s timeout and came back empty. `GIT_TERMINAL_PROMPT=0` turns that into
 * an immediate, readable error the model can act on.
 */
const NON_INTERACTIVE_ENV = {
  FORCE_COLOR: '0',
  NO_COLOR: '1',
  TERM: 'dumb',
  // Pagers block forever on a pipe when they are forced on (delta, `less -X`,
  // and most dotfile managers force them).
  PAGER: 'cat',
  GIT_PAGER: 'cat',
  // Fail instead of prompting for credentials or a passphrase.
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '',
  SSH_ASKPASS: '',
  GCM_INTERACTIVE: 'never',
  // Don't take the index lock just to report status; it fights the user's editor.
  GIT_OPTIONAL_LOCKS: '0',
  // `sh -c` is non-interactive, but bash still sources $BASH_ENV/$ENV when it
  // is set — which is how a work machine's rc noise ended up in tool output.
  BASH_ENV: '',
  ENV: '',
  DEBIAN_FRONTEND: 'noninteractive',
};

/**
 * Strip ANSI escapes from captured output.
 *
 * NO_COLOR and FORCE_COLOR cover most tools, but not all of them honour either,
 * and a stray `ESC[1;32m` in a tool result is both unreadable in the transcript
 * and wasted tokens in the next prompt.
 */
// eslint-disable-next-line no-control-regex
const ANSI = /[\u001B\u009B][[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007|(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~])/g;
export const stripAnsi = (text) => String(text ?? '').replace(ANSI, '');

export async function runCommand(args, context) {
  const { command, cwd, timeout = 30 } = args;
  const { workspace } = context;

  if (!command || command.trim().length === 0) {
    throw new Error('Command cannot be empty');
  }

  const workingDir = cwd
    ? (cwd.startsWith('/') ? cwd : resolve(workspace, cwd))
    : workspace;

  const timeoutMs = Math.min(timeout * 1000, 120000); // Max 2 minutes

  // Load config to check if sandboxing is enabled
  let useSandbox = false;
  try {
    const fs = await import('fs');
    const path = await import('path');
    const configPath = configPathFor(workspace);
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (config.useDockerSandbox) useSandbox = true;
    }
  } catch (e) {}

  let finalCommand = command;
  if (useSandbox) {
    // Escape single quotes for the sh -c argument
    const escapedCmd = command.replace(/'/g, "'\\''");
    finalCommand = `docker run --rm -v "${workspace}:/workspace" -w "${workingDir.replace(workspace, '/workspace')}" node:20-alpine sh -c '${escapedCmd}'`;
  }

  return new Promise((resolveP, reject) => {
    const child = exec(finalCommand, {
      cwd: workingDir,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer
      env: { ...process.env, ...NON_INTERACTIVE_ENV },
    }, (error, stdout, stderr) => {
      const truncate = (str) => {
        const clean = stripAnsi(str);
        if (clean.length > MAX_OUTPUT) {
          return clean.substring(0, MAX_OUTPUT) + `\n... (truncated, ${clean.length - MAX_OUTPUT} bytes omitted)`;
        }
        return clean;
      };

      if (error && error.killed) {
        resolveP({
          exitCode: -1,
          stdout: truncate(stdout || ''),
          stderr: truncate(stderr || ''),
          timedOut: true,
          message: `Command timed out after ${timeout}s`,
        });
        return;
      }

      resolveP({
        exitCode: error ? error.code || 1 : 0,
        stdout: truncate(stdout || ''),
        stderr: truncate(stderr || ''),
        timedOut: false,
        command: finalCommand,
        cwd: workingDir,
      });
    });

    // Close stdin at once. `exec` hands the child an open pipe that nothing
    // ever writes to, so anything reading stdin — `read`, an interactive
    // prompt, a credential helper — waited out the full timeout and returned
    // nothing. An immediate EOF makes those fail in milliseconds with a message
    // worth showing.
    child.stdin?.end();
  });
}
