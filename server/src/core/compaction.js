/**
 * Compaction: summarise the older turns and hand the thread over.
 *
 * Lifted out of `agent-loop.js` verbatim, as a function taking the loop — the
 * same shape `slash-commands.js` already uses, so the dependency reads in the
 * signature rather than as a dozen implicit `this.` references. That file was
 * 2,669 lines and held the turn loop, tool dispatch, approval, subagents,
 * compaction, model switching and the handover audit; nearly every bug found on
 * 2026-09-19 lived in it or one call away.
 *
 * Nothing about the behaviour changed in the move. The one thing worth knowing
 * before touching it: **compaction is a handover, not a truncation.** It
 * summarises, opens a *new* browser chat, and only resets `contextChars` if the
 * browser confirms — because that counter is "everything ever typed into the
 * tab", and resetting it against a thread that never changed is what made the
 * agent believe it had room it did not have.
 */
import { randomUUID } from 'crypto';
import { archiveTurns } from './session-recall.js';

/**
 * How long to wait for the model's summary before condensing locally.
 *
 * A person typed `/compact` and is watching a spinner, so this is a UX budget
 * rather than a watchdog. The fallback below is deterministic and always
 * available, which is what makes a short deadline safe: the worst case is a
 * blunter summary, not a lost turn.
 */
const SUMMARY_TIMEOUT_MS = 30000;

/** Rows, not exchanges — three short Q&A pairs is already eight rows. */
const MIN_ROWS = 6;

/**
 * Below this, the round trip costs more than the summary saves.
 *
 * `/compact` exists to free room in the browser thread. Asking the model to
 * summarise a few hundred characters spends a full inject → think → scrape
 * cycle — 4,673ms median, 14,913ms p90 — to save almost nothing, and the reply
 * is longer than the input as often as not.
 *
 * Reproduced: at eight rows the old guard passed and `slice(0, -5)` left
 * **three rows** to summarise. The guard counted rows and the cost is in
 * characters, so it was measuring the wrong thing.
 */
const MIN_COMPACT_CHARS = 2000;

const charsOf = (turns) => turns.reduce((n, t) => n + (t.content?.length || 0), 0);

