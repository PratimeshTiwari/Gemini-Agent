/**
 * Leaving, and coming back somewhere else.
 *
 * `RESTART_EXIT_CODE` is how this process asks its supervisor (`src/index.js`)
 * to start it again. Three paths use it — `/restart`, `/workspace <path>` and
 * `/update` — and they all have to agree on two things that are easy to get
 * wrong alone: not exiting out from under a running turn, and handing the
 * choice over in a file rather than trying to rewrite their own argv.
 *
 * This lives in `core/` rather than the UI because the side panel can ask for
 * a workspace switch too, and the bridge cannot import a React hook to do it.
 */

import { writeFileSync } from 'fs';
import * as paths from './paths.js';
import { resolveWorkspaceInput, validateWorkspace } from './workspaces.js';

/** What `src/index.js` watches for. */
export const RESTART_EXIT_CODE = 75;

/** How often to look at whether the turn has finished. */
const IDLE_POLL_MS = 400;

/** Shut the bridge and the task manager, then go. */
export async function leave(code, { wsServer, agentLoop, delay = 120 } = {}) {
  await new Promise((r) => setTimeout(r, delay));
  try { await wsServer?.stop?.(); } catch { /* going anyway */ }
  try { agentLoop?.taskManager?.cleanup?.(); } catch { /* going anyway */ }
  process.exit(code);
}

/**
 * Leave, but not out from under a turn that is still running.
 *
 * Every restart path called `leave` the moment it was asked. Reported from
 * use: switching workspace mid-turn killed the process, the browser kept
 * generating into a socket nobody was holding, and the reply was never drawn.
 * "It stopped and did not output" is exactly right, and it is silent — from
 * the transcript's point of view the turn simply never finished.
 *
 * Polled rather than subscribed because `isProcessing` lives on the agent loop
 * and has no event, and a poll that is wrong costs a second of waiting where a
 * missed event is a restart that never happens.
 *
 * `ctx.exit` is a seam: `leave` ends in `process.exit`, which a test cannot
 * call. Everything up to that last step is the part worth testing.
 */
export function leaveWhenIdle(code, ctx, { announce } = {}) {
  const { agentLoop, exit = leave } = ctx;
  if (!agentLoop?.isProcessing) return exit(code, ctx);

  announce?.();
  const timer = setInterval(() => {
    if (agentLoop.isProcessing) return;
    clearInterval(timer);
    exit(code, ctx);
  }, IDLE_POLL_MS);
  timer.unref?.();
  return undefined;
}

/**
 * Check a workspace and hand it to the supervisor — everything before the exit.
 *
 * Separated from the leaving so both front-ends share one set of answers. The
 * three failure modes are all things a caller must be able to *say*, not throw:
 * a path that is not a usable directory, no supervisor to restart us, and a
 * handover file that could not be written.
 *
 * The choice goes in a file because the child cannot rewrite its own argv, and
 * `src/index.js` consumes it read-once, so a stale handover cannot silently
 * override `--workspace` on every later start.
 *
 * @returns {{ok: true, target: string} | {ok: false, error: string}}
 */
export function prepareWorkspaceSwitch(raw, { env = process.env } = {}) {
  const target = resolveWorkspaceInput(raw);
  const problem = validateWorkspace(target);
  if (problem) return { ok: false, error: problem };

  if (!env.AGENT_CLI_SUPERVISED) {
    return {
      ok: false,
      error: 'This process has no supervisor to restart it.\n\n'
        + `Quit and start again: \`agent-cli --workspace ${target}\``,
    };
  }

  try {
    writeFileSync(paths.ensureParent(paths.nextWorkspacePath()), target, 'utf8');
  } catch (err) {
    return { ok: false, error: `Could not hand over: ${err.message}` };
  }

  return { ok: true, target };
}
