import { exec } from 'child_process';

/**
 * The GitHub tab's keys.
 *
 * Split out of use-key-bindings.js, which was carrying thirty-nine parameters,
 * most of them GitHub's. The agent tab and this one share a terminal and
 * nothing else.
 *
 * The one rule worth stating: the plain letters (`r`, `a`, `p`, space) are the
 * dashboard's only while no field on the tab is focused. With the token screen
 * or the avoid-words editor up they belong to the text field — typing "appear"
 * used to trigger avoid-words, PR explorer and refresh on its way through.
 *
 * @returns {boolean} true if the key was consumed and the agent bindings should
 *   not also see it.
 */
export function handleGithubKey(char, key, { github, agentLoop, handleSubmit, setActiveTab }) {
  if (key.escape) {
    if (github.view === 'pr_explorer' && github.explorerMode === 'comments') {
      github.setExplorerMode('prs');
      return true;
    }
    if (github.view !== 'activity') {
      github.setView('activity');
      return true;
    }
    setActiveTab('agent');
    return true;
  }

  // A focused field on the tab owns every printable key.
  if (github.isTyping) return true;

  if (char === 'r' || char === 'R') {
    handleSubmit('/github refresh');
    return true;
  }

  if (char === 'a' || char === 'A') {
    github.setView(github.view === 'avoid_words' ? 'activity' : 'avoid_words');
    return true;
  }

  if (char === 'p' || char === 'P') {
    if (github.view === 'pr_explorer') github.setView('activity');
    else github.openPrExplorer();
    return true;
  }

  if (github.view === 'pr_explorer') {
    if (github.explorerMode === 'prs') {
      if (key.upArrow) github.setSelectedPrIdx((i) => Math.max(0, i - 1));
      if (key.downArrow) github.setSelectedPrIdx((i) => Math.min(github.prList.length - 1, i + 1));
      if (key.return && github.prList.length > 0) github.openComments();
    } else {
      if (key.upArrow) github.setSelectedPrCommentIdx((i) => Math.max(0, i - 1));
      if (key.downArrow) {
        github.setSelectedPrCommentIdx((i) => Math.min(github.prComments.length - 1, i + 1));
      }
      if (key.return && github.prComments.length > 0) github.dispatchComment();
    }
    return true;
  }

  // Activity list.
  const plans = github.visiblePlans;
  let idx = plans.findIndex((p) => p.id === github.selectedPlanId);
  if (idx === -1 && plans.length > 0) idx = 0;

  if (key.upArrow) {
    if (plans.length > 0) github.setSelectedPlanId(plans[Math.max(0, idx - 1)].id);
    return true;
  }
  if (key.downArrow) {
    if (plans.length > 0) github.setSelectedPlanId(plans[Math.min(plans.length - 1, idx + 1)].id);
    return true;
  }
  if (key.return) {
    const item = plans[idx];
    if (item?.payload?.filePath) {
      const file = item.payload.filePath;
      try {
        exec(`"${agentLoop.editor || 'code'}" "${file}" || open "${file}" || xdg-open "${file}"`);
      } catch (e) {
        /* no editor on this machine; the path is in the row either way */
      }
    }
    return true;
  }
  if (char === ' ') {
    const item = plans[idx];
    if (item) github.togglePlanExpanded(item.id);
    return true;
  }

  return true; // the tab swallows everything else; the agent hotkeys are not its
}
