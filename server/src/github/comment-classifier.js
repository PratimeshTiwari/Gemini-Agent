/**
 * Comment Classifier
 *
 * Decides which GitHub PR comments are worth an AI review pass. Categorising
 * them is the AI's job now (see github-event-handler._analyzeComment), so this
 * only has to answer "is this worth a turn?".
 *
 * Categories:
 *   - noise            → ignored author, empty body, or an avoid word (skip)
 *   - requires_review  → everything else
 */

export class CommentClassifier {
  /**
   * Classify a single comment.
   *
   * @param {Object} comment
   * @param {string} comment.body - The comment text
   * @param {string} comment.author - The comment author
   * @param {string[]} ignoreAuthors - Authors to auto-skip
   * @param {string[]} avoidWords - Words that indicate noise/skip
   * @returns {{ category: string, label: string, confidence: number, matchedKeywords: string[] }}
   */
  classify(comment, ignoreAuthors = [], avoidWords = []) {
    const { body, author } = comment;

    // Skip bot/ignored authors
    if (ignoreAuthors.includes(author)) {
      return { category: 'noise', label: 'Bot/Ignored Author', confidence: 1.0, matchedKeywords: [] };
    }

    // Skip empty comments
    if (!body || body.trim().length === 0) {
      return { category: 'noise', label: 'Empty', confidence: 1.0, matchedKeywords: [] };
    }
    const lowerBody = body.toLowerCase().trim();

    // Check against avoidWords
    for (const word of avoidWords) {
      const w = word.toLowerCase();
      // Escape regex special characters
      const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Match if the word is the exact string, or surrounded by whitespace/punctuation
      const regex = new RegExp(`(^|\\s|\\b|\\W)${escaped}($|\\s|\\b|\\W)`, 'i');
      if (regex.test(lowerBody)) {
        return { category: 'noise', label: 'Avoid Word Match', confidence: 1.0, matchedKeywords: [word] };
      }
    }

    // Default: Everything else requires AI review
    return { category: 'requires_review', label: 'Requires AI Review', confidence: 1.0, matchedKeywords: [] };
  }

  /**
   * Classify multiple comments and filter to actionable ones.
   *
   * @param {Object[]} comments
   * @param {string[]} ignoreAuthors
   * @param {string[]} avoidWords
   * @returns {Object[]} Classified comments with category !== 'noise'
   */
  classifyBatch(comments, ignoreAuthors = [], avoidWords = []) {
    return comments
      .map(comment => ({
        ...comment,
        classification: this.classify(comment, ignoreAuthors, avoidWords),
      }))
      .filter(c => c.classification.category !== 'noise');
  }
}
