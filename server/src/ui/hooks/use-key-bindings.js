import { useInput } from 'ink';
import { exec } from 'child_process';
import { FOCUS_INPUT, FOCUS_TERMINAL } from '../constants.js';

/**
 * Every keystroke the app answers outside a text field.
 *
 * Order matters here and is load-bearing: a pending diff swallows everything,
 * the GitHub tab claims its own letters before the agent hotkeys see them, and
 * Shift+Tab is checked ahead of plain Tab, which would otherwise eat it.
 *
 * There is no selection model in the transcript — rows are opened by clicking
 * them, with Ctrl+E as the way in when the mouse isn't available (tmux without
 * mouse mode, a bare ssh session). That keeps ↑/↓ meaning one thing: input
 * history — which is why recalling a "/command" suppresses the slash palette
 * rather than handing it these arrows.
 */
export function useKeyBindings({
  activeTab,
  agentLoop,
  cycleMode,
  diffRequest,
  explorerMode,
  focus,
  githubActivity,
  githubView,
  handleSubmit,
  historyIdx,
  inputHistory,
  isProcessing,
  latestTurnId,
  newlineRef,
  prComments,
  prList,
  selectedPlanId,
  selectedPrCommentIdx,
  selectedPrIdx,
  setActiveTab,
  setExpandedComments,
  setExpandedLogIds,
  setExplorerMode,
  setFocus,
  setGithubView,
  setHasNewGitHubEvent,
  setHistoryIdx,
  setInput,
  setPaletteSuppressed,
  setLoadingPrComments,
  setLoadingPrs,
  setPrComments,
  setPrList,
  setSelectedPlanId,
  setSelectedPrCommentIdx,
  setSelectedPrIdx,
  setSlashIdx,
  setTerminalOpen,
  slashMatches,
  slashOpen,
  slashSelected,
}) {
  useInput((char, key) => {
    if (diffRequest) {
      // Deliberately inert: the diff is answered through the SelectInput below,
      // so a stray keystroke can never approve or reject an edit.
      return;
    }

    // Shift+Enter inserts a newline instead of submitting. Terminals only
    // report the modifier under the kitty keyboard protocol, which Ink
    // negotiates in cli-ui; Esc+Enter (\x1b\r) is the fallback terminals are
    // commonly configured to send, and reaches us as meta+return.
    if (key.return && (key.shift || key.meta)) {
      newlineRef.current = true;
      setInput((value) => `${value}\n`);
      return;
    }

    // Toggle Tabs (Ctrl+O)
    if (key.ctrl && char === 'o') {
      setActiveTab(prev => {
        const next = prev === 'agent' ? 'github' : 'agent';
        if (next === 'github') setHasNewGitHubEvent(false);
        return next;
      });
      return;
    }

    if (activeTab === 'github') {
      if (!agentLoop.githubHandler) {
        return; // Skip 'r' and navigation keys when on setup screen
      }

      if (char === 'r' || char === 'R') {
        handleSubmit('/github refresh');
        return;
      }
      
      if (char === 'a' || char === 'A') {
        setGithubView(prev => prev === 'avoid_words' ? 'activity' : 'avoid_words');
        return;
      }

      if (char === 'p' || char === 'P') {
        const willOpen = githubView !== 'pr_explorer';
        setGithubView(willOpen ? 'pr_explorer' : 'activity');
        
        // If we are opening the explorer, fetch fresh PRs
        if (willOpen) {
          setLoadingPrs(true);
          try {
            if (agentLoop?.githubHandler?.fetchAllOpenPRs) {
              agentLoop.githubHandler.fetchAllOpenPRs()
                .then(prs => {
                  setPrList(prs || []);
                  setSelectedPrIdx(0);
                })
                .catch(() => {
                  setPrList([]);
                })
                .finally(() => {
                  setLoadingPrs(false);
                });
            } else {
              setLoadingPrs(false);
            }
          } catch (err) {
            setLoadingPrs(false);
          }
        }
        return;
      }

      if (key.escape) {
        if (githubView === 'pr_explorer' && explorerMode === 'comments') {
          setExplorerMode('prs');
          return;
        }
        if (githubView !== 'activity') {
          setGithubView('activity');
          return;
        }
      }
      
      if (githubView === 'pr_explorer') {
        if (explorerMode === 'prs') {
          if (key.upArrow) setSelectedPrIdx(prev => Math.max(0, prev - 1));
          if (key.downArrow) setSelectedPrIdx(prev => Math.min(prList.length - 1, prev + 1));
          if (key.return && prList.length > 0) {
             const pr = prList[selectedPrIdx];
             if (pr && agentLoop?.githubHandler?.poller) {
               setLoadingPrComments(true);
               setPrComments([]);
               setExplorerMode('comments');
               setSelectedPrCommentIdx(0);
               agentLoop.githubHandler.poller.fetchAllComments(pr)
                 .then(comments => { setPrComments(comments || []); })
                 .catch(() => { setPrComments([]); })
                 .finally(() => { setLoadingPrComments(false); });
             }
          }
        } else if (explorerMode === 'comments') {
          if (key.upArrow) setSelectedPrCommentIdx(prev => Math.max(0, prev - 1));
          if (key.downArrow) setSelectedPrCommentIdx(prev => Math.min(prComments.length - 1, prev + 1));
          if (key.return && prComments.length > 0) {
             const pr = prList[selectedPrIdx];
             const comment = prComments[selectedPrCommentIdx];
             if (agentLoop?.githubHandler?.forceAnalyzeComment && pr && comment) {
               // Show feedback immediately, run analysis in background
               setGithubView('activity');
               agentLoop.githubHandler.forceAnalyzeComment(pr, comment).catch(() => {});
             } else {
               setGithubView('activity');
             }
          }
        }
        return;
      }

      const visiblePlans = githubActivity.slice().reverse().filter(a => a.type === 'github_plan_generated').slice(0, 10);
      let currentIdx = visiblePlans.findIndex(p => p.id === selectedPlanId);
      if (currentIdx === -1 && visiblePlans.length > 0) currentIdx = 0;
      
      if (key.upArrow) {
        if (visiblePlans.length > 0) {
          const nextIdx = Math.max(0, currentIdx - 1);
          setSelectedPlanId(visiblePlans[nextIdx].id);
        }
        return;
      }
      if (key.downArrow) {
        if (visiblePlans.length > 0) {
          const nextIdx = Math.min(visiblePlans.length - 1, currentIdx + 1);
          setSelectedPlanId(visiblePlans[nextIdx].id);
        }
        return;
      }
      if (key.return) {
        const item = visiblePlans[currentIdx];
        if (item && item.payload?.filePath) {
          try {
            exec(`"${agentLoop.editor || 'code'}" "${item.payload.filePath}" || open "${item.payload.filePath}" || xdg-open "${item.payload.filePath}"`);
          } catch(e) {}
        }
        return;
      }
      if (char === ' ') {
        const item = visiblePlans[currentIdx];
        if (item) {
          setExpandedComments(prev => {
            const next = new Set(prev);
            if (next.has(item.id)) next.delete(item.id);
            else next.add(item.id);
            return next;
          });
        }
        return;
      }
      return; // Skip agent tab hotkeys when on github tab
    }

    // Ctrl+V for paste-image
    if (key.ctrl && char === 'v') {
      handleSubmit('/paste-image');
      return;
    }

    // Toggle Focus between Input and Chat (Tool Logs)
    // Shift+Tab cycles Plan <-> Auto, like Claude Code. Checked before the
    // plain Tab handler, which would otherwise swallow it.
    if (key.tab && key.shift) {
      cycleMode();
      return;
    }

    // While the slash palette is open it owns navigation and completion.
    if (slashOpen) {
      if (key.upArrow) {
        setSlashIdx(Math.max(0, slashSelected - 1));
        return;
      }
      if (key.downArrow) {
        setSlashIdx(Math.min(slashMatches.length - 1, slashSelected + 1));
        return;
      }
      if (key.tab) {
        setInput(`/${slashMatches[slashSelected].name} `);
        setSlashIdx(0);
        return;
      }
      if (key.escape) {
        setInput('');
        setSlashIdx(0);
        return;
      }
    }

    // Agent Terminal Shortcut (Ctrl+T)
    if (key.ctrl && char === 't') {
      setTerminalOpen(prev => {
        setFocus(prev ? FOCUS_INPUT : FOCUS_TERMINAL);
        return !prev;
      });
      return;
    }

    // Escape cancels processing if active, or returns to Input
    if (key.escape) {
      if (isProcessing) {
        handleSubmit(':stop');
        return;
      }
      setTerminalOpen(false);
      setFocus(FOCUS_INPUT);
      return;
    }

    // Input history
    {
      if (key.upArrow) {
        if (inputHistory.length > 0) {
          const nextIdx = historyIdx === -1 ? inputHistory.length - 1 : Math.max(0, historyIdx - 1);
          setHistoryIdx(nextIdx);
          setInput(inputHistory[nextIdx]);
          // A recalled "/command" must not open the palette, which would take
          // these very arrows over and strand the user mid-scroll.
          setPaletteSuppressed(true);
        }
        return;
      }
      if (key.downArrow) {
        if (historyIdx !== -1) {
          const nextIdx = historyIdx + 1;
          if (nextIdx >= inputHistory.length) {
            setHistoryIdx(-1);
            setInput('');
            setPaletteSuppressed(false);
          } else {
            setHistoryIdx(nextIdx);
            setInput(inputHistory[nextIdx]);
            setPaletteSuppressed(true);
          }
        }
        return;
      }
    }

    // Keyboard way into the latest turn's actions, for when clicking isn't
    // available. Only the live turn can open at all — <Static> never repaints.
    if (key.ctrl && char === 'e') {
      if (latestTurnId !== null) {
        setExpandedLogIds(prev => {
          const next = new Set(prev);
          const id = `turn_${latestTurnId}`;
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
      }
      return;
    }
  });
}
