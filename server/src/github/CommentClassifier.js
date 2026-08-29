/**
 * Comment Classifier
 *
 * Categorizes GitHub PR comments into actionable types using
 * keyword matching and heuristics. No LLM needed for Phase 1.
 *
 * Categories:
 *   - spec_missing    → Tests/specs needed
 *   - logic_change    → Logic refactor requested
 *   - bug_report      → Bug or regression found
 *   - question        → Reviewer asking a question
 *   - noise           → LGTM, bot comments, etc. (skip)
 */

const CATEGORY_RULES = [
  {
    category: 'spec_missing',
    label: 'Missing Specs / Tests',
    keywords: [
      'spec', 'test', 'tests', 'coverage', 'missing test', 'add test',
      'unit test', 'integration test', 'test case', 'no tests',
      'test coverage', 'untested', 'needs testing', 'write tests',
    ],
    patterns: [
      /(?:add|write|missing|need|no)\s+(?:unit\s+)?tests?/i,
      /test\s+coverage/i,
      /spec\s+(?:is\s+)?missing/i,
      /needs?\s+(?:more\s+)?testing/i,
    ],
    priority: 2,
  },
  {
    category: 'logic_change',
    label: 'Logic Change / Improvement',
    keywords: [
      'logic', 'refactor', 'change this', 'wrong approach', 'rethink',
      'shouldn\'t', 'should be', 'instead of', 'better approach',
      'needs change', 'needs to change', 'incorrect', 'rework',
      'restructure', 'redesign', 'wrong', 'fix this', 'update this',
      'modify', 'rewrite', 'simplify', 'optimize', 'improve', 'feature',
      'add', 'why', 'how', 'issue'
    ],
    patterns: [
      /(?:this|the)\s+logic\s+(?:needs?|should)/i,
      /(?:change|update|fix|modify|rewrite|improve)\s+(?:this|the)\s+(?:logic|approach|implementation)/i,
      /(?:should|could|needs?\s+to)\s+(?:be|use)\s+/i,
      /instead\s+of\s+/i,
      /wrong\s+(?:approach|way|logic)/i,
    ],
    priority: 2,
  },
  {
    category: 'bug_report',
    label: 'Bug Report',
    keywords: [
      'bug', 'broken', 'doesn\'t work', 'regression', 'crash',
      'error', 'fail', 'failing', 'exception', 'null pointer',
      'undefined', 'NaN', 'infinite loop', 'race condition',
      'memory leak', 'not working', 'breaks',
    ],
    patterns: [
      /(?:this|it)\s+(?:is\s+)?(?:broken|buggy|failing)/i,
      /(?:doesn't|does\s+not|won't|will\s+not)\s+work/i,
      /(?:causes?|introduces?)\s+(?:a\s+)?(?:bug|regression|crash)/i,
      /(?:throw|throws|throwing)\s+(?:an?\s+)?(?:error|exception)/i,
    ],
    priority: 3,
  },
  {
    category: 'question',
    label: 'Reviewer Question',
    keywords: [],
    patterns: [
      /\?\s*$/m,           // Ends with question mark
      /^(?:why|how|what|when|where|can\s+you|could\s+you)\s+/im,
    ],
    priority: 1,
  },
  {
    category: 'noise',
    label: 'Noise (Skip)',
    keywords: [
      'lgtm', 'looks good', 'looks great', 'approved', 'shipit',
      'ship it', '👍', '🚀', '✅', '+1', 'nit:', 'nit ',
      'nice work', 'great work', 'well done', 'thanks',
    ],
    patterns: [
      /^(?:lgtm|looks?\s+good|approved|\+1|👍|🚀|✅)\s*$/im,
      /^nit(?:pick)?[\s:]/im,
    ],
    priority: 0,
  },
];

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
