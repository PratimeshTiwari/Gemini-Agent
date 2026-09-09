/**
 * Where things break, written down.
 *
 * Failures in this agent are spread across processes that cannot see each
 * other: a content script in a Chrome tab, the WebSocket bridge, the agent
 * loop, the MCP tools, the GitHub poller, background tasks. When something goes
 * wrong the symptom usually surfaces somewhere far from the cause — a dead turn
 * in the terminal for a selector that changed in the tab, an empty PR plan for
 * an expired token — and until now none of it was recorded anywhere. The
 * console was the only sink, and console output inside an Ink app is destroyed
 * by the next repaint.
 *
 * So: one JSONL file per workspace, one line per failure, tagged with the flow
 * it came from. Greppable, and `/logs` reads it back grouped by flow, which is
 * the question actually being asked — "what is breaking?"
 *
 * Two rules this module holds to:
 *   - It never throws. An error logger that can fail is worse than none, and
 *     every caller is already on a failure path.
 *   - It collapses repeats. A poller failing every tick, or a crash loop,
 *     would otherwise bury everything else — the 401-per-interval bug wrote the
 *     same line hundreds of times.
 */

import fs from 'fs';
import path from 'path';
import * as paths from './paths.js';

/** The flows a failure can belong to. Keep this list short enough to scan. */
export const FLOWS = {
  bridge: 'WebSocket bridge to the browser',
  extension: 'Chrome extension / content script',
  agent: 'Agent loop, prompts and responses',
  tool: 'MCP tool execution',
  github: 'GitHub PR agent',
  task: 'Background tasks',
  diff: 'Edits and diff approval',
  context: 'Indexing, memory and context',
  ui: 'Terminal UI',
};

const MAX_BYTES = 512 * 1024;   // rotate past this; one previous file is kept
const MAX_DETAIL = 2000;        // a stack trace is useful, a core dump is not
const REPEAT_WINDOW_MS = 60000; // identical failures inside this collapse

/**
 * Repeats being counted rather than written, keyed by workspace + signature.
 *
 * Holding the count in memory alone would lose it: a failure that repeats 500
 * times and then stops would show as a single line, and the number — the most
 * useful part — would never reach disk. So pending counts are flushed once
 * their window expires, and `summarizeErrors` adds whatever is still pending.
 */
const recent = new Map();

function appendRecord(file, record) {
  paths.ensureParent(file);
  rotate(file);
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
}

/**
 * Write out the tally for any signature whose window has closed.
 *
 * Called on every log write, which is the only clock this module has. A
 * failure that stops recurring gets its count recorded the next time anything
 * else fails; if nothing else ever fails, `summarizeErrors` still counts it
 * from memory.
 */
function flushExpired(now) {
  for (const [key, state] of recent) {
    if (now - state.at < REPEAT_WINDOW_MS) continue;
    if (state.count > 0) {
      try {
        appendRecord(paths.errorLogPath(state.workspace), {
          time: new Date(state.at).toISOString(),
          flow: state.flow,
          op: state.op,
          message: state.message,
          // A tally line stands for repeats only — it is not itself another
          // occurrence. Counting it as one is how a storm of 12 read as 13.
          tally: true,
          repeatedSince: state.count,
        });
      } catch {
        /* the next flush will try again */
      }
    }
    recent.delete(key);
  }
}

const truncate = (value, max = MAX_DETAIL) => {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === 'string' ? value : (() => {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  })();
  return text.length > max ? `${text.slice(0, max)}… [+${text.length - max} chars]` : text;
};

function rotate(file) {
  try {
    if (fs.statSync(file).size < MAX_BYTES) return;
    fs.renameSync(file, `${file.replace(/\.jsonl$/, '')}.1.jsonl`);
  } catch {
    /* no file yet, or the rename raced another write */
  }
}

/**
 * Record a failure.
 *
 * @param {string} workspace
 * @param {object} entry
 * @param {keyof FLOWS} entry.flow - which part of the system failed
 * @param {string} entry.op - the operation, e.g. 'inject_prompt', 'poll'
 * @param {string} entry.message - one line, the thing that went wrong
 * @param {any} [entry.detail] - stack, payload, whatever helps
 * @param {object} [entry.meta] - small structured extras (taskId, prNumber…)
 * @returns {object|null} the entry written, or null if it was a collapsed repeat
 */
