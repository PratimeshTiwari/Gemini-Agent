/**
 * Tool: run_command
 *
 * Execute shell commands with timeout and safety guards.
 * ALWAYS requires user approval, even in Auto Mode.
 */

import { exec } from 'child_process';
import { resolve } from 'path';

const DEFAULT_TIMEOUT = 30000; // 30 seconds
const MAX_OUTPUT = 50000;      // 50KB max output

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

  return new Promise((resolveP, reject) => {
    const child = exec(command, {
      cwd: workingDir,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer
      env: {
        ...process.env,
        FORCE_COLOR: '0',  // Disable color codes
        NO_COLOR: '1',
      },
    }, (error, stdout, stderr) => {
      const truncate = (str) => {
        if (str.length > MAX_OUTPUT) {
          return str.substring(0, MAX_OUTPUT) + `\n... (truncated, ${str.length - MAX_OUTPUT} bytes omitted)`;
        }
        return str;
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
        command,
        cwd: workingDir,
      });
    });
  });
}
