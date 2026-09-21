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
 * Two halves, and both are load-bearing — measured against a corpus.
 *
 * The old pattern asked for an inability phrase and then, loosely, for any of
 * `execute|run|access|read|...` within 60 characters of any of
 * `local|file|directory|command|...`. That window is wide enough to span two
 * clauses, so **"I read the file and I can't see any problem with the parser
 * — the local variable is fine"** matched: an ordinary finding, classified as
 * a refusal. The cost is not a stray log line — the caller throws the reply
 * away and re-asks, so a correct answer is destroyed.
 *
 * And it missed real ones. Two denials seen in use inside a single day:
 *
 *     "the local file system tools listed in your prompt ... are not actively
 *      connected to my execution engine"
 *     "The tools you listed are not available in my current environment."
 *
 * Both are passive. The model is not saying *it* cannot; it is saying the
 * tools are not wired up — so the inability half has to include that voice.
 *
 * The cure for the false positives is the *subject*, not a narrower window: a
 * genuine denial is about the agent's tooling or the box it runs in, while an
 * ordinary answer saying "can't" is about code. `local scope`, `local
 * variable` and `the test file` are no longer objects; `local disk`, `file
 * system`, `execution environment` and `shell commands` are.
 */
const DENIAL_INABILITY = new RegExp(
  '(?:'
  // "I cannot", "I can't", "I am unable to" — with a short gap allowed, so
  // "I am running in a sandbox and cannot reach..." is caught. Bounded to one
  // sentence: no ., !, ? or newline may appear inside the gap.
  + String.raw`\bI\b[^.!?\n]{0,40}?\b(?:cannot|can'?t|can\s+not|unable\s+to)\b`
  + String.raw`|\bI\s*(?:'m|\s+am)?\s*(?:do\s+not|don'?t)\s+have\b`
  // The passive voice, which is how both denials seen in use were phrased.
  + String.raw`|\b(?:are|is|aren'?t|isn'?t)\s+not\s+(?:\w+\s+){0,2}(?:connected|available|enabled|accessible|wired|hooked)\b`
  + String.raw`|\bas\s+an\s+AI(?:\s+language\s+model)?\b`
  + ')',
  'i',
);

/**
 * What the denial has to be *about* — the agent's tools, or the box it runs in.
 *
 * Deliberately excludes a bare `file`, `files` and `command`: those are what
 * an ordinary answer talks about, and they were the whole false-positive
 * surface.
 */
const DENIAL_SUBJECT = new RegExp(
  '(?:'
  // Not `mcp/tools/`. A path is not a claim about tooling, and in this repo
  // that directory is a thing an ordinary answer mentions by name.
  + String.raw`(?<![\w/])tools?\b(?!/)`
  + String.raw`|\bfile\s?system\b`
  + String.raw`|\bexecution\s+(?:engine|environment|context)\b`
  + String.raw`|\b(?:live\s+)?backend\b`
  + String.raw`|\bsandbox\b`
  + String.raw`|\bshell\s+commands?\b`
  + String.raw`|\bterminal\b`
  + String.raw`|\blocal\s+(?:machine|disk|terminal|runtime|file\s?system|files?|commands?|environment)\b`
  + String.raw`|\byour\s+(?:local\s+)?(?:machine|computer|disk|files?|file\s?system)\b`
  + ')',
  'i',
);

/**
 * The other shape a denial takes: "I can't *do* the thing the tools do."
 *
 * `"I can't read files in that directory."` names no environment, so the
 * subject list above cannot see it — and it is a real denial.
 *
 * The discriminator is that the inability attaches **directly** to a verb the
 * tools perform. The old pattern allowed 60 characters between any such verb
 * and any such object, searched independently of the inability, which is how
 * it read `"I read the file and I can't see any problem … the local
 * variable"` as a refusal. Here the verb has to follow the negation almost
 * immediately, so `can't **see**`, `can't **reproduce**`, `can't **find**`
 * and `can't **make**` — the four ways an ordinary answer says it — do not
 * qualify, because none of them is a tool's verb.
 */
const DENIAL_ACTION = new RegExp(
  String.raw`\b(?:cannot|can'?t|can\s+not|unable\s+to|do\s+not|don'?t)\s+`
  // Four, not two: "do not **have the ability to** read files" is the same
  // denial with a politer run-up. Verified against the negatives — none of
  // `can't see`, `can't reproduce`, `can't find`, `can't make` or `can't
  // tell` reaches a tool verb inside that window.
  + String.raw`(?:\w+\s+){0,4}`
  + String.raw`\b(?:read|write|execute|run|access|open|list|browse|modify|create|delete)\b\s+`
  + String.raw`(?:\w+\s+){0,3}`
  + String.raw`\b(?:files?|directory|directories|folder|commands?|code|repo|repository)\b`,
  'i',
);


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
  // A denial is short and up front. A long answer that happens to contain
  // these words is answering the question, not refusing it.
  const head = text.slice(0, 600);
  if (!DENIAL_INABILITY.test(head)) return false;
  return DENIAL_SUBJECT.test(head) || DENIAL_ACTION.test(head);
}