export async function compactHistory(loop, focus) {
  if (loop.conversationHistory.length < MIN_ROWS) {
    return { message: 'Conversation is too short to compact.' };
  }

  const pending = loop.conversationHistory.slice(0, -5);
  const pendingChars = charsOf(pending);
  if (pendingChars < MIN_COMPACT_CHARS) {
    return {
      message: `Nothing worth compacting yet — the older turns are only `
        + `${pendingChars.toLocaleString()} characters, and summarising them would cost a `
        + `browser round trip to save less than it spends.\n\n`
        + `_Context is ~${loop.contextTokens.toLocaleString()} tokens; `
        + `auto-compaction runs past 80% of the rung's budget._`,
    };
  }

  loop.isCompacting = true;

  try {
    // Keep the last 5 turns exactly as they are
    const toCompact = loop.conversationHistory.slice(0, -5);
    const toKeep = loop.conversationHistory.slice(-5);

    // Deterministic lightweight truncation (fallback)
    let compactedSummary = toCompact.map(turn => {
      if (turn.role === 'system' && turn.content) {
        if (turn.content.includes('**Command Output:**')) return '[System: Command executed. Output truncated for context compaction.]';
        if (turn.content.includes('**File Contents:**') || turn.content.includes('**Search Results:**')) return '[System: File/Search data truncated for context compaction.]';
        if (turn.content.length > 500) return `[System: Output truncated. Original length: ${turn.content.length}]`;
      }
      return `[${turn.role.toUpperCase()}]: ${turn.content}`;
    }).join('\n\n');

    loop._notify(
      `🧠 Summarising ${toCompact.length} older turns in a browser tab — `
      + `up to ${SUMMARY_TIMEOUT_MS / 1000}s, then it condenses them locally instead.`,
    );

    const summaryPrompt = `You are a context compactor for an AI coding agent.
Your job is to read the following conversation history and summarize it into a tight, dense block of text.
CRITICAL RULES:
1. Preserve ALL file paths that were explored.
2. Preserve ALL technical conclusions, bugs found, or decisions made.
3. Preserve the exact current state of the user's task.
4. Do NOT output markdown formatting like \`\`\`json, just pure dense text.

HISTORY TO SUMMARIZE:
${compactedSummary}`;

    /*
     * A deadline the user is actually willing to wait out.
     *
     * This inherited `_executeSubagent`'s five-minute watchdog, and nothing else
     * could settle the promise — so with no extension answering, `/compact` sat
     * silent for five minutes before the fallback ran. Nothing threw, so the
     * UI's try/catch never fired and it read as a hang.
     */
    const llmResponse = await loop._executeSubagent('gemini', summaryPrompt, {
      timeoutMs: SUMMARY_TIMEOUT_MS,
    });
    let finalSummaryText = compactedSummary;
    
    if (llmResponse.success && llmResponse.result) {
      finalSummaryText = llmResponse.result;
    } else if (llmResponse.success && llmResponse.content) {
      finalSummaryText = llmResponse.content;
    }

    const compactedTurn = {
      role: 'system',
      type: 'compaction_summary',
      content: `[Context Summary of older turns]\n${finalSummaryText}`,
      timestamp: Date.now(),
    };

    // Mutate the history safely
    // Archive before the rewrite, not after: `saveHistory` overwrites both
    // copies of history.jsonl, so without this the turns being summarised are
    // gone from disk and not merely from the thread. `recall` searches what
    // lands here, which is the whole reason it can answer anything.
    archiveTurns(loop.workspace, toCompact);

    loop.conversationHistory = [compactedTurn, ...toKeep];
    loop.sessionStore.saveHistory(loop.conversationHistory);
    loop.promptBuilder.resetPromptState();

    /**
     * Compaction is a **handover**, and it used not to hand anything over.
     *
     * It rewrote `conversationHistory`, reset the prompt state and reset the
     * counter — and sent nothing to the browser. The tab stayed on the thread
     * that still held every turn just summarised, so:
     *
     * - the model's memory was unchanged; it still had all of it;
     * - `resetPromptState` then sent a full turn-0 payload **plus** a summary
     *   of those turns *into the thread that contains them* — the largest
     *   prompt in the system, at the moment a large repeated payload is most
     *   likely to trip Gemini's repetition filter;
     * - and `contextChars`, documented as "everything ever typed into the
     *   browser tab", was reset to the summary's length while the tab kept
     *   the lot. It feeds the auto-compaction threshold, the status bar and
     *   `/context`, so after one compaction the agent believed it had room it
     *   did not have, in all three at once.
     *
     * `_resetContextCount`'s own comment already said compaction "throws that
     * thread away and starts a new one from the summary". That was the
     * intent; nothing implemented it. It does now, and the count is only
     * reset **if the new chat actually happened** — a counter reset against a
     * thread that never changed is the bug above, written deliberately.
     */
    const handedOver = await loop.startNewChat();
    if (handedOver) {
      loop._resetContextCount(
        loop.conversationHistory.reduce((n, t) => n + (t.content?.length || 0), 0),
      );
    }

    // Say what actually happened. "✅ History compacted." told the user
    // nothing — not how much went, not whether the model summarised it or the
    // deterministic fallback did, and not where the summary went.
    const approxTokens = (turns) => Math.round(
      turns.reduce((sum, t) => sum + ((t.content?.length || 0) / 4), 0),
    );
    const before = approxTokens([...toCompact, ...toKeep]);
    const after = loop.contextTokens;
    const how = llmResponse.success
      ? 'summarised by the model'
      : 'condensed locally (the model did not answer, so the deterministic fallback ran)';

    // Say which half happened. The old message claimed the tab was "scratch
    // space; nothing is left there" — true of the *summariser's* tab, which
    // is a subagent's own, and read by everyone as the one they are looking
    // at. When the handover fails, the honest thing is to say the old thread
    // is still in front of them, because it is.
    /*
     * Do not send them to `/new`. It clears `conversationHistory`, which is
     * where the summary that was just made now lives — so the one command
     * that looks like the fix is the one that destroys the work. Ask for the
     * thing only they can do: start a chat in the tab itself.
     */
    const where = handedOver
      ? 'The tab has been handed over to a fresh conversation, and the summary goes into it '
        + 'with your next message.'
      : '⚠️ **The browser did not start a new conversation**, so the tab is still on the old '
        + 'one — which already remembers every turn just summarised.\n\n'
        + '**Please open a new chat in the Gemini tab yourself** (the ✚ / *New chat* button). '
        + 'The next message will pick it up automatically.\n\n'
        + '_Not `/new` — that clears the conversation here, and this summary with it._';

    return {
      message: `✓ Compacted ${toCompact.length} turn${toCompact.length === 1 ? '' : 's'} into one summary, `
        + `${how}.\n\n`
        + `Kept the last ${toKeep.length} turns as they were. `
        + `Context is roughly ${before.toLocaleString()} → ${after.toLocaleString()} tokens.\n\n`
        + 'The summary is now the first turn of this conversation — it is in the transcript above '
        + `and saved to \`.agent/sessions/history.jsonl\`. ${where}`,
    };
  } finally {
    loop.isCompacting = false;
  }
}
