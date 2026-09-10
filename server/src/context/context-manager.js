import { TokenCounter } from './token-counter.js';

/**
 * ContextManager
 *
 * Decides when the conversation has grown past what the model should carry.
 *
 * This used to also build a workspace summary and inject long-term memories
 * into it, but nothing ever called that method — the summary it produced never
 * reached a prompt, and neither did a single memory. Both were removed with the
 * retrieval subsystem; what is left is the one thing that is actually wired up.
 */
export class ContextManager {
  constructor(workspacePath, memoryManager) {
    this.workspacePath = workspacePath;
    this.memoryManager = memoryManager;
    this.maxTokens = 50000; // safe threshold for Gemini Flash
  }

  /**
   * Has the history outgrown the budget?
   * @param {Array<Object>} history
   * @returns {boolean}
   */
  needsCompaction(history) {
    const tokens = TokenCounter.estimateHistoryTokens(history);
    // Compact past 80% of budget, so there is room to do the compacting.
    return tokens > this.maxTokens * 0.8;
  }
}
