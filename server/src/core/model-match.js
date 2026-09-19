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

/**
 * What each rung reaches for, and what it must not land on.
 *
 * `avoid` is not decoration. "Extended thinking — complex problem solving" and
 * "3.8 Flash — all-around help" share the word *thinking* with the flash rung's
 * intent, and the extended option is several times the weight; without a
 * per-rung veto the middle rung quietly selected the heaviest model on the
 * plan. Every rung therefore says what it is reaching past, not only what it is
 * reaching for.
 */
const INTENT = {
  flash: {
    prefer: ['fastest', 'lite', 'flash'],
    avoid: ['extended', 'complex', 'pro', 'advanced'],
  },
  'flash-thinking': {
    prefer: ['thinking', 'flash'],
    // A step up from flash, not a step into the heavyweight tier — and not back
    // down to the lite option either.
    avoid: ['lite', 'fastest', 'extended', 'complex'],
  },
  /*
   * One entry since the ladder became three rungs (2026-09-20). It is
   * `standard`'s list, because `pro` is `standard`'s profile — `deep`'s
   * `prefer: ['extended', 'complex', …]` went with `deep`.
   *
   * **This table is keyed by rung id, which makes it the thing a rung change
   * breaks silently.** `INTENT[effortId]` undefined means `pickModelFor`
   * returns null, `planModelSwitch` answers `unavailable`, and `/effort pro`
   * quietly stops matching any browser model — it still *reads* like it worked,
   * because the message just changes from "Switching the browser" to "Asking
   * the browser". Caught here only because `model-match.test.js` asserts on
   * which of those two sentences comes back.
   */
  pro: {
    prefer: ['pro', 'reasoning', 'advanced'],
    avoid: ['extended', 'complex'],
  },
};

const haystack = (m) => `${m.label || ''} ${m.description || ''}`.toLowerCase();

/**
 * @param {string} effortId  a rung id: flash | flash-thinking | pro
 * @param {Array<{label: string, description?: string, selected?: boolean}>} models
 *        what the picker actually offers, in the order it offers it
 * @returns {{model: object, why: string}|null} null when there is nothing to pick
 */
export function pickModelFor(effortId, models = []) {
  const options = (models || []).filter((m) => m && m.label);
  if (options.length === 0) return null;

  const intent = INTENT[effortId];
  if (!intent) return null;

  let best = null;
  for (const model of options) {
    const text = haystack(model);
    if (intent.avoid.some((word) => text.includes(word))) continue;

    // Earlier words are worth more, so "fastest" beats a bare "flash" and
    // "extended" beats "pro" for the deep rung.
    let score = 0;
    intent.prefer.forEach((word, i) => {
      if (text.includes(word)) score += intent.prefer.length - i;
    });
    if (score === 0) continue;

    if (!best || score > best.score) best = { model, score };
  }

  if (!best) return null;
  return {
    model: best.model,
    why: `${best.model.label} — closest to ${effortId} among ${options.length} offered`,
  };
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
export function planModelSwitch(effortId, models = []) {
  const options = (models || []).filter((m) => m && m.label);
  if (options.length === 0) {
    return { action: 'unavailable', reason: 'the browser has not reported a model list yet' };
  }

  const pick = pickModelFor(effortId, options);
  if (!pick) {
    const offered = options.map((m) => m.label).join(', ');
    return {
      action: 'unavailable',
      reason: `nothing offered suits ${effortId} — this plan has: ${offered}`,
    };
  }

  const current = options.find((m) => m.selected);
  if (current && current.label === pick.model.label) {
    return { action: 'none', model: pick.model, reason: `already on ${pick.model.label}` };
  }

  return { action: 'switch', model: pick.model, reason: pick.why };
}
