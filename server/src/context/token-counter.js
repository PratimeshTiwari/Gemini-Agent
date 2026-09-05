/**
 * TokenCounter
 * 
 * Provides heuristic token counting to manage the LLM context window.
 */
export class TokenCounter {
  /**
   * Roughly estimate tokens based on string length.
   * Gemini typically uses ~4 characters per token.
   * @param {string} text 
   * @returns {number}
   */
  static estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
  }

  /**
   * Estimate the token size of the entire conversation history.
   * @param {Array<Object>} history 
   * @returns {number}
   */
  static estimateHistoryTokens(history) {
    if (!history) return 0;
    return history.reduce((sum, turn) => {
      const text = turn.content || JSON.stringify(turn.result || turn.args || '');
      return sum + this.estimateTokens(text);
    }, 0);
  }
}
