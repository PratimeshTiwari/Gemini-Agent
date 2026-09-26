/**
 * Matching an effort rung to whatever the browser is actually offering.
 *
 * `/effort` has always known which tab it wants — every rung carries a `browser`
 * field naming one — and has never been able to do anything about it. It printed
 * "💡 Set your browser tab to **Gemini Pro** — the prompt is written for it" and
 * hoped. When that hope was misplaced the result is the case `CLAUDE.md` calls
 * out by name: a pro-tier prompt in a Flash tab is a long prompt to the model
 * that handles long prompts worst.
 *
 * **The names cannot be hardcoded.** What Gemini offers is `3.5 Flash-Lite`,
 * `3.8 Flash`, `3.1 Pro` and `Extended thinking` today, on one plan. The version
 * numbers move, and the list itself differs by subscription — a plan without
 * Extended thinking would get a picker entry that silently did nothing. So the
 * extension reads the menu and this decides against what it found, by what each
 * option is *for* rather than what it is called this month.
 *
 * Matching is on intent words, scored, and it reports why it chose — a switch
 * the user cannot explain is worse than no switch, because they cannot tell it
 * from a bug.
 */

import { EFFORT_LEVELS } from './effort.js';

/**
 * The rung ids, from the ladder itself.
 *
 * Derived rather than listed: a hand-kept copy is what `INTENT` effectively
 * was, and CLAUDE.md already names the failure — "`INTENT[effortId]` undefined
 * means `pickModelFor` returns null … and `/effort pro` quietly stops matching
 * any browser model", which still *reads* like it worked.
 */
const EFFORT_IDS = new Set(EFFORT_LEVELS.map((e) => e.id));

const haystack = (m) => `${m.label || ''} ${m.description || ''}`.toLowerCase();

/**
 * The picker's own running order, anchored on the one name that does not drift.
 *
 * Reported by the owner, 2026-09-26: *"Pro is the main identifier — Flash-Lite
 * and Flash change across different Google accounts, only Pro is constant, even
 * the versions change."* That is a fact about Google's naming, not about this
 * code, and it undercuts the word lists above for two of the three rungs:
 * `lite` reaches for `fastest`/`lite` and `flash` for `thinking`/`flash`, and
 * neither word is promised to anybody.
 *
 * What *is* stable is the order. Verified against the live picker by cycling it
 * with the browser's own `⌘⇧M` shortcut, which walks the models and nothing
 * else:
 *
 *     Flash-Lite → Flash → Pro → Flash-Lite (wraps)
 *
 * Lightest first, Pro last, and **Extended thinking is not in the rotation at
 * all** — it is a mode rather than a rung, which is what `avoid` has always
 * encoded by hand.
 *
 * So Pro is found by name, and the rest by position relative to it: the first
 * entry is the lightest, and the one immediately before Pro is the middle. With
 * two entries the middle *is* the lightest, and with one there is nothing to
 * choose. Anything past Pro is a mode, not a model, and is dropped.
 *
 * Returns null when there is no entry recognisably named Pro — then the word
 * lists run as before, because a plan that does not use the word at all is
 * exactly the case they were written for.
 */
function byPickerOrder(effortId, options) {
  /*
   * A mode is whatever the page says is a mode.
   *
   * The extension reports `isMode`, taken from the rule the picker draws
   * between its models and its modes — a real `<mat-divider>`, verified against
   * the live menu and agreeing exactly with what `⌘⇧M` cycles. The word test
   * behind it is not a second strategy: it is the same question asked of a
   * build too old to answer it, and it is the thing this is getting away from.
   * `extended`/`complex` is a guess about English that breaks on a fourth mode
   * or a rename.
   */
  const knowsModes = options.some((m) => typeof m.isMode === 'boolean');
  const isMode = (m) => (knowsModes ? m.isMode === true : /extended|complex/.test(haystack(m)));
  const models = options.filter((m) => !isMode(m));
  if (models.length === 0) return null;

  /*
   * Position is only meaningful over a list we know is a list of models.
   *
   * When the page cannot say which entries are modes, everything it offers
   * looks like one — so a picker holding a single unlabelled entry, `Canvas`
   * say, would be read as "the only model" and *switched to*. A wrong switch
   * is worse than no switch: it moves the tab somewhere nobody chose, and the
   * turn after it runs on that.
   *
   * Two entries is the floor for inferring a ladder from an order, and it is
   * counted on what the picker **offered**, not on what survived the veto. A
   * two-entry menu where one is recognisably a mode is still a real picker —
   * it told us something — whereas a single unlabelled entry told us nothing.
   * Counting the survivors instead rejected `Flash Extended` + `Flash`, which
   * is exactly the case the veto exists to handle.
   */
  if (!knowsModes && options.length < 2) return null;

  /*
   * Position, and nothing else.
   *
   * The picker lists its models lightest-first — confirmed by cycling it with
   * the browser's own shortcut, which walks them in that order and wraps from
   * the heaviest back to the lightest. So the ladder maps straight onto the
   * list and **no product name is needed for any rung**: the owner reports that
   * Flash-Lite and Flash are renamed across accounts and that even Pro carries
   * a version that moves.
   *
   * This used to be two passes — position when `isMode` was available, a
   * `\bpro\b` anchor when it was not — and the anchor is gone. It could only
   * help a build that reports no modes *and* still calls its top model Pro,
   * which is a narrower case than the word lists it sat in front of, and it
   * bought a third answer for the same question.
   */
  if (effortId === 'low') return models[0];
  if (effortId === 'high') return models[models.length - 1];
  // The rung below the heaviest. Clamped, never wrapped: on a two-entry plan
  // the middle collapses onto the lightest, which is honest, where wrapping
  // would send it to the heaviest — the pairing CLAUDE.md calls the worst.
  if (effortId === 'medium') return models[Math.max(0, models.length - 2)];
  return null;
}

