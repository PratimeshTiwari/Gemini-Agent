/**
 * Token reduction for anything that goes into a prompt.
 */

/**
 * A `JSON.stringify` replacer that survives a cycle instead of throwing.
 *
 * Built per call, because it holds the objects it has seen.
 */
function withoutCycles() {
  const seen = new WeakSet();
  return (_key, value) => {
    if (typeof value === 'bigint') return `${value}n`;
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    return value;
  };
}

export class CodeMinifier {
  /**
   * Serialise without indentation.
   *
   * Every tool result is embedded in the next prompt (see
   * `PromptBuilder.buildToolResultBatch`), and pretty-printing them was the
   * largest avoidable cost on that path. Verified on a 30-entry
   * `list_directory`-shaped result: 2,456 characters pretty, 1,424 compact —
   * **42% smaller**. The model does not read the whitespace.
   *
   * **It always returns a string, and it never silently returns nothing.**
   * Both halves of that were untrue, and neither was visible: every fixture in
   * the suite passed a *string* result, so this branch was never taken by a
   * test at all, while real tool results are mostly objects.
   *
   * - `undefined` came back as `undefined`, not a string, against a
   *   `@returns {string}` annotation. `buildToolResultBatch` then reads
   *   `.length` off it and the whole prompt build throws, losing every other
   *   result in the batch with it. Not reachable today — every resolver on the
   *   `ask_question` path passes a `result` — but it is one missing field away,
   *   and the failure is a dead turn rather than a bad one.
   * - A **cycle or a BigInt threw**, was caught, and returned `''`. That is the
   *   worse of the two: the model is handed a tool that ran and produced
   *   nothing, which is a confident wrong answer rather than an error. A
   *   replacer keeps everything that *can* be serialised and marks the one
   *   thing that cannot.
   *
   * The doc already promised a caller could "pass it anything a tool handler
   * might have produced". This makes that true rather than aspirational.
   *
   * @param {Object|string|undefined} data
   * @returns {string} always a string; `''` only for genuinely empty input
   */
  static minifyJson(data) {
    if (typeof data === 'string') {
      // Already text. Re-serialise if it happens to be JSON, so a
      // pretty-printed payload from a handler is compacted too; otherwise hand
      // it back untouched.
      try {
        return JSON.stringify(JSON.parse(data));
      } catch {
        return data;
      }
    }

    if (data === undefined) return '';

    try {
      const out = JSON.stringify(data);
      // `JSON.stringify` returns undefined for a function or a lone symbol.
      return out === undefined ? String(data) : out;
    } catch {
      // A cycle or a BigInt. Keep what survives rather than losing the lot.
    }

    try {
      return JSON.stringify(data, withoutCycles());
    } catch {
      return String(data);
    }
  }
}
