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
 * So: one ladder, five rungs, and the invalid states stop existing. `modelTier`
 * and `reasoningLevel` survive as *derived* values because the prompt builder
 * genuinely branches on both — but nothing stores them independently any more,
 * so they cannot disagree.
 *
 * The browser tab matters as much as the profile: the prompt is typed into a
 * real chat, and a pro-tier prompt sent to a Flash tab is a long prompt to a
 * model that does worse with long prompts. Each rung names the tab it expects.
 */

/** The rungs, least effort first. Order is what the picker shows. */
export const EFFORT_LEVELS = [
  {
    id: 'flash',
    label: '⚡ Flash',
    tier: 'flash',
    level: null,
    browser: 'Gemini Flash',
    blurb: 'Terse prompt, no reasoning protocol. Small, well-understood edits.',
  },
  {
    id: 'flash-thinking',
    label: '🧠 Flash Thinking',
    tier: 'flash-thinking',
    level: null,
    browser: 'Gemini Flash (Thinking)',
    blurb: 'Moderate depth — a three-phase protocol, still a short prompt.',
  },
  {
    id: 'brief',
    label: '🏃 Brief',
    tier: 'pro',
    level: 'brief',
    browser: 'Gemini Pro',
    blurb: 'Investigate, implement, verify. Straight to work.',
  },
  {
    id: 'standard',
    label: '🪜 Standard',
    tier: 'pro',
    level: 'standard',
    browser: 'Gemini Pro',
    blurb: 'Restate the task and decompose it into a checklist first.',
  },
  {
    id: 'deep',
    label: '🔭 Deep',
    tier: 'pro',
    level: 'deep',
    browser: 'Gemini Pro',
    blurb: 'Standard, plus approach enumeration, risks and an adversarial self-review.',
  },
];

export const DEFAULT_EFFORT = 'standard';

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

  const tier = String(config.modelTier ?? '').toLowerCase()
    || { low: 'flash', medium: 'flash-thinking', high: 'pro' }[
      String(config.reasoningEffort ?? '').toLowerCase()
    ]
    || 'pro';

  if (tier === 'flash' || tier === 'flash-thinking') return tier;

  const level = String(config.reasoningLevel ?? '').toLowerCase();
  return isEffort(level) && resolveEffort(level).tier === 'pro' ? level : DEFAULT_EFFORT;
}
