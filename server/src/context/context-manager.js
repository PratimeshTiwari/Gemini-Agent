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
  }

  /**
   * Has the thread outgrown its budget?
   *
   * Takes the count rather than the history, because the history is only the
   * turns we kept a local copy of. The browser tab is also holding the system
   * prompt, the tool definitions and every tool result ever fed back — which is
   * most of what fills a thread, and none of what this used to measure.
   *
   * The budget is passed in rather than held here. It used to be a field, set
   * once in the constructor from the *default* rung and carrying a comment
   * saying it was "replaced per turn from the active rung" — which nothing did.
   * So `/effort flash` moved the prompt's shape and not the threshold, and the
   * field was a stale copy of something `AgentLoop` already derives. A value
   * that must track another is better read than stored.
   *
   * @param {number} tokens - what the thread is carrying (AgentLoop.contextTokens)
   * @param {number} limit  - the active rung's budget (AgentLoop.contextLimit)
   * @returns {boolean}
   */
  needsCompaction(tokens, limit) {
    // Refuse a history, loudly.
    //
    // The call site passed `conversationHistory` for as long as this existed.
    // `Number([{…},{…}])` is `NaN` and `NaN > x` is always false, so the branch
    // was dead for every possible input and auto-compaction never once ran —
    // silently, while the meter went past 200% of budget. `Number()` swallowing
    // the mistake is what made it survivable; the throw is the part that stops
    // it coming back.
    // Arrays are rejected by shape, not by what they coerce to: `Number([])` is
    // `0`, which is finite and simply returns false, so an empty history would
    // still slip through a NaN check and read as "nothing to compact".
    if (Array.isArray(tokens)) {
      throw new TypeError(
        'needsCompaction wants a token count (a number), not a history array'
        + ' — pass AgentLoop.contextTokens',
      );
    }

    const count = typeof tokens === 'number' ? tokens : Number(tokens ?? 0);
    if (!Number.isFinite(count)) {
      throw new TypeError(
        `needsCompaction wants a token count (a number), not ${typeof tokens}`
        + ' — pass AgentLoop.contextTokens',
      );
    }

    const budget = Number(limit);
    if (!Number.isFinite(budget) || budget <= 0) {
      throw new TypeError('needsCompaction wants the active budget — pass AgentLoop.contextLimit');
    }

    // Compact past 80% of budget, so there is room left to do the compacting.
    return count > budget * 0.8;
  }
}
