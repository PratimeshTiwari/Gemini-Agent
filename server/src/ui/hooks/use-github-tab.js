import { exec } from 'child_process';
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
 *
 * ## One list, three levels
 *
 * There used to be two lists. An *activity* feed — comments the agent had
 * processed, grouped by PR — which is where you landed; and a *PR explorer*
 * behind an unadvertised `p`. They showed overlapping things, `⏎` meant
 * something different in each, and the feed was empty on a fresh session even
 * with open PRs sitting right there.
 *
 * The recorded decision is that the tab is for **browsing** and the transcript
 * is for **noticing** — every event already arrives there as one dim row. So
 * the feed is not a view any more. It is the *evidence*: `prSummary` folds it
 * into "what does the agent know about each PR", which is what the PR rows
 * show and what the comment rows join against.
 *
 * What is left is a drill-down, which is a shape nobody has to learn:
 *
 * ```
 *   PRs  ─⏎→  comments on one PR  ─⏎→  the analysis, in your editor
 *        ←esc                     ←esc
 * ```
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

/**
 * What the agent knows about each PR, folded out of the events it has seen.
 *
 * Exported and pure because it is the one piece of real logic on this tab —
 * everything else is a fetch or a keypress — and because the counts it
 * produces are what both list levels are drawn from.
 *
 * Keyed by comment id with **the latest event winning**, not counted as it
 * goes: re-analysing a comment emits a second `plan_generated` for the same
 * comment, so a running total would say "3 comments" for a PR with one, and
 * would keep the stale `analysed: false` alongside the fresh `true`.
 *
 * @param {Array<{type: string, payload: object, timestamp?: number}>} activity
 * @returns {Map<number, {comments: number, notAnalysed: number, lastAt: number,
 *   title: string, pr: object, plans: Map<number, object>}>}
 */
export function summarisePrs(activity) {
  const byPr = new Map();

  for (const item of activity || []) {
    if (item?.type !== 'github_plan_generated') continue;
    const payload = item.payload || {};
    const number = payload.prNumber;
    if (number == null) continue;

    if (!byPr.has(number)) {
      byPr.set(number, {
        comments: 0, notAnalysed: 0, lastAt: 0,
        title: payload.prTitle, pr: payload.pr, plans: new Map(),
      });
    }
    const summary = byPr.get(number);
    summary.lastAt = Math.max(summary.lastAt, item.timestamp || 0);
    if (payload.prTitle) summary.title = payload.prTitle;
    if (payload.pr) summary.pr = payload.pr;

    const commentId = payload.comment?.id;
    // A CI-failure plan has no comment. It still counts as something the agent
    // wrote about this PR, so it gets a synthetic key rather than being lost.
    summary.plans.set(commentId == null ? `${item.type}:${item.id}` : commentId, item);
  }

  for (const summary of byPr.values()) {
    summary.comments = summary.plans.size;
    summary.notAnalysed = [...summary.plans.values()]
      .filter((p) => p.payload?.analysed === false).length;
  }
  return byPr;
}

