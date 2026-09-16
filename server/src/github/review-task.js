/**
 * Turning one PR comment into the prompt that answers it.
 *
 * Extracted from `github-event-handler.js`, which built this inline in the
 * middle of its queue drain. Separating it makes the prompt a thing you can
 * read and test, rather than a template literal in the middle of control flow —
 * and the prompt *is* the contract with the model, the same way a tool's
 * description is.
 *
 * It does not run anything. The caller supplies how to reach a model, which is
 * what keeps `runHeadlessTask` — and therefore a browser tab — out of the
 * thing that decides what to ask.
 */

import { GITHUB_REVIEW_PROMPT } from './github-review-prompt.js';
import { logError } from '../core/error-log.js';

/**
 * The prompt for one review comment.
 *
 * The file and diff blocks appear only for an inline review comment; an issue
 * comment has neither, and empty tags would be noise the model has to read past
 * on every turn.
 */
export function buildReviewPrompt({ pr, comment }) {
  const diffContext = comment.diff_hunk
    ? `<diff_context>\n\`\`\`diff\n${comment.diff_hunk}\n\`\`\`\n</diff_context>`
    : '';

  const fileContext = comment.path
    ? `<file_context path="${comment.path}"${comment.line ? ` line="${comment.line}"` : ''} />`
    : '';

  return `${GITHUB_REVIEW_PROMPT}

<pr_context>
  <pr title="${pr.title}" number="${pr.number}" branch="${pr.head_ref || 'unknown'}" />
  <comment author="${comment.author}">
${comment.body}
  </comment>
  ${fileContext}
  ${diffContext}
</pr_context>

Investigate this review comment using your tools and produce ONE consolidated markdown plan.
CRITICAL: Do NOT run \`git checkout\` or switch branches. The user may have unsaved work.`;
}

/**
 * Is this comment worth a full investigation?
 *
 * Everything that is not an ignored author, an empty body or a configured
 * avoid word used to go straight to a full analysis — a browser turn with the
 * whole tool set behind it. The tests said so outright: "a thumbs-up DOES open
 * a browser tab, and that is the design". The alternative on offer was keyword
 * matching, which this project deliberately removed once the model took the
 * categorising over.
 *
 * So ask, rather than pattern-match. One short exchange with no tools costs a
 * fraction of an analysis, and it is the same judgement a person makes reading
 * the comment.
 *
 * **An unanswerable triage reviews anyway.** Silence is not consent here: if
 * the bridge is down, triage cannot run *and neither can the analysis*, so
 * proceeding keeps one failure to report instead of inventing a second that
 * quietly drops real comments. Dropping a reviewer's question is far worse
 * than spending a turn on "LGTM".
 *
 * @returns {Promise<{review: boolean, reason: string}>}
 */
export async function triageComment({ pr, comment, ask, workspace }) {
  if (!ask) return { review: true, reason: 'no way to ask, so not skipped' };

  const prompt = `A reviewer left this comment on a pull request. Decide whether it needs a
coding agent to investigate the codebase, or whether it is conversational.

NEEDS INVESTIGATION — a question about the code, a change request, a bug
report, a failing test or CI run, a design objection, or anything asking why
something is the way it is.

DOES NOT — approval ("LGTM", "ship it", "nice work"), thanks, an emoji or
reaction, small talk, a note addressed to a person rather than about the code,
or something the comment itself says is already resolved.

<comment author="${comment.author}"${comment.path ? ` path="${comment.path}"` : ''}>
${comment.body}
</comment>

Reply with exactly one line: the word REVIEW or the word SKIP, then a dash and
a short reason. Nothing else — no preamble, no tool calls.`;

  try {
    const response = await ask(prompt);
    const text = String(response?.result || '').trim();
    if (!response?.success || !text) {
      return { review: true, reason: 'triage did not answer, so not skipped' };
    }

    // The first word is the answer. A model that ignores the format and
    // explains itself still gets read correctly, and an answer that is neither
    // word reviews — never skips on something unparsed.
    const verdict = text.match(/\b(REVIEW|SKIP)\b/i);
    const reason = text.replace(/^[^-\n]*[-–—]\s*/, '').split('\n')[0].trim().slice(0, 160);
    if (verdict && verdict[1].toUpperCase() === 'SKIP') {
      return { review: false, reason: reason || 'judged conversational' };
    }
    return { review: true, reason: reason || 'judged worth investigating' };
  } catch (err) {
    logError(workspace, {
      flow: 'github', op: 'triage_comment',
      message: err.message,
    });
    return { review: true, reason: 'triage failed, so not skipped' };
  }
}

/**
 * Ask the model about one comment.
 *
 * Never throws. A failed analysis must still leave a review on disk — the
 * classification and the comment are worth keeping even when the browser turn
 * fell over, or a flaky tab loses the record entirely. The failure goes to
 * `/logs` instead of to the caller.
 *
 * @param {object} options
 * @param {(prompt: string) => Promise<{success: boolean, result?: string, error?: string}>} options.ask
 * Returns an **outcome**, not a string-or-null. The caller has to be able to
 * tell "the model said this" from "the model never ran", because a review
 * written without an analysis is not a plan — it is a template, and presenting
 * it as a plan is how a failure gets filed away as a success.
 *
 * @returns {Promise<{ok: true, text: string} | {ok: false, error: string}>}
 */
export async function analyseComment({ pr, comment, ask, workspace }) {
  // No way to ask was the one path that failed **silently** — no analysis, no
  // log, and a review file that looked like a plan. It is the loudest failure
  // of the three, not the quietest: it means the agent loop was never wired to
  // the GitHub handler at all.
  if (!ask) {
    const message = 'no agent loop was available to run the analysis';
    logError(workspace, { flow: 'github', op: 'analyze_comment', message });
    return { ok: false, error: message };
  }

  const prompt = buildReviewPrompt({ pr, comment });

  try {
    const response = await ask(prompt);
    if (response?.success && String(response.result || '').trim()) {
      return { ok: true, text: response.result };
    }
    const message = response?.error || 'the analysis returned no result';
    logError(workspace, { flow: 'github', op: 'analyze_comment', message });
    return { ok: false, error: message };
  } catch (err) {
    logError(workspace, {
      flow: 'github', op: 'analyze_comment',
      message: err.message, detail: err.stack,
    });
    return { ok: false, error: err.message };
  }
}
