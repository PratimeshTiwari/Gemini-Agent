/**
 * Shaping an `ask_question` payload into something the prompt can draw.
 *
 * The payload is parsed out of model output, so nothing in it is guaranteed:
 * options arrive as strings, as {label, description} objects, as a single
 * string instead of an array, or not at all. A malformed question used to
 * render an empty picker with no way out, and the agent loop stays blocked on
 * `pendingQuestionResolve` until something is chosen — so every shape has to
 * end in a usable prompt.
 */

/** Free-text escape hatch, always offered — Claude Code's "Other". */
export const FREEFORM_VALUE = '__freeform__';

const MAX_OPTIONS = 8;
const MAX_HEADER = 24;

const clean = (value) => (typeof value === 'string' ? value.trim() : '');

function toOption(raw) {
  if (typeof raw === 'string') return { label: clean(raw), description: '' };
  if (raw && typeof raw === 'object') {
    const label = clean(raw.label ?? raw.value ?? raw.option ?? raw.text);
    return { label, description: clean(raw.description ?? raw.detail ?? raw.hint) };
  }
  return { label: '', description: '' };
}

/** At most this many questions ride along in one prompt. */
export const MAX_QUESTIONS = 4;

/**
 * One `ask_question` payload, which may carry several questions.
 *
 * Asking three things used to cost three round trips through the browser tab —
 * three prompts, three chances for Gemini to lose the thread or raise its A/B
 * modal. A batch is one prompt and one answer.
 *
 * @param {object} payload - `{ questions: [...] }`, or a single `{ question, options }`
 * @returns {Array<{header: string, question: string, options: Array}>}
 */
export function normalizeQuestionSet(payload = {}) {
  const raw = Array.isArray(payload.questions) ? payload.questions : null;
  if (!raw || raw.length === 0) return [normalizeQuestion(payload)];

  const set = raw
    .filter((entry) => entry && (typeof entry === 'object' || typeof entry === 'string'))
    .map((entry) => normalizeQuestion(typeof entry === 'string' ? { question: entry } : entry))
    .slice(0, MAX_QUESTIONS);

  return set.length > 0 ? set : [normalizeQuestion(payload)];
}

/**
 * @param {object} payload - `{ question, options, header }` as the model sent it
 * @returns {{header: string, question: string, options: Array<{label: string,
 *   description: string, value: string}>}}
 */
export function normalizeQuestion(payload = {}) {
  const question = clean(payload.question) || 'The agent asked a question, but sent no text.';

  let header = clean(payload.header);
  if (header.length > MAX_HEADER) header = `${header.slice(0, MAX_HEADER - 1).trimEnd()}…`;

  const raw = Array.isArray(payload.options)
    ? payload.options
    : (payload.options ? [payload.options] : []);

  const seen = new Set();
  const options = [];
  for (const entry of raw) {
    const option = toOption(entry);
    if (!option.label || seen.has(option.label)) continue;
    seen.add(option.label);
    options.push({ ...option, value: option.label });
    if (options.length === MAX_OPTIONS) break;
  }

  return { header: header || 'Question', question, options };
}
