/**
 * Tool: run_background
 *
 * Spawn a long-running background process (like dev servers, watchers, builds).
 * Returns immediately with a taskId that can be used with manage_task.
 */

export async function runBackground(args, context) {
  const { command, cwd } = args;
  const { taskManager, workspace } = context;

  if (!command || command.trim().length === 0) {
    throw new Error('Command cannot be empty');
  }

  if (!taskManager) {
    throw new Error('TaskManager not available');
  }

  const result = taskManager.spawn(command, { cwd });

  return {
    taskId: result.taskId,
    command: result.command,
    cwd: result.cwd,
    pid: result.pid,
    message: `Background task started with ID: ${result.taskId}. Use manage_task to check status, read logs, send input, or kill it.`,
  };
}