/**
 * The label this rung is pinned to in `config.json`, or `''`.
 *
 * `modelConfig.browserModels` is `{ lite, flash, pro }` — one picker label per
 * rung. Absent means "decide by intent", which is the default and what every
 * existing config does.
 *
 * Read by rung id rather than stored on the rung, because `effort.js` describes
 * the ladder and this is a property of one user's Google plan.
 */
export function browserModelPin(modelConfig, effortId) {
  const key = String(effortId ?? '').toLowerCase().trim();
  const pins = modelConfig?.browserModels;
  /*
   * Keyed by rung id, and the rung ids were renamed on 2026-09-26 — so a
   * config written before that holds `{ lite, flash, pro }` and would stop
   * resolving in silence, which is the worst way for a pin to fail: it exists
   * to correct a bad match, so losing it looks exactly like the match being
   * wrong again.
   *
   * The old key is read only when the new one is absent, so a config carrying
   * both is answered by the current name.
   */
  const LEGACY = { low: 'lite', medium: 'flash', high: 'pro' };
  const pinned = pins?.[key] ?? pins?.[LEGACY[key]];
  return typeof pinned === 'string' ? pinned.trim() : '';
}

/**
 * @param {string} effortId  a rung id: lite | flash | pro
 * @param {Array<{label: string, description?: string, selected?: boolean}>} models
 *        what the picker actually offers, in the order it offers it
 * @param {string} [pin]  a label from `browserModels`, which wins over the
 *        intent match when the picker is really offering it
 * @returns {{model: object, why: string, pinned?: boolean, pinMissed?: string}|null}
 *        null when there is nothing to pick
 */
export function pickModelFor(effortId, models = [], pin = '') {
  const options = (models || []).filter((m) => m && m.label);
  if (options.length === 0) return null;

  /*
   * The pin is checked against the **live list**, never assumed.
   *
   * Everything below decides by what an option is *for*, which is what makes it
   * survive a rename. But it is a scored word match over labels Google writes,
   * and when it is wrong there has been no way to correct it short of editing
   * this file. `browserModels` is that correction: name the label you want.
   *
   * What it must not become is a second way to be silently wrong. A pin this
   * plan does not offer — a rename, a different subscription, another machine's
   * config — would otherwise strand the rung on nothing for the life of the
   * install, which is worse than the occasional bad match it exists to fix. So
   * a pin is honoured only when it resolves to exactly one option that is on
   * screen *now*; otherwise the intent match runs as usual and the result
   * carries `pinMissed`, so the caller can say the pin was ignored rather than
   * dropping it in silence.
   *
   * Exact label first, substring second. Version numbers move (`3.1 Pro` →
   * `3.2 Pro`), so pinning `Pro` has to keep working — but `Flash` matches both
   * `3.8 Flash` and `3.5 Flash-Lite`, and resolving that by position is exactly
   * how you land on a model nobody chose. Ambiguous is treated as missed.
   */
  const wanted = String(pin || '').trim().toLowerCase();
  let pinMissed;
  if (wanted) {
    const exact = options.filter((m) => m.label.trim().toLowerCase() === wanted);
    const hits = exact.length
      ? exact
      : options.filter((m) => m.label.toLowerCase().includes(wanted));
    if (hits.length === 1) {
      return { model: hits[0], pinned: true, why: `${hits[0].label} — pinned by config` };
    }
    pinMissed = hits.length === 0
      ? `config pins "${pin}", which this plan does not offer`
      : `config pins "${pin}", which matches ${hits.length} of the options offered`;
  }

  /*
   * An id this ladder does not have is not a rung, and must not be guessed at.
   * `INTENT[effortId]` used to serve as this check by accident — an unknown id
   * found no word list and fell out — which CLAUDE.md flagged as the thing a
   * rung rename would break silently. It is explicit now.
   */
  if (!EFFORT_IDS.has(effortId)) return null;

  const byOrder = byPickerOrder(effortId, options);
  if (byOrder) {
    return {
      model: byOrder,
      pinned: false,
      ...(pinMissed ? { pinMissed } : {}),
      why: `${byOrder.label} — ${effortId} by the picker's order, anchored on Pro`
        + (pinMissed ? ` (${pinMissed})` : ''),
    };
  }

  /*
   * Nothing matched, and that is an answer.
   *
   * There used to be a scored word match here — `prefer`/`avoid` lists per
   * rung, earliest word worth most — and it was the original strategy. It is
   * gone with the names it depended on. Every case it could still answer is one
   * where `byPickerOrder` already declined, which now means the picker offered
   * no models at all; guessing from vocabulary at that point is how a rung
   * lands on a mode.
   *
   * `planModelSwitch` turns this into `unavailable`, which the CLI reports
   * honestly rather than acting on.
   */
  return null;
}

