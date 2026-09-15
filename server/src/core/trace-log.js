import fs from 'fs';
import path from 'path';
import * as paths from './paths.js';

/**
 * How long a turn spent in the browser, per stage.
 *
 * The extension's own logging is `console.log` in two contexts nobody has open.
 * P2 added `op`/`stage`/`targetModel` to *errors*, which is why `/logs
 * extension` can say `find_input` rather than "failed" — but there has never
 * been any record of a **successful** turn's timings. So "the connection is
 * slower than it used to be" was unanswerable from inside the product, and any
 * claim about a regression was a feeling.
 *
 * Deliberately not `errors.jsonl`. That log collapses repeats inside a 60s
 * window, which is exactly wrong for something you want every sample of, and
 * mixing routine successes into the failure log would bury the failures.
 *
 * What is reported is a **distribution**, not a list. "Is it slower?" is a
 * question about the middle and the tail; twenty individual numbers do not
 * answer it and one average hides the tail that people actually notice.
 */

/** Stages, in the order they happen. Unknown ones are kept but sort last. */
export const STAGES = ['find_input', 'type', 'send', 'first_token', 'complete'];

const tracePath = (workspace) => path.join(paths.logsDir(workspace), 'traces.jsonl');

/**
 * Record one turn's timings.
 *
 * Never throws: this is instrumentation, and instrumentation that can fail a
 * turn is worse than no instrumentation.
 *
 * @param {string} workspace
 * @param {{model?: string, stages?: Record<string, number>}} trace
 */
export function logTrace(workspace, trace) {
  try {
    if (!trace || typeof trace !== 'object') return;
    const stages = {};
    for (const [name, ms] of Object.entries(trace.stages || {})) {
      const n = Number(ms);
      if (Number.isFinite(n) && n >= 0) stages[name] = Math.round(n);
    }
    if (Object.keys(stages).length === 0) return;

    const line = JSON.stringify({
      time: new Date().toISOString(),
      model: trace.model || 'gemini',
      stages,
    });
    const file = tracePath(workspace);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${line}\n`);
  } catch {
    /* instrumentation must never fail a turn */
  }
}

/** The most recent `limit` traces, newest last. */
export function readTraces(workspace, { limit = 200 } = {}) {
  try {
    const raw = fs.readFileSync(tracePath(workspace), 'utf8');
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* a half-written line */ }
    }
    return out.slice(-limit);
  } catch {
    return [];
  }
}

/** Median and 90th percentile, which is where "it feels slow" actually lives. */
export function percentile(values, p) {
  if (!values || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest-rank: no interpolation, so a reported number is always one that
  // really happened.
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

/**
 * Per stage: how many samples, the median, and the 90th percentile.
 *
 * @returns {{samples: number, stages: Array<{stage, n, median, p90}>}}
 */
export function summariseTraces(workspace, { limit = 200 } = {}) {
  const traces = readTraces(workspace, { limit });
  const byStage = new Map();

  for (const trace of traces) {
    for (const [stage, ms] of Object.entries(trace.stages || {})) {
      if (!byStage.has(stage)) byStage.set(stage, []);
      byStage.get(stage).push(ms);
    }
  }

  const order = (stage) => {
    const at = STAGES.indexOf(stage);
    return at === -1 ? STAGES.length : at;
  };

  const stages = [...byStage.entries()]
    .map(([stage, values]) => ({
      stage,
      n: values.length,
      median: percentile(values, 50),
      p90: percentile(values, 90),
    }))
    .sort((a, b) => order(a.stage) - order(b.stage) || a.stage.localeCompare(b.stage));

  return { samples: traces.length, stages };
}

/** `2.1s`, `340ms` — the unit people would say out loud. */
export function formatMs(ms) {
  if (ms === null || ms === undefined) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}
