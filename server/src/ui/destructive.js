/**
 * Which commands destroy more than they name.
 *
 * The app already stops and asks before deleting *one* allowlist rule, spelling
 * the whole rule out first because "a rule can be a paragraph of shell". Then
 * `/allowlist clear` removed seven of them on one keypress and reported it in
 * the past tense. Same for `/clear`, which is a single Enter on the Session row
 * of the settings screen and takes the conversation with it.
 *
 * The line drawn here is **not** "does it change state" — nearly everything
 * does, and a confirmation on every toggle is a confirmation nobody reads. It is
 * *does this destroy something the user accumulated, without them naming it?*
 *
 *   `/memory forget 3`     names what it removes      → no prompt
 *   `/allowlist remove <c>` names what it removes     → no prompt (menu already asks)
 *   `/allowlist clear`      removes an unnamed N      → ask
 *   `/clear`                removes an unnamed N      → ask
 *
 * `/compact` is deliberately not here. It is lossy and it cannot be undone, but
 * it is the mechanism for *continuing* a long session rather than for throwing
 * one away, and it already announces what it did in detail.
 */

/**
 * @param {string} command      the word after the slash
 * @param {string[]} args
 * @param {object} ctx          counts, so the prompt can say what is at stake
 * @returns {{title: string, detail: string, confirmLabel: string}|null}
 */
export function describeDestructive(command, args = [], ctx = {}) {
  const sub = (args[0] || '').toLowerCase();
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  if (command === 'allowlist' && sub === 'clear') {
    const allow = ctx.allowCount ?? 0;
    const block = ctx.blockCount ?? 0;
    const total = allow + block;
    if (total === 0) return null;              // nothing to lose, nothing to ask
    return {
      title: `Clear every command rule?`,
      detail: `${allow} allowed and ${block} blocked will be forgotten. `
        + 'The agent will start asking again before it runs anything that is not safe.',
      confirmLabel: `Yes, clear all ${total}`,
    };
  }

  if (command === 'clear' || command === 'new') {
    const turns = ctx.turnCount ?? 0;
    if (turns === 0) return null;
    return {
      title: command === 'new' ? 'Start a new chat?' : 'Clear the conversation?',
      detail: `${plural(turns, 'turn')} will be dropped, from this project and from `
        + '`~/.agent`, which is the copy that survives a fresh checkout.'
        + (command === 'new' ? ' A new chat is started in the browser too.' : ''),
      confirmLabel: command === 'new' ? 'Yes, start fresh' : `Yes, clear ${plural(turns, 'turn')}`,
    };
  }

  if (command === 'github' && sub === 'clear-state') {
    return {
      title: 'Clear the GitHub poller state?',
      detail: 'The watermarks go with it, so every comment already on every watched '
        + 'PR looks new again — and each one it decides to analyse is a browser turn.',
      confirmLabel: 'Yes, clear it',
    };
  }

  return null;
}
