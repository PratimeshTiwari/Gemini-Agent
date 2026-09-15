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
 * Ask the model about one comment, and return its analysis or null.
 *
 * Never throws. A failed analysis must still leave a review on disk — the
 * classification and the comment are worth keeping even when the browser turn
 * fell over, or a flaky tab loses the record entirely. The failure goes to
 * `/logs` instead of to the caller.
 *
 * @param {object} options
 * @param {(prompt: string) => Promise<{success: boolean, result?: string, error?: string}>} options.ask
 * @returns {Promise<string|null>}
 */
export async function analyseComment({ pr, comment, ask, workspace }) {
  if (!ask) return null;
  const prompt = buildReviewPrompt({ pr, comment });

  try {
    const response = await ask(prompt);
    if (response?.success) return response.result;
    logError(workspace, {
      flow: 'github', op: 'analyze_comment',
      message: response?.error || 'the analysis returned no result',
    });
  } catch (err) {
    logError(workspace, {
      flow: 'github', op: 'analyze_comment',
      message: err.message, detail: err.stack,
    });
  }
  return null;
}
