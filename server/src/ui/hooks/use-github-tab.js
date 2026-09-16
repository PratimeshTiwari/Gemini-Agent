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
/**
 * One transcript row for a GitHub event, or `null` if it does not earn one.
 *
 * Pure and exported so the wording is testable without rendering: the row is
 * the only part of the GitHub feature most people will ever read.
 *
 * Only `github_plan_generated` earns a row. `processing_started` and
 * `processing_finished` bracket the same event, so honouring all three would
 * draw three lines for one thing.
 *
 * @param {{type: string, payload: object}} n
 * @returns {{role: 'system', content: string, isLocal: true, timestamp: number} | null}
 */
export function githubNoticeRow(n) {
  if (n?.type !== 'github_plan_generated') return null;
  // Capped, because this row is drawn inside the *live* frame while a turn is
  // in flight, and `TranscriptTurn` draws a system row with `wrap="wrap"`. A
  // GitHub username runs to 39 characters, which put the worst case at 78
  // columns — one row at 80, two at 72, and a row that wraps is charged as one
  // and drawn as two. That is a bug this frame has had twice already.
  const raw = n.payload?.comment?.author;
  // The trailing `-` is stripped so a cut name does not read as a dangling word.
  const author = raw && raw.length > 20 ? `${raw.slice(0, 19).replace(/[^A-Za-z0-9]+$/, '')}…` : raw;
  const what = author
    ? `@${author} commented`
    : n.payload?.category === 'ci_failure' ? 'CI failed' : 'plan written';
  return {
    role: 'system',
    content: `⌁ PR #${n.payload?.prNumber ?? '?'} · ${what} — ^o to look`,
    isLocal: true,
    timestamp: Date.now(),
  };
}

export function useGithubTab({ agentLoop, wsServer, activeTab, setHistory }) {
  const [activity, setActivity] = useState([]);
  const [hasNewEvent, setHasNewEvent] = useState(false);
  const [view, setView] = useState('activity'); // activity | avoid_words | pr_explorer
  const [error, setError] = useState('');
  // A rejected token is terminal: the poller has stopped, so the tab shows the
  // setup screen again rather than a dashboard that will never fill in.
  const [authRejected, setAuthRejected] = useState(false);
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

      // Errors are status, not activity: they belong on the error line rather
      // than in the feed, where they would scroll away behind the next event.
      const problems = notifications.filter(
        (n) => n.type === 'github_error' || n.type === 'github_auth_rejected',
      );
      if (problems.length > 0) {
        const last = problems[problems.length - 1];
        setError(last.payload?.message || 'GitHub request failed.');
        if (problems.some((n) => n.type === 'github_auth_rejected')) {
          setAuthRejected(true);
          setView('activity');
        }
      }

      const events = notifications.filter(
        (n) => n.type !== 'github_error' && n.type !== 'github_auth_rejected',
      );
      if (events.length > 0) setActivity((prev) => [...prev, ...events].slice(-50));
      if (activeTab !== 'github') setHasNewEvent(true);

      /**
       * One dim row in the transcript per event, and the tab keeps the detail.
       *
       * Decided rather than drifted into: the tab is right for *browsing* — PRs,
       * plans, the comment bodies — and wrong as the only place activity
       * appears, because everything else in this app is a stream and nothing
       * else is a page. So the event arrives where you are already reading and
       * `^o` still opens the detail. Nothing interrupts and nothing is inserted
       * into the prompt, the same contract as a failed terminal command.
       *
       * `system` rather than a new role, because `groupTurns` already knows it
       * and `TranscriptTurn` already draws it dim and wrapped. A new role would
       * mean teaching both, for one line.
       *
       * It is a *notification*, not the record — `activity` above is the record.
       * That matters because `groupTurns` keeps a system message only inside a
       * turn, so an event arriving before the session's first prompt is not
       * drawn. The tab still has it, and the alternative is inventing an
       * orphan turn to hang it from.
       *
       * Only `github_plan_generated` earns a row. `processing_started` and
       * `processing_finished` bracket the same event, so all three would draw
       * three lines for one thing.
       */
      const rows = events.map(githubNoticeRow).filter(Boolean);
      if (rows.length > 0 && setHistory) setHistory((prev) => [...prev, ...rows]);
    }, 1000);
    return () => clearInterval(id);
  }, [wsServer, activeTab]);

  /**
   * Say that an analysis was asked for.
   *
   * The work happens in the background and its result arrives as a new
   * activity row, which can be twenty seconds later. Without a line here,
   * pressing enter on an unanalysed comment looks exactly like pressing enter
   * on nothing.
   */
  const notifyReanalysing = useCallback((prNumber, author) => {
    setActivity((prev) => [...prev, {
      id: `reanalysing-${prNumber}-${Date.now()}`,
      type: 'github_notification',
      payload: { message: `⟳ Analysing PR #${prNumber} by @${author}…`, category: 'reanalysing' },
    }].slice(-50));
  }, []);

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
    notifyReanalysing,
    authRejected, setAuthRejected,
    prList, selectedPrIdx, prComments, selectedPrCommentIdx,
    explorerMode, loadingPrs, loadingPrComments,
    selectedPlanId, expandedComments, avoidWords, newAvoidWord, setNewAvoidWord,
    hasNewEvent, visiblePlans,

    // what the keys drive
    setView, setExplorerMode, setSelectedPrIdx, setSelectedPrCommentIdx, setSelectedPlanId,
    openPrExplorer, openComments, dispatchComment, addAvoidWord, togglePlanExpanded,
    clearNewEvent,

    /**
     * The bindings the hint row no longer has space for.
     *
     * Four fit on a line at 78 columns; seven wrapped and stranded a separator.
     * The other three did not stop existing, so `?` has to say where they went.
     */
    showHelp: () => setView((v) => (v === 'help' ? 'activity' : 'help')),

    /** True while a text field on the tab owns the letters — see use-github-keys. */
    get isTyping() {
      return !agentLoop.githubHandler || authRejected || view === 'avoid_words';
    },
  };
}
