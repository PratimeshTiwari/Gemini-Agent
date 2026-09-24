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

    /*
     * The rung rides along, because without it these numbers cannot answer the
     * question people actually ask of them.
     *
     * The record was `{time, model, stages}` — and `model` is always `gemini`,
     * since that is the only provider. So a whole log of round-trip timings
     * could not be split by *which model in the picker ran*, which makes
     * "is Flash cheaper per round trip than Pro?" unanswerable from the one
     * file that has every other part of the answer. It was asked on
     * 2026-09-24 as the basis for routing cheap work to a Flash tab, and the
     * honest reply was that nobody had measured it.
     *
     * Written only when known, so old rows stay valid and a turn with no rung
     * attached is simply not counted in the per-rung split.
     */
    const line = JSON.stringify({
      time: new Date().toISOString(),
      model: trace.model || 'gemini',
      ...(trace.effort ? { effort: String(trace.effort) } : {}),
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

  /*
   * And the same numbers split by rung.
   *
   * Recorded *and read*, in one change. This repo has twice shipped a value
   * that was written and never carried back — `getAllMemories` with no callers,
   * `task.md` that no prompt returned — and both times the tool call was spent
   * for nothing. A per-rung field with no per-rung view would be the third.
   *
   * `first_token` and `complete` are the two that differ by model: the rest is
   * our own overhead and is the same whichever tab is answering.
   */
  const byEffort = new Map();
  for (const trace of traces) {
    if (!trace.effort) continue;
    if (!byEffort.has(trace.effort)) byEffort.set(trace.effort, { first: [], complete: [] });
    const row = byEffort.get(trace.effort);
    const s2 = trace.stages || {};
    if (Number.isFinite(s2.first_token)) row.first.push(s2.first_token);
    if (Number.isFinite(s2.complete)) row.complete.push(s2.complete);
  }

  const efforts = [...byEffort.entries()]
    .map(([effort, v]) => ({
      effort,
      n: Math.max(v.first.length, v.complete.length),
      firstToken: percentile(v.first, 50),
      complete: percentile(v.complete, 50),
    }))
    .sort((a, b) => b.n - a.n);

  return { samples: traces.length, stages, efforts };
}

/** `2.1s`, `340ms` — the unit people would say out loud. */
export function formatMs(ms) {
  if (ms === null || ms === undefined) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}
