/**
 * Selections the user sent over from the editor with "Add to Agent Chat".
 *
 * The companion appends one JSON object per line to
 * `.agent/state/chat-queue.jsonl`; the CLI drains it and turns each entry into
 * an attachment on the prompt. A file rather than a socket because that is how
 * every other companion channel already works (editor state, plan approval),
 * and because it survives the CLI not being running yet — you can send a
 * selection before you have started the agent and it is waiting for you.
 *
 * Each entry becomes a marker in the prompt (`@src/app.js:12-40`) that expands
 * to the real text on submit, exactly like a pasted block. That is what keeps a
 * 400-line selection from blowing the live frame — see ui/paste.js.
 */

import fs from 'fs';
import * as paths from '../core/paths.js';

/** How the attachment shows up in the prompt. Short, and unmistakably a reference. */
export function selectionMarker(entry) {
  const name = String(entry.file || 'selection').split('/').pop();
  const range = entry.startLine === entry.endLine
    ? `${entry.startLine}`
    : `${entry.startLine}-${entry.endLine}`;
  return `@${name}:${range}`;
}

/** What the model receives in place of the marker. */
export function selectionBody(entry) {
  const fence = entry.language ? `\`\`\`${entry.language}` : '```';
  return [
    `${entry.file} (lines ${entry.startLine}-${entry.endLine}):`,
    fence,
    entry.text ?? '',
    '```',
  ].join('\n');
}

/**
 * Read and clear the queue.
 *
 * Cleared on read so a selection is attached once. The file is removed rather
 * than truncated: the companion appends, and truncating races with it.
 *
 * @returns {Array<{marker: string, text: string, file: string}>}
 */
export function drainChatQueue(workspace) {
  const file = paths.chatQueuePath(workspace);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return []; // nothing queued is the normal case
  }

  try {
    fs.unlinkSync(file);
  } catch {
    /* it will be re-read next tick if this failed; harmless */
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
    if (!entry?.text) continue;
    out.push({
      marker: selectionMarker(entry),
      text: selectionBody(entry),
      file: entry.file,
    });
  }
  return out;
}
