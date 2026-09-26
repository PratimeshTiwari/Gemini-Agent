/**
 * Which tools the model actually reaches for.
 *
 * **The question this answers has been asked three times and guessed at
 * twice.** CLAUDE.md records a one-off measurement — 41 sessions, 529 calls,
 * eight of the eighteen tools never called once — and draws a real conclusion
 * from it: *"the lever for an unused tool is never 'name it again' — it is a
 * trigger at the moment of relevance."* That measurement was taken by hand and
 * has never been repeatable, so the conclusion cannot be checked and the
 * delegation-nudge decision that depends on it has stayed gated for days.
 *
 * It could not be recovered afterwards either. Tool calls are stripped out of a
 * reply by `_extractToolCalls` before the cleaned text reaches the session
 * history, so counting them from `history.jsonl` finds nothing — a probe that
 * tried returned `0 of 2790`, every one of those 2790 a `"name"` key inside a
 * tool *result*. The data was never written down; it was only ever in flight.
 *
 * So: one row per turn, from the tally `_turnEvidence` is already keeping for
 * the handover audit. Not one row per call — a turn is the unit every other
 * rate here uses, and per-call rows would be the busiest file in `.agent/`.
 *
 * Never throws. Instrumentation that can fail a turn is worse than none.
 */
import fs from 'fs';
import path from 'path';
import * as paths from './paths.js';

const usagePath = (workspace) => path.join(paths.logsDir(workspace), 'tool-usage.jsonl');

/**
 * Record one turn's tool calls.
 *
 * @param {string} workspace
 * @param {Map<string, number>|Record<string, number>} counts name -> times called
 */
export function logToolUsage(workspace, counts) {
  try {
    const entries = counts instanceof Map ? [...counts.entries()] : Object.entries(counts || {});
    const tools = {};
    for (const [name, n] of entries) {
      const count = Number(n);
      if (typeof name === 'string' && name && Number.isFinite(count) && count > 0) {
        tools[name] = Math.round(count);
      }
    }
    // A turn with no tool calls is a real and interesting outcome — it is what
    // `turn0_no_tools` is about — so it is recorded rather than skipped.
    const file = usagePath(workspace);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ time: new Date().toISOString(), tools })}\n`);
  } catch {
    /* never fail a turn for a counter */
  }
}

/**
 * Read it back: per-tool totals, and how the turns divide.
 *
 * `neverCalled` takes the catalog rather than deriving from what was seen —
 * the whole point is the tools that appear **nowhere**, and a list derived from
 * the log cannot contain them.
 *
 * @param {string} workspace
 * @param {string[]} [catalog] every tool name the model is offered
 */
export function summariseToolUsage(workspace, catalog = []) {
  let lines = [];
  try {
    lines = fs.readFileSync(usagePath(workspace), 'utf8').split('\n').filter(Boolean);
  } catch {
    // Sorted here too: the empty case is the one a fresh workspace hits, and a
    // list that changes order depending on whether anything was logged is a
    // list somebody will eventually diff.
    return { turns: 0, calls: 0, turnsWithNoTools: 0, rows: [], neverCalled: [...catalog].sort() };
  }

  const totals = new Map();
  let turns = 0;
  let calls = 0;
  let turnsWithNoTools = 0;
  for (const line of lines) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    turns += 1;
    const tools = row.tools && typeof row.tools === 'object' ? row.tools : {};
    const names = Object.keys(tools);
    if (names.length === 0) turnsWithNoTools += 1;
    for (const name of names) {
      const n = Number(tools[name]) || 0;
      calls += n;
      totals.set(name, (totals.get(name) || 0) + n);
    }
  }

  const rows = [...totals.entries()]
    .map(([name, count]) => ({ name, count, share: calls ? count / calls : 0 }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  return {
    turns,
    calls,
    turnsWithNoTools,
    rows,
    neverCalled: catalog.filter((name) => !totals.has(name)).sort(),
  };
}
