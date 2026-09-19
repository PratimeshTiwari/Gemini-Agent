/**
 * Which browser conversation a session was talking to.
 *
 * The agent's memory is not `history.jsonl` — that is the *human's* record.
 * The model's memory is the chat thread in the browser tab, and Gemini puts
 * that thread's identity straight in the URL:
 *
 *     https://gemini.google.com/app/bfaf9b2dad21f688
 *                                   ^^^^^^^^^^^^^^^^ this conversation
 *
 * Which answers the question that otherwise has no answer: **can this session
 * be resumed, or does the model need to be told what happened?** If the tab is
 * still on the same thread, it remembers everything and a summary would be
 * both wasted and confusing. If it is on a different thread — or a new chat,
 * which has no id at all until its first exchange — the model has no memory of
 * the work, and continuing without saying so produces an agent answering
 * confidently about a conversation it never had.
 *
 * Recorded rather than guessed, because there is no other way to tell those
 * two apart from the outside.
 */

/** Where each site keeps the conversation id in its URL. */
const THREAD_PATTERNS = [
  { model: 'gemini', re: /^https?:\/\/gemini\.google\.com\/app\/([A-Za-z0-9_-]+)/ },
];

/**
 * The conversation id in a chat URL, or `null`.
 *
 * `null` is a real answer and not a failure: a brand-new chat is
 * `gemini.google.com/app` with nothing after it, and only gets an id once it
 * has something to identify. A session captured before the first reply
 * genuinely has no thread yet.
 *
 * @param {string} url
 * @returns {{model: string, id: string} | null}
 */
export function threadFromUrl(url) {
  const text = String(url || '');
  for (const { model, re } of THREAD_PATTERNS) {
    const m = text.match(re);
    if (m) return { model, id: m[1] };
  }
  return null;
}

/**
 * Would the model remember this session, if we sent to that tab now?
 *
 * Both halves have to be known. An unknown thread on either side is "we cannot
 * tell", and the honest handling of that is the same as "no" — tell the model
 * what happened rather than assume it was there.
 *
 * A session recorded before ChatGPT was removed carries `{model: 'chatgpt'}`.
 * It still resolves correctly without a migration: the models differ, so this
 * returns false and `planResume` says `replay` — which is the honest answer,
 * because there is no longer a bridge that could reopen that conversation.
 *
 * @param {{model: string, id: string} | null} recorded - what the session used
 * @param {{model: string, id: string} | null} live - what the tab is on now
 */
export function sameThread(recorded, live) {
  if (!recorded?.id || !live?.id) return false;
  return recorded.model === live.model && recorded.id === live.id;
}

/**
 * What resuming this session would mean, in words a caller can show.
 *
 * Deliberately three outcomes rather than a boolean. "Continue" and "replay"
 * are different promises to the user, and collapsing them is how a picker ends
 * up silently doing the second while looking like the first.
 *
 * @returns {{action: 'continue'|'replay'|'view', reason: string}}
 */
export function planResume(recorded, live) {
  if (!recorded?.id) {
    return {
      action: 'view',
      reason: 'this session never reached a browser thread, so there is nothing to continue',
    };
  }
  if (sameThread(recorded, live)) {
    return {
      action: 'continue',
      reason: `the tab is still on that conversation (${recorded.id}) — it remembers`,
    };
  }
  return {
    action: 'replay',
    reason: live?.id
      ? `the tab is on a different conversation (${live.id}, not ${recorded.id})`
      : 'no tab is on that conversation any more',
  };
}
