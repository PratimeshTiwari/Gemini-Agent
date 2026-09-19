/**
 * How hard to work, as one setting.
 *
 * There used to be three knobs. `modelTier` (flash / flash-thinking / pro)
 * chose the prompt profile. `reasoningLevel` (brief / standard / deep) chose
 * how hard the pro profile pushes — and did nothing at all on the flash tiers,
 * which the UI apologised for at the point of use rather than preventing.
 * `reasoningEffort` (low / medium / high) was a third name for the first one,
 * written on every change and read only as a fallback when `modelTier` was
 * missing. Nine representable combinations, five of them meaningful.
 *
 * So: one ladder and the invalid states stop existing. `modelTier` and
 * `reasoningLevel` survive as *derived* values because the prompt builder
 * genuinely branches on both — but nothing stores them independently any more,
 * so they cannot disagree.
 *
 * **Three rungs, not five** (2026-09-20, owner's call: "lets change effort to
 * just three, flash, flash-thinking, pro and that is simple"). `brief`,
 * `standard` and `deep` were one tier wearing three hats, and measurement is
 * what settled which survived:
 *
 *     flash           11,040
 *     flash-thinking  14,506   +3,466  (31.4%)
 *     brief           22,839   +8,333  (57.4%)
 *     standard        25,852   +3,013  (13.2%)
 *     deep            26,942   +1,090   (4.2%)
 *
 * `standard → deep` is the whole of the problem: three substantive blocks for
 * 4.2%, which says `standard` was already carrying nearly everything. So `pro`
 * **is** the old `standard`, plus exactly one of `deep`'s three blocks — the
 * review step. The other two are declined on cost that does not show up in the
 * table above: the critical-analysis phase and the assumption ledger are paid
 * in **output** tokens on every pro turn, and output is generation time. The
 * review step is the one with a demonstrated job — a reader with no memory of
 * why you chose any of it.
 *
 * (The `flash-thinking → brief` step read +1,016 (4.5%) until `e485e2a`, which
 * is what made the ladder look like five rungs of mush. That was a bug —
 * `flash-thinking` was handed the full tool block — not a design problem.)
 *
 * The browser tab matters as much as the profile: the prompt is typed into a
 * real chat, and a pro-tier prompt sent to a Flash tab is a long prompt to a
 * model that does worse with long prompts. Each rung names the tab it expects.
 */

/** The rungs, least effort first. Order is what the picker shows. */
export const EFFORT_LEVELS = [
  {
    id: 'flash',
    contextBudget: 24000,
    name: 'Flash',
    label: '⚡ Flash',
    tier: 'flash',
    level: null,
    browser: 'Gemini Flash',
    blurb: 'Terse prompt, no reasoning protocol. Small, well-understood edits.',
  },
  {
    id: 'flash-thinking',
    contextBudget: 48000,
    name: 'Flash Thinking',
    label: '🧠 Flash Thinking',
    tier: 'flash-thinking',
    level: null,
    browser: 'Gemini Flash (Thinking)',
    blurb: 'Moderate depth — a three-phase protocol, still a short prompt.',
  },
  {
    id: 'pro',
    contextBudget: 96000,
    name: 'Pro',
    label: '🪜 Pro',
    tier: 'pro',
    level: 'standard',
    browser: 'Gemini Pro',
    blurb: 'Plan first, then investigate, implement and verify — with a cold review of the diff.',
  },
];

export const DEFAULT_EFFORT = 'pro';

/**
 * About `contextBudget`.
 *
 * It is **not** the model's advertised context window. What actually runs out
 * here is a *browser chat thread*: a prompt is typed into a real tab and the
 * reply is scraped back, so the ceiling is whatever that page keeps working
 * with — and nobody publishes that number. The budget is an operating limit
 * for when to compact, chosen conservatively and deliberately per rung:
 *
 *  - `flash` is the profile that exists *because* the model does worse with
 *    long prompts. Letting its thread grow to the same size as pro's would
 *    defeat the reason for choosing it.
 *  - `pro` is one budget, because what used to be three rungs differed in how
 *    hard the model thinks, not in how much it can hold.
 *
 * A single hardcoded 50,000 for every tier was the previous answer, and it was
 * wrong in both directions at once. These are better guesses, still guesses —
 * `CLAUDE.md` → What's next records measuring them as work, not as a footnote.
 */

const BY_ID = new Map(EFFORT_LEVELS.map((e) => [e.id, e]));

/** The rung with this id, or the default. Never throws, never returns null. */
export function resolveEffort(id) {
  return BY_ID.get(String(id ?? '').toLowerCase().trim()) || BY_ID.get(DEFAULT_EFFORT);
}

/** Is this a real rung? Used to tell `/effort deep` from `/effort deeply`. */
export function isEffort(id) {
  return BY_ID.has(String(id ?? '').toLowerCase().trim());
}

/**
 * The rungs that existed before 2026-09-20, and what they fold to.
 *
 * A stored `effort: 'deep'` is not an error and must not fall back to the
 * default by accident — `isEffort('deep')` is false now, so without this the
 * lookup would skip to the `modelTier` branch and land on `pro` for the wrong
 * reason, or on `flash` if an old `modelTier` disagreed. All three were the pro
 * tier; all three are `pro`.
 */
const RETIRED_RUNGS = { brief: 'pro', standard: 'pro', deep: 'pro' };

/**
 * Work out the rung from whatever an existing config.json holds.
 *
 * Configs in the wild carry the three old keys in every combination, including
 * ones that never made sense — `modelTier: flash` beside `reasoningLevel: deep`
 * is a config that says "think hard" to a profile with no reasoning section.
 * Read in this order: the new key, then the tier (which is the one the prompt
 * actually branched on), then `reasoningEffort` (the legacy alias), and only
 * consult `reasoningLevel` where it meant something — the pro tier.
 */
export function effortFromConfig(config = {}) {
  if (isEffort(config.effort)) return resolveEffort(config.effort).id;
  const retired = RETIRED_RUNGS[String(config.effort ?? '').toLowerCase().trim()];
  if (retired) return retired;

  const tier = String(config.modelTier ?? '').toLowerCase()
    || { low: 'flash', medium: 'flash-thinking', high: 'pro' }[
      String(config.reasoningEffort ?? '').toLowerCase()
    ]
    || 'pro';

  if (tier === 'flash' || tier === 'flash-thinking') return tier;

  // `reasoningLevel` only ever held brief/standard/deep, which are now one rung.
  const level = String(config.reasoningLevel ?? '').toLowerCase();
  return RETIRED_RUNGS[level] || DEFAULT_EFFORT;
}