export function logError(workspace, entry) {
  try {
    if (!workspace || !entry?.flow || !entry?.message) return null;

    const now = Date.now();
    flushExpired(now);

    const message = String(entry.message).split('\n')[0].slice(0, 400);
    const op = entry.op || null;
    // Keyed by workspace too: one process can serve more than one.
    const key = `${workspace}\u0000${entry.flow}\u0000${op}\u0000${message}`;

    const previous = recent.get(key);
    if (previous && now - previous.at < REPEAT_WINDOW_MS) {
      previous.count++;
      previous.at = now;
      return null; // collapsed; the tally is written when the window closes
    }

    recent.set(key, { at: now, count: 0, workspace, flow: entry.flow, op, message });

    const record = {
      time: new Date(now).toISOString(),
      flow: entry.flow,
      op,
      message,
      detail: truncate(entry.detail),
      meta: entry.meta,
    };

    appendRecord(paths.errorLogPath(workspace), record);
    return record;
  } catch {
    return null; // logging must never be the thing that breaks
  }
}

/** A logger bound to one workspace and flow, for call sites that log a lot. */
export function flowLogger(workspace, flow) {
  return (op, message, detail, meta) => logError(workspace, { flow, op, message, detail, meta });
}

/**
 * Read recent failures, newest first.
 * @param {{ flow?: string, limit?: number }} [options]
 */
export function readErrors(workspace, { flow, limit = 50 } = {}) {
  const out = [];
  for (const file of [paths.errorLogPath(workspace), paths.errorLogPath(workspace).replace(/\.jsonl$/, '.1.jsonl')]) {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (flow && record.flow !== flow) continue;
        out.push(record);
      } catch {
        /* a truncated final line from a write in flight */
      }
    }
    if (out.length >= limit) break;
  }
  return out.reverse().slice(0, limit);
}

/**
 * What is breaking, by flow — the question `/logs` is actually answering.
 * @returns {{ total: number, since: string|null, byFlow: Array<{flow, label, count, last, lastMessage}> }}
 */
export function summarizeErrors(workspace) {
  // Two sources, one accounting. Lines on disk each stand for themselves plus
  // any tally already written onto them; entries still inside their collapse
  // window have not reached disk at all and stand only for their repeat count.
  // Getting this wrong double-counts the first occurrence of every storm.
  const onDisk = readErrors(workspace, { limit: 1000 })
    .map((r) => ({ record: r, weight: r.tally ? (r.repeatedSince || 0) : 1 }));

  const pending = [];
  for (const state of recent.values()) {
    if (state.workspace !== workspace || state.count === 0) continue;
    pending.push({
      record: {
        flow: state.flow,
        op: state.op,
        message: state.message,
        time: new Date(state.at).toISOString(),
      },
      weight: state.count,
    });
  }

  const byFlow = new Map();
  for (const { record, weight } of [...pending, ...onDisk]) {
    const bucket = byFlow.get(record.flow)
      || { flow: record.flow, count: 0, last: null, lastMessage: null };
    bucket.count += weight;
    if (!bucket.last || record.time > bucket.last) {
      bucket.last = record.time;
      bucket.lastMessage = record.message;
    }
    byFlow.set(record.flow, bucket);
  }

  const entries = [...pending, ...onDisk];
  return {
    total: entries.reduce((n, e) => n + e.weight, 0),
    since: onDisk.length > 0 ? onDisk[onDisk.length - 1].record.time : null,
    byFlow: [...byFlow.values()]
      .map((b) => ({ ...b, label: FLOWS[b.flow] || b.flow }))
      .sort((a, b) => b.count - a.count),
  };
}

/**
 * Write out every pending repeat tally, whatever its window.
 *
 * Registered on process exit below. Without it the tail of a storm dies with
 * the process: the log would show "401 Bad credentials" once when it actually
 * happened five hundred times, and the number is the whole point.
 */
export function flushPending() {
  for (const [key, state] of recent) {
    if (state.count > 0) {
      try {
        appendRecord(paths.errorLogPath(state.workspace), {
          time: new Date(state.at).toISOString(),
          flow: state.flow,
          op: state.op,
          message: state.message,
          tally: true,
          repeatedSince: state.count,
        });
      } catch {
        /* shutting down; nothing further to try */
      }
    }
    recent.delete(key);
  }
}

// Only sync writes are legal in an exit handler, which is all appendRecord does.
process.once('exit', flushPending);

/** Delete the log. Returns how many entries went. */
export function clearErrors(workspace) {
  const cleared = readErrors(workspace, { limit: 100000 }).length;
  for (const file of [paths.errorLogPath(workspace), paths.errorLogPath(workspace).replace(/\.jsonl$/, '.1.jsonl')]) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* already gone */
    }
  }
  recent.clear();
  return cleared;
}
