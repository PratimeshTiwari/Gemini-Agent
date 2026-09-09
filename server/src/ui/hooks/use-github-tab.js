import { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * Everything the GitHub tab owns: its state, its polling, and the actions its
 * keys and its screen share.
 *
 * It lives here rather than in App.jsx because it is a self-contained screen
 * that happens to share a process with the agent. Sixteen `useState` calls and
 * two effects for a tab most sessions never open made App.jsx hard to read, and
 * pushed `useKeyBindings` to thirty-nine parameters — nearly all of them
 * GitHub's, threaded through a hook that has nothing to do with it.
 *
 * The async actions are here too, not in the key handler: fetching PRs is the
 * tab's behaviour, and a keypress should only have to say which one to run.
 */
export function useGithubTab({ agentLoop, wsServer, activeTab }) {
  const [activity, setActivity] = useState([]);
  const [hasNewEvent, setHasNewEvent] = useState(false);
  const [view, setView] = useState('activity'); // activity | avoid_words | pr_explorer
  const [error, setError] = useState('');
  const [setupToken, setSetupToken] = useState('');

  const [prList, setPrList] = useState([]);
  const [selectedPrIdx, setSelectedPrIdx] = useState(0);
  const [prComments, setPrComments] = useState([]);
  const [selectedPrCommentIdx, setSelectedPrCommentIdx] = useState(0);
  const [explorerMode, setExplorerMode] = useState('prs'); // prs | comments
  const [loadingPrs, setLoadingPrs] = useState(false);
  const [loadingPrComments, setLoadingPrComments] = useState(false);

  const [selectedPlanId, setSelectedPlanId] = useState(null);
  const [expandedComments, setExpandedComments] = useState(new Set());
  const [avoidWords, setAvoidWords] = useState(agentLoop.githubHandler?.config?.avoidWords || []);
  const [newAvoidWord, setNewAvoidWord] = useState('');

  useEffect(() => {
    const id = setInterval(() => {
      if (!wsServer) return;
      const notifications = wsServer.getGitHubNotifications();
      if (notifications.length === 0) return;
      setActivity((prev) => [...prev, ...notifications].slice(-50));
      if (activeTab !== 'github') setHasNewEvent(true);
    }, 1000);
    return () => clearInterval(id);
  }, [wsServer, activeTab]);

  /** Plans currently drawn in the activity list, newest first. What ↑/↓ moves over. */
  const visiblePlans = useMemo(
    () => activity.slice().reverse().filter((a) => a.type === 'github_plan_generated').slice(0, 10),
    [activity],
  );

  const openPrExplorer = useCallback(() => {
    setView('pr_explorer');
    setExplorerMode('prs');
    if (!agentLoop?.githubHandler?.fetchAllOpenPRs) return;
    setLoadingPrs(true);
    agentLoop.githubHandler.fetchAllOpenPRs()
      .then((prs) => {
        setPrList(prs || []);
        setSelectedPrIdx(0);
      })
      .catch((err) => {
        setPrList([]);
        setError(String(err?.message || err));
      })
      .finally(() => setLoadingPrs(false));
  }, [agentLoop]);

  const openComments = useCallback(() => {
    const pr = prList[selectedPrIdx];
    if (!pr || !agentLoop?.githubHandler?.poller) return;
    setLoadingPrComments(true);
    setPrComments([]);
    setExplorerMode('comments');
    setSelectedPrCommentIdx(0);
    agentLoop.githubHandler.poller.fetchAllComments(pr)
      .then((comments) => setPrComments(comments || []))
      .catch((err) => {
        setPrComments([]);
        setError(String(err?.message || err));
      })
      .finally(() => setLoadingPrComments(false));
  }, [agentLoop, prList, selectedPrIdx]);

  /** Hand the highlighted comment to the agent and go back to watching activity. */
  const dispatchComment = useCallback(() => {
    const pr = prList[selectedPrIdx];
    const comment = prComments[selectedPrCommentIdx];
    setView('activity');
    if (agentLoop?.githubHandler?.forceAnalyzeComment && pr && comment) {
      agentLoop.githubHandler.forceAnalyzeComment(pr, comment).catch(() => {});
    }
  }, [agentLoop, prList, selectedPrIdx, prComments, selectedPrCommentIdx]);

  const addAvoidWord = useCallback((word) => {
    const trimmed = word.trim();
    if (!trimmed) return;
    const updated = [...avoidWords, trimmed];
    setAvoidWords(updated);
    setNewAvoidWord('');
    if (agentLoop.githubHandler) {
      agentLoop.githubHandler.config.avoidWords = updated;
      agentLoop.modelConfig = agentLoop.modelConfig || {};
      agentLoop.modelConfig.githubAvoidWords = updated;
      agentLoop._saveConfig();
    }
  }, [agentLoop, avoidWords]);

  const togglePlanExpanded = useCallback((id) => {
    setExpandedComments((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const clearNewEvent = useCallback(() => setHasNewEvent(false), []);

  return {
    // state the screen draws
    activity, view, error, setupToken, setSetupToken, setError,
    prList, selectedPrIdx, prComments, selectedPrCommentIdx,
    explorerMode, loadingPrs, loadingPrComments,
    selectedPlanId, expandedComments, avoidWords, newAvoidWord, setNewAvoidWord,
    hasNewEvent, visiblePlans,

    // what the keys drive
    setView, setExplorerMode, setSelectedPrIdx, setSelectedPrCommentIdx, setSelectedPlanId,
    openPrExplorer, openComments, dispatchComment, addAvoidWord, togglePlanExpanded,
    clearNewEvent,

    /** True while a text field on the tab owns the letters — see use-github-keys. */
    get isTyping() {
      return !agentLoop.githubHandler || view === 'avoid_words';
    },
  };
}
