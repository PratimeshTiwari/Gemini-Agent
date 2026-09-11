/**
 * Commands that failed in a VS Code terminal.
 *
 * The agent has always been able to notice a process *it* started breaking —
 * `run_background` starts one and `manage_task watch` wakes the agent when it
 * logs a failure. A terminal you opened yourself was invisible: those belong to
 * the terminal emulator and there is no API for them. Inside VS Code there now
 * is one, and the companion forwards failures here.
 *
 * Only failures, and only their tail. A passing `npm test` is not news, and a
 * full build log is tens of thousands of characters that would be typed into a
 * browser chat tab verbatim — the same reason a paste becomes a marker.
 *
 * This *offers*; it does not act. The failure arrives as a suggestion in the
 * prompt, and the user presses Enter or does not. An agent that starts editing
 * because a command you ran in another window failed is a worse tool than one
 * that waits to be asked, however clever the loop looks in a demo.
 */

import fs from 'fs';
import * as paths from '../core/paths.js';

/** Longest tail of output to carry into a prompt. */
const MAX_OUTPUT = 2000;

/** The one-line marker that goes in the input box. */
export function failureMarker(entry) {
  const first = String(entry.command || '').split('\n')[0];
  const short = first.length > 40 ? `${first.slice(0, 39)}…` : first;
  return `@terminal:${short}`;
}

/** What the model receives in place of the marker. */
export function failureBody(entry) {
  const lines = [
    `A command failed in the editor's terminal (exit ${entry.exitCode}):`,
    '```',
    `$ ${entry.command}`,
    String(entry.output || '').slice(-MAX_OUTPUT).trimEnd() || '(no output captured)',
    '```',
  ];
  if (entry.cwd) lines.splice(1, 0, `Working directory: ${entry.cwd}`);
  return lines.join('\n');
}

/**
 * Read and clear the queue.
 *
 * Cleared on read so a failure is offered once. The file is removed rather than
 * truncated, because the companion appends and truncating races with it.
 *
 * @returns {Array<{marker: string, text: string, command: string, exitCode: number}>}
 */
export function drainTerminalQueue(workspace) {
  const file = paths.terminalQueuePath(workspace);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return []; // nothing queued is the normal case
  }

  try {
    fs.unlinkSync(file);
  } catch {
    /* it will be re-read next tick; harmless */
  }

  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a half-written line from an append in flight
    }
    if (!entry?.command || !entry.exitCode) continue;
    out.push({
      marker: failureMarker(entry),
      text: failureBody(entry),
      command: entry.command,
      exitCode: entry.exitCode,
    });
  }

  // Only the last few: a broken watcher can fail every second, and a hundred
  // markers in the input box is not a useful thing to hand anyone.
  return out.slice(-3);
}
