import { resolveEffort, DEFAULT_EFFORT } from '../core/effort.js';

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
    // Replaced per turn from the active rung — see AgentLoop. Kept as a field
    // so anything reading `maxTokens` gets the budget actually in force.
    this.maxTokens = resolveEffort(DEFAULT_EFFORT).contextBudget;
  }

  /**
   * Has the thread outgrown its budget?
   *
   * Takes the count rather than the history, because the history is only the
   * turns we kept a local copy of. The browser tab is also holding the system
   * prompt, the tool definitions and every tool result ever fed back — which is
   * most of what fills a thread, and none of what this used to measure.
   *
   * @param {number} tokens - what the thread is carrying (AgentLoop.contextTokens)
   * @returns {boolean}
   */
  needsCompaction(tokens) {
    // Compact past 80% of budget, so there is room left to do the compacting.
    return Number(tokens || 0) > this.maxTokens * 0.8;
  }
}