/**
 * Is this the *provider's* error, rather than the model's answer?
 *
 * Gemini Web hands back a short apology of its own when a request fails on
 * their side — "I encountered an error doing what you asked. Could you try
 * again?" — and it arrives through exactly the same path as a real reply. The
 * agent has no way to tell the difference by structure: no tool calls, some
 * prose, turn over. In the background GitHub agent that string was then written
 * to disk as the PR plan.
 *
 * Retrying is the right response, so the bar is "short and generic": a genuine
 * answer to a coding question is neither. The length check is what stops a real
 * reply that happens to discuss an error from matching.
 *
 * @param {string} text - the model's reply, tool calls already stripped
 * @returns {boolean}
 */
export function looksLikeProviderError(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 300) return false;

  return [
    // Gemini
    /\bI encountered an error\b/i,
    /\bsomething went wrong\b/i,
    // Common to several providers
    /\bplease try again\b/i,
    /\bcould you try again\b/i,
    /\btry again later\b/i,
    /\ban error (?:has )?occurred\b/i,
    /\bunable to (?:complete|process) (?:your |the )?(?:request|response)\b/i,
    /\bI'?m (?:having trouble|not able) (?:responding|to respond)\b/i,
    // Gemini's refusal. Observed in the wild: a turn came back as "I'm having a
    // hard time fulfilling your request. Can I help you with something else
    // instead?" — structurally identical to a finished answer, so without this
    // it becomes the turn's result and the work is silently lost.
    /\bhaving a hard time fulfilling\b/i,
    /\bcan I help you with something else\b/i,
  ].some((re) => re.test(trimmed));
}

/**
 * Is this request about the code in front of us?
 *
 * The fourth detector, and the only one that reads the **user's** words rather
 * than the model's. It exists because the failure reported most often from use
 * — *"on the very first prompt Gemini hallucinates and does not act as an
 * agent"* — was recorded nowhere. `looksLikeCapabilityDenial` catches a model
 * that says it cannot read files, and that sits at 0.38%. A model that simply
 * answers from priors, denying nothing and opening nothing, produced no log
 * line at all, so the complaint could not be told from noise.
 *
 * It cannot be answered from the reply alone: "here is how the UI works" is a
 * perfectly good answer to a question about UI design and a fabrication when
 * the question was about *this* UI. What separates them is whether the request
 * pointed at the repository — so this reads the request, and the caller pairs
 * it with "and nothing was opened".
 *
 * Deliberately generous about what counts as pointing at code, and deliberately
 * ignorant of tone. A false positive costs one log row that a human reads; a
 * false negative costs the measurement this exists to produce.
 */
const CODE_QUESTION = [
  // A path, or a bare filename with an extension.
  /(?:^|[\s`'"(])(?:[\w.@-]+\/)+[\w.@-]+/,
  /\b[\w-]+\.(?:js|jsx|ts|tsx|md|json|css|html|py|sh|yml|yaml)\b/i,
  // The nouns of a codebase question.
  /\b(codebase|repo|repository|workspace|module|function|class|method|component|handler|parser|test suite)\b/i,
  // Asking about this project's own behaviour.
  /\b(how does (it|this|the)|where is|what calls|who calls|why does (it|this)|explain (the|this|how))\b/i,
  /*
   * First-person-plural about the system.
   *
   * "should we send the system prompt in chunks", "can we fix our parser",
   * "what do we do about X" — someone saying *we* and *our* is talking about
   * the thing in front of them, and it is the strongest available signal that a
   * question is about this repository without naming a file.
   *
   * Added after the first probe missed the very prompt this detector was
   * written for: **"can you help me improve the effort tiers?"** has no path, no
   * extension and none of the nouns above. A detector that cannot see its own
   * founding case is measuring something else.
   */
  /\b(should|shall|can|could|do|did|would) we\b/i,
  /\bour (agent|code|codebase|repo|project|parser|prompt|system|tool|setup|implementation)\b/i,
  // Verbs of change aimed at a system rather than at prose.
  /\b(refactor|implement|debug|optimi[sz]e)\b/i,
  /\b(improve|fix|add|remove|change|update|rewrite)\b[^.!?]{0,40}\b(tier|prompt|tool|flag|agent|loop|bridge|handler|config|schema|branch|test)/i,
];

export function looksLikeCodeQuestion(text) {
  const t = String(text || '').trim();
  if (t.length < 8) return false;
  return CODE_QUESTION.some((re) => re.test(t));
}
