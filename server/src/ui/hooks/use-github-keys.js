/**
 * The GitHub tab's keys.
 *
 * Split out of use-key-bindings.js, which was carrying thirty-nine parameters,
 * most of them GitHub's. The agent tab and this one share a terminal and
 * nothing else.
 *
 * The one rule worth stating: the plain letters (`r`, `a`, space) are the
 * tab's only while no field on it is focused. With the token screen or the
 * avoid-words editor up they belong to the text field — typing "appear" used
 * to trigger avoid-words, PR explorer and refresh on its way through.
 *
 * ## `⏎` means one thing
 *
 * It used to mean three: on the activity feed, open the plan (or run the
 * analysis); in the PR explorer, open this PR's comments; in the comment list,
 * send the comment to the agent. Three screens, one key, three verbs, and the
 * hint row was the only thing that said which — on the two screens that had a
 * hint row.
 *
 * Now it means **go deeper**, at every level, and `esc` means come back:
 *
 * ```
 *   PRs  ─⏎→  comments on one PR  ─⏎→  the analysis, in your editor
 *        ←esc                     ←esc
 * ```
 *
 * @returns {boolean} true if the key was consumed and the agent bindings should
 *   not also see it.
 */
export function handleGithubKey(char, key, { github, agentLoop, handleSubmit, setActiveTab }) {
  if (key.escape) {
    // One rung at a time, and off the ladder at the top. Every screen that is
    // not the PR list — the comments, the help, the avoid-words editor — steps
    // back to it, and only the PR list leaves for the agent.
    if (github.view !== 'prs') {
      github.setView('prs');
      return true;
    }
    setActiveTab('agent');
    return true;
  }

  // A focused field on the tab owns every printable key.
  if (github.isTyping) return true;

  if (char === 'r' || char === 'R') {
    github.refreshPrs();
    handleSubmit('/github refresh');
    return true;
  }

  if (char === 'a' || char === 'A') {
    github.setView(github.view === 'avoid_words' ? 'prs' : 'avoid_words');
    return true;
  }

  /**
   * `?` prints the bindings the row no longer has space for.
   *
   * The hint row carries four; seven wrapped badly at 78 columns. The others
   * did not stop existing, so something has to say where they went — a
   * shortcut nobody can discover is a shortcut nobody uses, and that goes
   * double for the one that discovers the rest.
   */
  if (char === '?') {
    github.showHelp?.();
    return true;
  }

  // The help and avoid-words screens have nothing to move through.
  if (github.view === 'help' || github.view === 'avoid_words') return true;

  if (github.view === 'comments') {
    const rows = github.commentRows;
    if (key.upArrow) github.setSelectedPrCommentIdx((i) => Math.max(0, i - 1));
    if (key.downArrow) github.setSelectedPrCommentIdx((i) => Math.min(rows.length - 1, i + 1));
    if (key.return && rows.length > 0) github.openOrAnalyse();
    if (char === ' ') {
      const row = rows[github.selectedPrCommentIdx];
      if (row) github.toggleCommentExpanded(row.comment.id);
    }
    return true;
  }

  // The PR list.
  if (key.upArrow) github.setSelectedPrIdx((i) => Math.max(0, i - 1));
  if (key.downArrow) github.setSelectedPrIdx((i) => Math.min(github.prs.length - 1, i + 1));
  if (key.return && github.prs.length > 0) github.openComments();
  return true; // the tab swallows everything else; the agent hotkeys are not its
}
