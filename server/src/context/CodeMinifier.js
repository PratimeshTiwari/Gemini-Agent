/**
 * CodeMinifier
 * 
 * Provides basic token reduction techniques for large payloads.
 */
export class CodeMinifier {
  /**
   * Minify JSON objects by stripping spaces.
   * @param {Object|string} data 
   * @returns {string}
   */
  static minifyJson(data) {
    try {
      const obj = typeof data === 'string' ? JSON.parse(data) : data;
      return JSON.stringify(obj); // no indentation
    } catch {
      return typeof data === 'string' ? data : '';
    }
  }

  /**
   * Strip excessive whitespace from text/code to save tokens.
   * Note: Does not remove comments, just compresses multiple empty lines.
   * @param {string} text 
   * @returns {string}
   */
  static compressWhitespace(text) {
    if (!text) return '';
    return text.replace(/\n{3,}/g, '\n\n').trim();
  }
}
