/**
 * Tool: manage_task
 *
 * Interact with background tasks spawned by run_background.
 * Supports: status, read_logs, send_input, kill, list, watch, unwatch
 */

export async function manageTask(args, context) {
  const { action, taskId, lines, input, pattern } = args;
  const { taskManager, onTaskAlert } = context;

  if (!taskManager) {
    throw new Error('TaskManager not available');
  }

  switch (action) {
    case 'status':
      if (!taskId) throw new Error('taskId is required for status action');
      return taskManager.getStatus(taskId);

    case 'read_logs':
      if (!taskId) throw new Error('taskId is required for read_logs action');
      return taskManager.readLogs(taskId, lines || 50);

    case 'send_input':
      if (!taskId) throw new Error('taskId is required for send_input action');
      if (!input && input !== '') throw new Error('input is required for send_input action');
      return taskManager.sendInput(taskId, input);

    case 'kill':
      if (!taskId) throw new Error('taskId is required for kill action');
      return taskManager.kill(taskId);

    case 'watch': {
      if (!taskId) throw new Error('taskId is required for watch action');
      if (!onTaskAlert) {
        throw new Error('Watching is not available in this context (no agent loop to wake).');
      }
      // The whole point of a watch is that nobody is polling: the agent has
      // finished its turn and the process keeps running. The alert re-enters
      // the loop with the failing lines already in hand.
      return taskManager.watch(taskId, pattern, onTaskAlert);
    }

    case 'unwatch':
      if (!taskId) throw new Error('taskId is required for unwatch action');
      return taskManager.unwatch(taskId);

    case 'list':
      return { tasks: taskManager.listTasks() };

    default:
      throw new Error(`Unknown action: "${action}". Valid actions: status, read_logs, send_input, kill, list, watch, unwatch`);
  }
}
