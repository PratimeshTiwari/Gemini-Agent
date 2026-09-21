/**
 * How often the text channel fails, as a rate.
 *
 * There is no tool-call API here: the model's reply is prose, and tool calls
 * are parsed back out of it. `CLAUDE.md` records the consequence as a fork —
 * whether to add an optional API backend — and then says the honest thing about
 * it: *"any claim about how far this is behind is an estimate until that view
 * exists."*
 *
 * Every number needed has been logged for months. `parse_tool_calls`,
 * `tool_amnesia`, `provider_error` and `multiple_drafts` all go to
 * `errors.jsonl` with timestamps, and nobody has ever read them — and reading
 * them as a *list* would not answer it anyway. "Seven parse failures" is not a
 * number you can act on; "seven in nine hundred turns" is, and so is "seven in
 * twelve".
 *
 * **The denominator is the trick, and it is why this took a plan rather than a
 * grep.** `traces.jsonl` records one entry per turn that came back from the
 * browser, which is exactly the population these failures are drawn from: a
 * reply that could not be parsed still arrived, a model that denied having
 * tools still answered, and a provider error is a reply too. Turns that never
 * reached the browser are in neither log, and belong in neither.
 *
 * Reported with the count as well as the rate, and refusing to give a rate at
 * all below a floor — one failure in three turns is 33% and means nothing.
 */

import { weightedErrors } from './error-log.js';
import { readTraces } from './trace-log.js';

/** The failures that are the text channel's own, and what each one is. */
export const CHANNEL_OPS = [
  {
    op: 'parse_tool_calls',
    label: 'Unparseable tool call',
    detail: 'the reply held a tool call that JSON.parse could not read',
  },
  {
    op: 'tool_amnesia',
    label: 'Denied having tools',
    detail: 'the model answered that it cannot run commands or read files',
  },
  {
    op: 'provider_error',
    label: 'Provider error',
    detail: 'the tab returned an error instead of an answer',
  },
  {
    op: 'multiple_drafts',
    label: 'Multiple drafts',
    detail: 'the reply offered alternatives instead of one answer',
  },
  /*
   * Not a channel failure like the four above — the text arrived fine. It is
   * here because it answers the same *kind* of question and there is no second
   * place to put a rate: how often does the closing report claim something the
   * turn has no record of doing? Until this existed, whether the handover list
   * worked at all was an opinion.
   */
  {
    op: 'handover_unsupported',
    label: 'Unverified handover claim',
    detail: 'the closing block reported work the turn has no record of',
  },
  /*
   * The two added 2026-09-21, both for failures that were happening and were
   * being counted nowhere.
   *
   * `premature_conclusion` is the reply that answered while still calling
   * tools — reported with screenshots, and structurally invisible before:
   * `_auditHandover` runs only on a turn's *final* reply, so a claim made
   * mid-turn was neither audited nor blocked.
   *
   * `turn0_no_tools` is the one described from use and never once recorded.
   * `tool_amnesia` catches an *explicit* denial — "I cannot read your files" —
   * and sits at 0.38%. A model that simply answers from priors, denying
   * nothing, produced no log line at all, so "it hallucinates on the first
   * prompt" could not be told from noise. Until this has a number, changing
   * turn 0 is a guess.
   */
  {
    op: 'premature_conclusion',
    label: 'Concluded before its evidence',
    detail: 'the reply closed with a handover block while still calling tools',
  },
  {
    op: 'turn0_no_tools',
    label: 'First turn answered blind',
    detail: 'turn 0 asked about the code and answered without opening anything',
  },
];

/**
 * Below this many turns a percentage is theatre, not measurement.
 *
 * Deliberately not hidden behind an average: the count is still shown, so a
 * young log reads as "2 failures, too few turns to rate" rather than as silence
 * or as a confident 40%.
 */
export const MIN_TURNS_FOR_RATE = 20;

/**
 * @param {string} workspace
 * @returns {{turns: number, enough: boolean, total: number,
 *            rows: Array<{op, label, detail, count, rate: number|null}>}}
 */
export function channelHealth(workspace) {
  // Every trace is a turn that came back from a browser tab.
  const turns = readTraces(workspace, { limit: 100000 }).length;

  // Weighted, because `errors.jsonl` collapses repeats inside a 60s window and
  // counting lines would report a storm of 500 as 1.
  const counts = new Map(CHANNEL_OPS.map((o) => [o.op, 0]));
  for (const { record, weight } of weightedErrors(workspace, { limit: 100000 })) {
    if (counts.has(record.op)) counts.set(record.op, counts.get(record.op) + weight);
  }

  const enough = turns >= MIN_TURNS_FOR_RATE;
  const rows = CHANNEL_OPS.map((o) => {
    const count = counts.get(o.op) || 0;
    return { ...o, count, rate: enough ? count / turns : null };
  });

  return {
    turns,
    enough,
    total: rows.reduce((n, r) => n + r.count, 0),
    rows,
  };
}

/** A rate as a percentage with one decimal, or `—` when there is no rate. */
export function formatRate(rate) {
  if (rate === null || rate === undefined) return '—';
  if (rate === 0) return '0%';
  // A rate under a tenth of a percent reads as 0.0%, which looks like none.
  return rate < 0.001 ? '<0.1%' : `${(rate * 100).toFixed(1)}%`;
}
