/**
 * TaskManager
 *
 * Manages long-running background processes spawned by the agent.
 * Provides log buffering, status tracking, stdin input, and cleanup.
 */

import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { resolve } from 'path';

const MAX_LOG_LINES = 500; // Circular buffer size per task

export class TaskManager {
  constructor(workspace, callbacks) {
    this.workspace = workspace;
    this.callbacks = callbacks; // { onOutput, onExit }
    this.tasks = new Map(); // taskId -> TaskState
  }

  /**
   * Spawn a new background process.
   * @returns {{ taskId, command, cwd }}
   */
  spawn(command, { cwd, env } = {}) {
    const taskId = randomUUID().substring(0, 8); // Short ID for readability
    const workingDir = cwd
      ? (cwd.startsWith('/') ? cwd : resolve(this.workspace, cwd))
      : this.workspace;

    const child = spawn('sh', ['-c', command], {
      cwd: workingDir,
      env: {
        ...process.env,
        ...env,
        FORCE_COLOR: '0',
        NO_COLOR: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    });

    const task = {
      taskId,
      command,
      cwd: workingDir,
      process: child,
      pid: child.pid,
      status: 'running', // running | exited | killed
      exitCode: null,
      startedAt: Date.now(),
      endedAt: null,
      logBuffer: [], // Circular buffer of { timestamp, stream, line }
    };

    // Capture stdout
    child.stdout.on('data', (data) => {
      const lines = data.toString().split('\n').filter(l => l.length > 0);
      for (const line of lines) {
        this._appendLog(task, 'stdout', line);
      }
      if (this.callbacks?.onOutput) {
        this.callbacks.onOutput(taskId, 'stdout', data.toString());
      }
    });

    // Capture stderr
    child.stderr.on('data', (data) => {
      const lines = data.toString().split('\n').filter(l => l.length > 0);
      for (const line of lines) {
        this._appendLog(task, 'stderr', line);
      }
      if (this.callbacks?.onOutput) {
        this.callbacks.onOutput(taskId, 'stderr', data.toString());
      }
    });

    // Handle exit
    child.on('exit', (code, signal) => {
      task.status = signal ? 'killed' : 'exited';
      task.exitCode = code;
      task.endedAt = Date.now();
      this._appendLog(task, 'system', `Process exited with code ${code}${signal ? ` (signal: ${signal})` : ''}`);
      if (this.callbacks?.onExit) {
        this.callbacks.onExit(taskId, code, signal);
      }
    });

    child.on('error', (err) => {
      task.status = 'exited';
      task.exitCode = -1;
      task.endedAt = Date.now();
      this._appendLog(task, 'system', `Process error: ${err.message}`);
    });

    this.tasks.set(taskId, task);

    return { taskId, command, cwd: workingDir, pid: child.pid };
  }

  /**
   * Read the last N lines of output from a task.
   */
  readLogs(taskId, lines = 50) {
    const task = this.tasks.get(taskId);
    if (!task) return { error: `Unknown task: ${taskId}` };

    const logSlice = task.logBuffer.slice(-lines);
    return {
      taskId,
      status: task.status,
      exitCode: task.exitCode,
      lineCount: logSlice.length,
      totalLines: task.logBuffer.length,
      logs: logSlice.map(l => `[${l.stream}] ${l.line}`).join('\n'),
    };
  }

  /**
   * Send input to a running task's stdin.
   */
  sendInput(taskId, text) {
    const task = this.tasks.get(taskId);
    if (!task) return { error: `Unknown task: ${taskId}` };
    if (task.status !== 'running') return { error: `Task ${taskId} is not running (status: ${task.status})` };

    try {
      task.process.stdin.write(text + '\n');
      this._appendLog(task, 'stdin', text);
      return { success: true, message: `Sent input to task ${taskId}: "${text}"` };
    } catch (err) {
      return { error: `Failed to send input: ${err.message}` };
    }
  }

  /**
   * Kill a running task.
   */
  kill(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return { error: `Unknown task: ${taskId}` };
    if (task.status !== 'running') return { error: `Task ${taskId} is already ${task.status}` };

    try {
      task.process.kill('SIGTERM');
      // Force kill after 5 seconds if SIGTERM doesn't work
      setTimeout(() => {
        if (task.status === 'running') {
          task.process.kill('SIGKILL');
        }
      }, 5000);
      return { success: true, message: `Sent SIGTERM to task ${taskId} (PID: ${task.pid})` };
    } catch (err) {
      return { error: `Failed to kill task: ${err.message}` };
    }
  }

  /**
   * Get the status of a specific task.
   */
  getStatus(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return { error: `Unknown task: ${taskId}` };

    const elapsed = (task.endedAt || Date.now()) - task.startedAt;
    return {
      taskId: task.taskId,
      command: task.command,
      cwd: task.cwd,
      pid: task.pid,
      status: task.status,
      exitCode: task.exitCode,
      elapsedMs: elapsed,
      elapsed: this._formatDuration(elapsed),
      logLines: task.logBuffer.length,
    };
  }

  /**
   * List all tasks (running and recently exited).
   */
  listTasks() {
    const tasks = [];
    for (const [id, task] of this.tasks) {
      const elapsed = (task.endedAt || Date.now()) - task.startedAt;
      tasks.push({
        taskId: id,
        command: task.command.substring(0, 60),
        status: task.status,
        exitCode: task.exitCode,
        elapsed: this._formatDuration(elapsed),
      });
    }
    return tasks;
  }

  /**
   * Clean up all tasks (call on shutdown).
   */
  cleanup() {
    for (const [id, task] of this.tasks) {
      if (task.status === 'running') {
        try { task.process.kill('SIGKILL'); } catch {}
      }
    }
    this.tasks.clear();
  }

  // ── Private ──────────────────────────────────────────────────────

  _appendLog(task, stream, line) {
    task.logBuffer.push({
      timestamp: Date.now(),
      stream,
      line,
    });
    // Circular buffer: trim from the front if too large
    if (task.logBuffer.length > MAX_LOG_LINES) {
      task.logBuffer = task.logBuffer.slice(-MAX_LOG_LINES);
    }
  }

  _formatDuration(ms) {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    const mins = Math.floor(ms / 60000);
    const secs = Math.floor((ms % 60000) / 1000);
    return `${mins}m${secs}s`;
  }
}
