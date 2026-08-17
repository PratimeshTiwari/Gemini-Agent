import { TokenCounter } from './TokenCounter.js';
import { WorkspaceSummarizer } from './WorkspaceSummarizer.js';

/**
 * ContextManager
 * 
 * Orchestrates the token budget. Decides what to trim or drop
 * if the context gets too large.
 */
export class ContextManager {
  constructor(workspacePath) {
    this.workspacePath = workspacePath;
    this.maxTokens = 50000; // safe threshold for Gemini Flash
    this.summarizer = new WorkspaceSummarizer(workspacePath);
  }

  /**
   * Prepares the workspace context summary.
   * Checks token limits and trims depth if necessary.
   */
  getWorkspaceSummary() {
    let summary = this.summarizer.summarize(3);
    
    // If it's too big, fallback to depth 1
    if (TokenCounter.estimateTokens(summary) > 5000) {
      summary = this.summarizer.summarize(1);
    }
    
    // If STILL too big, just return root dir info
    if (TokenCounter.estimateTokens(summary) > 5000) {
      summary = `Workspace Directory: ${this.workspacePath}\n(Directory too large to summarize fully)`;
    }

    return summary;
  }

  /**
   * Evaluates current context usage and determines if compaction is needed.
   * @param {Array<Object>} history 
   * @returns {boolean}
   */
  needsCompaction(history) {
    const tokens = TokenCounter.estimateHistoryTokens(history);
    // e.g. Compact if over 80% of budget
    return tokens > (this.maxTokens * 0.8);
  }
}
