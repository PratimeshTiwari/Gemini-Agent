import { useInput } from 'ink';
import { exec } from 'child_process';
import { FOCUS_INPUT, FOCUS_TERMINAL } from '../constants.js';

/**
 * Every keystroke the app answers outside a text field.
 *
 * The rule this enforces: **printable characters belong to the writing area and
 * nothing else.** Everything this hook claims is either a modifier combination
 * (ctrl+…, shift+tab) or a key that has no business in a prompt (escape, the
 * arrows, tab). The one exception is the GitHub tab, which is a dashboard
 * rather than a prompt — and even there the plain letters are given back the
 * moment a field on it is focused, which is why `a` used to be unusable in the
 * avoid-words editor.
 *
 * Order matters and is load-bearing: a pending diff or an open menu swallows
 * everything so a stray key can never answer for the user, the GitHub tab
 * claims its own letters before the agent hotkeys see them, and shift+tab is
 * checked ahead of plain tab, which would otherwise eat it.
 *
 * There is no selection model in the transcript and no mouse. Steps open with
 * ctrl+e, which toggles the whole transcript at once — Ink can never repaint
 * what <Static> has already committed, so App reprints it instead.
 */
export function useKeyBindings({
  activeMenu,
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
  newlineRef,
  prComments,
  prList,
  selectedPlanId,
  selectedPrCommentIdx,
  selectedPrIdx,
  setActiveTab,
  setExpandedComments,
  setExplorerMode,
  setFocus,
  setGithubView,
  setHasNewGitHubEvent,
  setHistoryIdx,
  setInput,
  setLoadingPrComments,
  setLoadingPrs,
  setPaletteSuppressed,
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
  toggleVerbose,
}) {
  useInput((char, key) => {
    // Deliberately inert while a modal owns the screen: diffs and menus are
    // answered through their own SelectInput, so a stray keystroke can never
    // approve an edit or pick an option. Without this the arrow keys would move
    // the menu *and* rewrite the prompt from input history at the same time.
    if (diffRequest || activeMenu) return;

    // Shift+Enter inserts a newline instead of submitting. Terminals only
    // report the modifier under the kitty keyboard protocol, which Ink
    // negotiates in cli-ui; Esc+Enter (\x1b\r) is the fallback terminals are
    // commonly configured to send, and reaches us as meta+return.
    if (key.return && (key.shift || key.meta)) {
      newlineRef.current = true;
      setInput((value) => `${value}\n`);
      return;
    }

    // Toggle tabs (ctrl+o)
    if (key.ctrl && char === 'o') {
      setActiveTab(prev => {
        const next = prev === 'agent' ? 'github' : 'agent';
        if (next === 'github') setHasNewGitHubEvent(false);
        return next;
      });
      return;
    }

    if (activeTab === 'github') {
      // The setup screen and the avoid-words editor both own a text field.
      // Letters are theirs while one of those is up, not the dashboard's.
      const typingOnTab = !agentLoop.githubHandler || githubView === 'avoid_words';

      if (key.escape) {
        if (githubView === 'pr_explorer' && explorerMode === 'comments') {
          setExplorerMode('prs');
          return;
        }
        if (githubView !== 'activity') {
          setGithubView('activity');
          return;
        }
        setActiveTab('agent');
        return;
      }

      if (typingOnTab) return;

      if (char === 'r' || char === 'R') {
        handleSubmit('/github refresh');
        return;
      }

      if (char === 'a' || char === 'A') {
        setGithubView(prev => (prev === 'avoid_words' ? 'activity' : 'avoid_words'));
        return;
      }

      if (char === 'p' || char === 'P') {
        const willOpen = githubView !== 'pr_explorer';
        setGithubView(willOpen ? 'pr_explorer' : 'activity');
        if (willOpen) {
          setLoadingPrs(true);
          setExplorerMode('prs');
          try {
            if (agentLoop?.githubHandler?.fetchAllOpenPRs) {
              agentLoop.githubHandler.fetchAllOpenPRs()
                .then(prs => {
                  setPrList(prs || []);
                  setSelectedPrIdx(0);
                })
                .catch(() => setPrList([]))
                .finally(() => setLoadingPrs(false));
            } else {
              setLoadingPrs(false);
            }
          } catch (err) {
            setLoadingPrs(false);
          }
        }
        return;
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
                .then(comments => setPrComments(comments || []))
                .catch(() => setPrComments([]))
                .finally(() => setLoadingPrComments(false));
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
        if (visiblePlans.length > 0) setSelectedPlanId(visiblePlans[Math.max(0, currentIdx - 1)].id);
        return;
      }
      if (key.downArrow) {
        if (visiblePlans.length > 0) {
          setSelectedPlanId(visiblePlans[Math.min(visiblePlans.length - 1, currentIdx + 1)].id);
        }
        return;
      }
      if (key.return) {
        const item = visiblePlans[currentIdx];
        if (item && item.payload?.filePath) {
          try {
            exec(`"${agentLoop.editor || 'code'}" "${item.payload.filePath}" || open "${item.payload.filePath}" || xdg-open "${item.payload.filePath}"`);
          } catch (e) {}
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
      return; // Skip agent tab hotkeys when on the github tab
    }

    // Ctrl+V for paste-image
    if (key.ctrl && char === 'v') {
      handleSubmit('/paste-image');
      return;
    }

    // Expand or collapse every step in the transcript (ctrl+e). App reprints
    // the transcript so committed turns pick up the new setting too.
    if (key.ctrl && char === 'e') {
      toggleVerbose();
      return;
    }

    // Shift+Tab cycles plan <-> auto. Checked before the plain Tab handler,
    // which would otherwise swallow it.
    if (key.tab && key.shift) {
      cycleMode();
      return;
    }

    // Agent terminal (ctrl+t)
    if (key.ctrl && char === 't') {
      setTerminalOpen(prev => {
        setFocus(prev ? FOCUS_INPUT : FOCUS_TERMINAL);
        return !prev;
      });
      return;
    }

    // Escape cancels processing if active, otherwise closes whatever is open
    // and puts the caret back in the prompt.
    if (key.escape) {
      if (slashOpen) {
        setInput('');
        setSlashIdx(0);
        return;
      }
      if (isProcessing) {
        handleSubmit(':stop');
        return;
      }
      setTerminalOpen(false);
      setFocus(FOCUS_INPUT);
      return;
    }

    // Tab completes an open slash command, and is otherwise the way back to the
    // writing area — the prompt used to advertise it and do nothing.
    if (key.tab) {
      if (slashOpen) {
        setInput(`/${slashMatches[slashSelected].name} `);
        setSlashIdx(0);
        return;
      }
      setTerminalOpen(false);
      setFocus(FOCUS_INPUT);
      return;
    }

    // The scratch shell owns its own arrows.
    if (focus === FOCUS_TERMINAL) return;

    if (key.upArrow) {
      if (slashOpen) {
        setSlashIdx(Math.max(0, slashSelected - 1));
        return;
      }
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
      if (slashOpen) {
        setSlashIdx(Math.min(slashMatches.length - 1, slashSelected + 1));
        return;
      }
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
    }
  });
}
