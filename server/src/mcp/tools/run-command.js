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
        command: finalCommand,
        cwd: workingDir,
      });
    });
  });
}
