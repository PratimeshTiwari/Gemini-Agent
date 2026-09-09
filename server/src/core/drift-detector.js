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


/**
 * Has the model forgotten it has tools?
 *
 * The failure this catches, verbatim from a real turn:
 *
 *   "I cannot execute local commands or access your local file system to list
 *    the files in /Users/…. If you are currently building or testing an AI
 *    agent framework, you will need to integrate a local file system tool…"
 *
 * It is a direct consequence of the prompt economics: the system prompt and the
 * tool definitions only ride on turn 0 and every Nth turn thereafter (see
 * `PromptBuilder`), because re-sending them every time trips Gemini's
 * repetition filters. Most of the time the model remembers. When it does not,
 * it does not produce a malformed tool call — which `noteDrift` already
 * catches — it produces a confident, well-formed refusal, and the turn is
 * simply lost.
 *
 * Two independent signals are required: a first-person inability *and* a
 * mention of the capability it thinks it lacks. Either alone is ordinary
 * prose — "you cannot access the file system from the browser" is a perfectly
 * good sentence for the model to write about someone else's code.
 *
 * @param {string} text - the model's reply, tool calls already stripped
 * @returns {boolean}
 */
export function looksLikeCapabilityDenial(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  // A denial is short and up front. A long answer that happens to contain these
  // words is answering the question, not refusing it.
  const head = text.slice(0, 600);

  const inability = new RegExp(
    String.raw`\b(?:`
      // "I cannot", "I can't", "I'm unable to", "I am unable to",
      // "I don't have access", "I do not have the ability"
      + String.raw`I\s*(?:'m|\s+am)?\s*(?:cannot|can'?t|can\s+not|unable\s+to`
      + String.raw`|(?:do\s+not|don'?t)\s+have\s+(?:the\s+)?(?:ability|access|permission))`
      + String.raw`|as\s+an\s+AI(?:\s+language\s+model)?,?\s+I\s+(?:cannot|can'?t|don'?t)`
      + String.raw`)`,
    'i',
  );
  if (!inability.test(head)) return false;

  const capability = /\b(?:execute|run|access|read|write|browse|list|open)\b[^.!?\n]{0,60}\b(?:local|file\s*system|filesystem|files?|directory|directories|folder|command|terminal|shell|your\s+(?:machine|computer|disk))\b/i;
  return capability.test(head);
}
