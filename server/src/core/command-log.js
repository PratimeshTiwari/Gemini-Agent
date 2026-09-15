/**
 * Every shell command the agent ran, kept for the person whose machine it is.
 *
 * Nothing reads this back into a prompt and nothing acts on it. It exists so
 * that "what has this thing actually been doing on my computer?" has an answer
 * that is not "scroll up", and so that the answer survives the session.
 *
 * It is not covered by anything already here:
 *
 *  - `errors.jsonl` records *failures*, by flow. A command that succeeded is
 *    invisible to it, and a command that succeeded is exactly what you want to
 *    audit — `git push --force` does not fail.
 *  - `sessions/history.jsonl` has the tool calls mixed into the conversation,
 *    and `/compact` replaces older turns with a summary. The record you would
 *    want six weeks from now is the first thing compaction throws away.
 *
 * One file per day (`logs/commands/2026-09-11.jsonl`), because that is how
 * people look for this: "what did it do on Tuesday". Append-only, and it never
 * throws — a failure to write the audit log must not fail the command, and must
 * certainly not fail the turn.
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import * as paths from './paths.js';

/** One id per process, so a day's file can be read back session by session. */
const SESSION_ID = randomUUID().slice(0, 8);

/** `2026-09-11`, in local time — the day the user would look under. */
export function dayStamp(when = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
}

export const commandLogDir = (workspace) => path.join(paths.logsDir(workspace), 'commands');
export const commandLogPath = (workspace, day = dayStamp()) =>
  path.join(commandLogDir(workspace), `${day}.jsonl`);

/**
 * Record one command.
 *
 * @param {string} workspace
 * @param {object} entry
 * @param {string} entry.command
 * @param {string} [entry.cwd]
 * @param {'ran'|'blocked'|'rejected'} entry.outcome  what happened to it
 * @param {string} [entry.reason]   why, when it did not run
 * @param {string} [entry.risk]     how the classifier rated it
 * @param {number} [entry.exitCode]
 */
export function logCommand(workspace, entry) {
  try {
    const file = commandLogPath(workspace);
    paths.ensureParent(file);
    fs.appendFileSync(file, `${JSON.stringify({
      at: new Date().toISOString(),
      session: SESSION_ID,
      ...entry,
    })}\n`);
  } catch {
    /* the audit log must never be the reason a command fails */
  }
}

/** Days that have a log, newest first. */
export function listCommandDays(workspace) {
  try {
    return fs.readdirSync(commandLogDir(workspace))
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => f.replace(/\.jsonl$/, ''))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/**
 * One day's commands, oldest first — the order they were run in.
 *
 * @returns {Array<{at: string, session: string, command: string, outcome: string}>}
 */
export function readCommands(workspace, day = dayStamp()) {
  let raw;
  try {
    raw = fs.readFileSync(commandLogPath(workspace, day), 'utf8');
  } catch {
    return [];
  }

  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry?.command) out.push(entry);
    } catch {
      /* a half-written line from an append in flight */
    }
  }
  return out;
}

/** How many ran today, for the settings page. */
export function countToday(workspace) {
  return readCommands(workspace).length;
}
