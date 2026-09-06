/**
 * Noticing when the model has stopped following the contract.
 *
 * The prompt used to end every single message with "provide exactly ONE
 * response. No drafts." — a negative instruction, in the highest-salience
 * position, with perfect predictability. Three problems with that: it competes
 * with the user's actual request for final-position attention, it keeps the
 * concept of "drafts" permanently primed, and an identical sentence closing
 * every turn of a long thread is the repetition signal Gemini's serving stack
 * reacts to. Paying that on every turn to prevent something that happens rarely
 * is the wrong trade.
 *
 * Detecting the failure instead costs nothing until it happens, and then costs
 * one reminder (~310 tokens). A false positive costs the same reminder, so the
 * bar for a match is "cheap to be wrong", not "certain".
 */

/**
 * Markers of a reply offering the user alternative *answers*.
 *
 * Deliberately NOT "option" or "approach": the pro tier's deep reasoning level
 * explicitly asks the model to enumerate 2-4 approaches with tradeoffs, so
 * those words are expected output, not drift.
 */
const DRAFT_KINDS = ['draft', 'response', 'version', 'alternative', 'answer'];
const LABEL = /\b(draft|response|version|alternative|answer)\s*[#:]?\s*(1|2|3|a|b|c)\b/gi;

/**
 * Does this reply look like several drafts offered for the user to choose from?
 *
 * Requires two distinct labels of the same kind ("Draft 1" and "Draft 2"), so a
 * passing mention of "my response" or "version 2 of the API" cannot trigger it.
 *
 * @param {string} text - the model's reply, tool calls already stripped
 * @returns {boolean}
 */
export function looksLikeMultipleDrafts(text) {
  if (typeof text !== 'string' || text.length === 0) return false;

  const byKind = new Map();
  for (const match of text.matchAll(LABEL)) {
    const kind = match[1].toLowerCase();
    const index = match[2].toLowerCase();
    if (!DRAFT_KINDS.includes(kind)) continue;
    if (!byKind.has(kind)) byKind.set(kind, new Set());
    byKind.get(kind).add(index);
  }

  for (const indices of byKind.values()) {
    if (indices.size >= 2) return true;
  }
  return false;
}