export function useGithubTab({ agentLoop, wsServer, activeTab, setHistory }) {
  const [activity, setActivity] = useState([]);
  const [hasNewEvent, setHasNewEvent] = useState(false);
  // prs | comments | avoid_words | help. `prs` is the landing screen, because
  // "which of my PRs needs me" is the question the tab exists to answer.
  const [view, setView] = useState('prs');
  const [error, setError] = useState('');
  // A rejected token is terminal: the poller has stopped, so the tab shows the
  // setup screen again rather than a dashboard that will never fill in.
  const [authRejected, setAuthRejected] = useState(false);
  const [setupToken, setSetupToken] = useState('');

  const [prList, setPrList] = useState([]);
  const [selectedPrIdx, setSelectedPrIdx] = useState(0);
  const [prComments, setPrComments] = useState([]);
  const [selectedPrCommentIdx, setSelectedPrCommentIdx] = useState(0);
  const [loadingPrs, setLoadingPrs] = useState(false);
  const [loadingPrComments, setLoadingPrComments] = useState(false);

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
          setView('prs');
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

  /** Put a line on the GitHub screen, where GitHub output belongs. */
  const notify = useCallback((message) => {
    if (!message) return;
    setActivity((prev) => [...prev, {
      id: `note-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type: 'github_notification',
      payload: { message, category: 'command' },
    }].slice(-50));
    setHasNewEvent(true);
  }, []);

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

  const prSummary = useMemo(() => summarisePrs(activity), [activity]);

  /**
   * The PRs to draw: what GitHub returned, plus any the agent has events for.
   *
   * The union matters on the path that used to leave the screen blank. The
   * fetch is a network call and can be slow, refused or simply not have
   * happened yet — and on a fresh session that is exactly when the events are
   * the only thing there is. A list that says "no open PRs" while the
   * transcript is showing comments from one is worse than a slightly stale row.
   *
   * Ordered by most recent activity, then by number. "Which PR needs me" is
   * answered by what happened last, not by what GitHub sorts by.
   */
  const prs = useMemo(() => {
    const byNumber = new Map();
    for (const pr of prList) if (pr?.number != null) byNumber.set(pr.number, pr);
    for (const [number, summary] of prSummary) {
      if (!byNumber.has(number)) {
        byNumber.set(number, summary.pr || { number, title: summary.title });
      }
    }
    return [...byNumber.values()].sort((a, b) => {
      const at = prSummary.get(a.number)?.lastAt || 0;
      const bt = prSummary.get(b.number)?.lastAt || 0;
      return at === bt ? b.number - a.number : bt - at;
    });
  }, [prList, prSummary]);

  const selectedPr = prs[Math.min(selectedPrIdx, Math.max(0, prs.length - 1))] || null;

  /**
   * The selected PR's comments, each joined to the agent's analysis of it.
   *
   * `analysed` is true only when there is a plan *and* it has an analysis in
   * it. Everything else — no plan at all, or a plan that is the placeholder
   * saying the analysis did not run — is one state, because `⏎` does the same
   * thing for both: go and get the analysis.
   */
  const commentRows = useMemo(() => {
    const plans = selectedPr ? (prSummary.get(selectedPr.number)?.plans || new Map()) : new Map();
    return prComments.map((comment) => {
      const plan = plans.get(comment.id) || null;
      return {
        comment,
        plan,
        analysed: Boolean(plan && plan.payload?.analysed !== false),
        filePath: plan?.payload?.filePath || null,
      };
    });
  }, [selectedPr, prComments, prSummary]);

  const refreshPrs = useCallback(() => {
    if (!agentLoop?.githubHandler?.fetchAllOpenPRs) return;
    setLoadingPrs(true);
    agentLoop.githubHandler.fetchAllOpenPRs()
      .then((fetched) => setPrList(fetched || []))
      .catch((err) => setError(String(err?.message || err)))
      .finally(() => setLoadingPrs(false));
  }, [agentLoop]);

  /**
   * Fetch the PRs when the tab is opened, not when a hidden key is pressed.
   *
   * The list used to arrive only via `p`, which nothing advertised — so the
   * screen most people saw was the one with no PRs on it. Refetching on every
   * open is a request per `^o`, which is the same order as the poller already
   * makes on its own interval.
   */
  useEffect(() => {
    if (activeTab === 'github' && !authRejected && agentLoop?.githubHandler) refreshPrs();
  }, [activeTab, authRejected, refreshPrs, agentLoop]);

  const openComments = useCallback(() => {
    if (!selectedPr || !agentLoop?.githubHandler?.poller) return;
    setLoadingPrComments(true);
    setPrComments([]);
    setView('comments');
    setSelectedPrCommentIdx(0);
    agentLoop.githubHandler.poller.fetchAllComments(selectedPr)
      .then((comments) => setPrComments(comments || []))
      .catch((err) => {
        setPrComments([]);
        setError(String(err?.message || err));
      })
      .finally(() => setLoadingPrComments(false));
  }, [agentLoop, selectedPr]);

  /**
   * Level three: the analysis. Open it, or go and make it first.
   *
   * One key for both, because that is what was asked for — "clicking an old
   * comment should start the agent analysis (if not done previously) or open
   * the analysis file". Splitting it into two keys would mean knowing which
   * state the row is in before choosing a key, which is the thing the row's
   * own marker is there to save you.
   *
   * `force` is load-bearing on the analyse path: the queue remembers what it
   * has already seen, so without it a second attempt is treated as a duplicate
   * and does nothing at all — indistinguishable from the key not working.
   */
  const openOrAnalyse = useCallback(() => {
    const row = commentRows[selectedPrCommentIdx];
    if (!row || !selectedPr) return;

    if (row.analysed && row.filePath) {
      const file = row.filePath;
      try {
        exec(`"${agentLoop.editor || 'code'}" "${file}" || open "${file}" || xdg-open "${file}"`);
      } catch {
        /* no editor on this machine; the path is in the row either way */
      }
      return;
    }

    // `forceAnalyzeComment` rather than a bare force-enqueue: it also deletes
    // the stale plan file — which on this path is usually the placeholder
    // saying the analysis did not run — and refuses when this exact comment is
    // already being analysed, so leaning on the key does not queue it twice.
    const handler = agentLoop.githubHandler;
    const pr = row.plan?.payload?.pr || selectedPr;
    if (handler?.forceAnalyzeComment) {
      handler.forceAnalyzeComment(pr, row.comment).catch(() => {});
    } else {
      handler?._enqueueComment?.({ pr, comment: row.comment, force: true });
    }
    setError('');
    notifyReanalysing(selectedPr.number, row.comment.author);
  }, [agentLoop, commentRows, selectedPrCommentIdx, selectedPr, notifyReanalysing]);

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

  const toggleCommentExpanded = useCallback((id) => {
    setExpandedComments((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const clearNewEvent = useCallback(() => setHasNewEvent(false), []);

  /** The newest one-line notice, which is where GitHub command output goes. */
  const lastNotice = useMemo(() => {
    for (let i = activity.length - 1; i >= 0; i--) {
      if (activity[i]?.type === 'github_notification') return activity[i].payload?.message || null;
    }
    return null;
  }, [activity]);

  return {
    // state the screen draws
    activity, view, error, setupToken, setSetupToken, setError,
    notify,
    notifyReanalysing,
    authRejected, setAuthRejected,
    prs, prSummary, selectedPr, selectedPrIdx,
    commentRows, selectedPrCommentIdx,
    loadingPrs, loadingPrComments,
    expandedComments, avoidWords, newAvoidWord, setNewAvoidWord,
    hasNewEvent, lastNotice,

    // what the keys drive
    setView, setSelectedPrIdx, setSelectedPrCommentIdx,
    refreshPrs, openComments, openOrAnalyse, addAvoidWord, toggleCommentExpanded,
    clearNewEvent,

    /**
     * The bindings the hint row no longer has space for.
     *
     * Four fit on a line at 78 columns; seven wrapped and stranded a separator.
     * The other three did not stop existing, so `?` has to say where they went.
     */
    showHelp: () => setView((v) => (v === 'help' ? 'prs' : 'help')),

    /** True while a text field on the tab owns the letters — see use-github-keys. */
    get isTyping() {
      return !agentLoop.githubHandler || authRejected || view === 'avoid_words';
    },
  };
}
