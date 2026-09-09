/**
 * Token reduction for anything that goes into a prompt.
 */
export class CodeMinifier {
  /**
   * Serialise without indentation.
   *
   * Every tool result is embedded in the next prompt (see
   * `PromptBuilder.buildToolResultBatch`), and pretty-printing them was the
   * largest avoidable cost on that path — a plain `list_directory` result is
   * 40% smaller compact. The model does not read the whitespace.
   *
   * Returns the input unchanged if it is not JSON, so a caller can pass it
   * anything a tool handler might have produced.
   *
   * @param {Object|string} data
   * @returns {string}
   */
  static minifyJson(data) {
    try {
      const obj = typeof data === 'string' ? JSON.parse(data) : data;
      return JSON.stringify(obj);
    } catch {
      return typeof data === 'string' ? data : '';
    }
  }
}