/**
 * Is a switch needed, and can it be made?
 *
 * Separated from picking so the caller can say "already on it" without a click:
 * opening the menu is a DOM interaction on a page that is also mid-conversation,
 * and the cheapest interaction is the one not performed.
 *
 * @returns {{action: 'none'|'switch'|'unavailable', model?: object, reason: string}}
 */
/**
 * Is the browser on a different model from the one this rung is written for?
 *
 * Reported from use: the CLI's status bar read **PRO** while the Gemini tab's
 * picker read **Flash** — a pro-tier prompt going into a Flash tab, which
 * `CLAUDE.md` names as the worst case, the long prompt to the model that
 * handles long prompts worst. Nothing said so. `/effort` switches the picker
 * when it is run, but the user can change it back, a new tab can open on
 * something else, and the plan's default is whatever Google decides.
 *
 * **Silent unless both halves are known.** No reported selection means the
 * picker has not been read, not that it disagrees — and a warning that fires on
 * missing information is one people learn to ignore, which costs more than the
 * mismatch it was meant to catch.
 *
 * @returns {{current: string, wanted: string} | null}
 */
export function modelMismatch(effortId, models = [], pin = '') {
  const explained = explainModelMismatch(effortId, models, pin);
  // Two fields, still. The status row only needs "warn or don't", and every
  // extra key here is one more thing a caller can start depending on — whether
  // the wanted model came from a pin is `explainModelMismatch`'s business.
  return explained.state === 'mismatch'
    ? { current: explained.current, wanted: explained.wanted }
    : null;
}

/**
 * `modelMismatch`'s reasoning, without collapsing "they agree" and "I have no
 * idea" into the same `null`.
 *
 * Reported from use, twice: the warning row disagreed with what the CLI
 * believed the rest of the time, and there was no way to tell — from the
 * outside or from the logs — whether that was because the picker genuinely
 * agreed or because nothing had told it who was selected. Both read as
 * silence. `modelMismatch` still returns a bare `null` for both, because the
 * status row only ever needs "show a warning or don't" — but a caller that
 * wants to know *why* it went quiet, or wants to log the unreadable case, has
 * this instead.
 *
 * @returns {{state: 'agree'|'unknown'|'mismatch'|'unavailable', current?: string, wanted?: string, reason?: string}}
 */
export function explainModelMismatch(effortId, models = [], pin = '') {
  const options = (models || []).filter((m) => m && m.label);
  const current = options.find((m) => m.selected);
  if (!current) {
    return {
      state: 'unknown',
      reason: options.length === 0
        ? 'the browser has not reported a model list yet'
        : 'the browser reported a model list with nothing marked selected',
    };
  }
  const plan = planModelSwitch(effortId, options, pin);
  if (plan.action === 'unavailable') return { state: 'unavailable', reason: plan.reason };
  if (plan.action === 'none') return { state: 'agree', current: current.label };
  return {
    state: 'mismatch',
    current: current.label,
    wanted: plan.model.label,
    pinned: Boolean(plan.pinned),
  };
}

export function planModelSwitch(effortId, models = [], pin = '') {
  const options = (models || []).filter((m) => m && m.label);
  if (options.length === 0) {
    return { action: 'unavailable', reason: 'the browser has not reported a model list yet' };
  }

  const pick = pickModelFor(effortId, options, pin);
  if (!pick) {
    const offered = options.map((m) => m.label).join(', ');
    return {
      action: 'unavailable',
      reason: `nothing offered suits ${effortId} — this plan has: ${offered}`,
    };
  }

  // `pinned` and `pinMissed` ride along so the caller can tell "you asked for
  // this" from "I guessed this", and can say when a pin was skipped. Collapsing
  // those into one message is the defect `explainModelMismatch` was split out
  // of: one value doing two jobs reads as silence.
  const pinFields = {
    pinned: Boolean(pick.pinned),
    ...(pick.pinMissed ? { pinMissed: pick.pinMissed } : {}),
  };

  const current = options.find((m) => m.selected);
  if (current && current.label === pick.model.label) {
    return {
      action: 'none', model: pick.model, ...pinFields, reason: `already on ${pick.model.label}`,
    };
  }

  return { action: 'switch', model: pick.model, ...pinFields, reason: pick.why };
}
