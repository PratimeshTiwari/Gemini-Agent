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
 * **Renamed 2026-09-20 to the words the picker uses: `lite`, `flash`, `pro`.**
 * They were `flash`, `flash-thinking`, `pro`, and the collision was the
 * problem — "flash" named *our terse rung* while the browser's picker uses it
 * for the middle one, so a mismatch warning naming both would have said "flash"
 * about two different things. The measurements above are from before the
 * rename: what they call `flash` is now `lite`, and `flash-thinking` is now
 * `flash`. The prompts are byte-identical across the rename except for each
 * rung's own name line — verified for all six shapes.
 *
 * `reasoning-*` and `handover-*` moved with them, and two files were renamed to
 * stop meaning something else: `handover-lite.md` served what is now `flash`,
 * so it is `handover-short.md`, and `core-flash.md` / `tool-call-format-flash.md`
 * are used by *both* cheap rungs, so they are `core-terse.md` and
 * `tool-call-format-terse.md`.
 *
 * The browser tab matters as much as the profile: the prompt is typed into a
 * real chat, and a pro-tier prompt sent to a Flash tab is a long prompt to a
 * model that does worse with long prompts. Each rung names the tab it expects.
 */

/** The rungs, least effort first. Order is what the picker shows. */
export const EFFORT_LEVELS = [
  {
    id: 'low',
    contextBudget: 24000,
    name: 'Low',
    label: '⚡ Low',
    tier: 'lite',
    level: null,
    browser: 'Gemini Flash-Lite',
    blurb: 'Terse prompt, no reasoning protocol. Small, well-understood edits.',
  },
  {
    id: 'medium',
    contextBudget: 48000,
    name: 'Medium',
    label: '🧠 Medium',
    tier: 'flash',
    level: null,
    browser: 'Gemini Flash',
    blurb: 'Moderate depth — a three-phase protocol, still a short prompt.',
  },
  {
    id: 'high',
    contextBudget: 96000,
    name: 'High',
    label: '🪜 High',
    tier: 'pro',
    level: 'standard',
    browser: 'Gemini Pro',
    blurb: 'Plan first, then investigate, implement and verify — with a cold review of the diff.',
  },
];

export const DEFAULT_EFFORT = 'high';

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

/**
 * The rung with this id, or the default. Never throws, never returns null.
 *
 * **Retired words resolve to what they meant, not to the default.** Without
 * that, `resolveEffort('lite')` fell through to `DEFAULT_EFFORT` and answered
 * `high` — the *opposite* rung — while `resolveEffort('pro')` answered `high`
 * correctly by pure luck, because `pro` and the default happen to coincide.
 * One legacy word silently inverted and its neighbour silently worked, which
 * is the worst possible pairing for noticing.
 *
 * Caught by a smoke test asserting `/effort lite` still selects the terse
 * rung, during the 2026-09-26 rename that created the hazard.
 */
export function resolveEffort(id) {
  const word = String(id ?? '').toLowerCase().trim();
  return BY_ID.get(word)
    || BY_ID.get(RETIRED_RUNGS[word])
    || BY_ID.get(DEFAULT_EFFORT);
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
const RETIRED_RUNGS = {
  brief: 'high',
  standard: 'high',
  deep: 'high',
  /*
   * **Renamed again on 2026-09-26, and this time away from the browser.**
   * Owner's call: *"internally for effort selection lets simplify the names,
   * low medium high"*.
   *
   * Naming our rungs after Google's models was the root of a collision this
   * file already documents — `flash` meant our terse rung before 2026-09-20
   * and the middle one after — and it only got worse as the picker learned to
   * read itself. The effort is **ours** and says how hard to work; the model
   * is the **browser's** and is whatever its picker currently offers. Two
   * different things, and they no longer share a vocabulary.
   *
   * `lite`/`flash`/`pro` fold straight across. There is no ambiguity this
   * time, because `low`/`medium`/`high` are words this ladder has used before
   * only in `reasoningEffort` — where they meant exactly these three rungs, in
   * this order. The rename is a return to that vocabulary, not a departure.
   */
  lite: 'low',
  flash: 'medium',
  pro: 'high',
  // Renamed 2026-09-20 to match what the browser's picker calls things: what
  // was `flash` is `lite`, and what was `flash-thinking` is `flash`. A stored
  // `flash` is therefore *ambiguous* — it meant the terse rung before the
  // rename and the middle one after — and it is read as the middle one,
  // because that is what the word means now and in the picker. The terse rung
  // is reachable by its own name.
  'flash-thinking': 'medium',
};

/**
 * Fold any word this ladder has ever used into a rung id, or `null`.
 *
 * `resolveEffort` cannot answer this: it never returns null, because callers
 * that need *a* rung must always get one. A caller that needs to know whether
 * the user actually named a rung — `/effort deeep`, or `ask_subagent`'s
 * optional `effort` — needs the difference between "you asked for high" and
 * "I picked high for you", and collapsing those is how a typo became a silent
 * confirmation once already.
 *
 * @param {string} id anything: a current rung, a retired one, or nonsense
 * @returns {string|null} the rung id, or null when it is not a rung at all
 */
export function foldEffort(id) {
  const word = String(id ?? '').toLowerCase().trim();
  if (BY_ID.has(word)) return word;
  return RETIRED_RUNGS[word] || null;
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
  const retired = RETIRED_RUNGS[String(config.effort ?? '').toLowerCase().trim()];
  if (retired) return retired;

  /*
   * `modelTier` is still the browser-shaped word (`lite`/`flash`/`pro`) because
   * it is the *prompt profile*, which the prompt files are named after and
   * which `prompt-builder` branches on. Only the rung **id** moved to
   * low/medium/high, so an old tier has to be translated rather than returned.
   *
   * `reasoningEffort` needs no translation at all: it held low/medium/high for
   * exactly these three rungs before 2026-09-20, which is the vocabulary this
   * rename returns to.
   */
  const tier = String(config.modelTier ?? '').toLowerCase()
    || { low: 'lite', medium: 'flash', high: 'pro' }[
      String(config.reasoningEffort ?? '').toLowerCase()
    ]
    || 'pro';

  const fromTier = { lite: 'low', flash: 'medium', pro: 'high' }[tier];
  if (fromTier === 'low' || fromTier === 'medium') return fromTier;

  // `reasoningLevel` only ever held brief/standard/deep, which are now one rung.
  const level = String(config.reasoningLevel ?? '').toLowerCase();
  return RETIRED_RUNGS[level] || DEFAULT_EFFORT;
}
