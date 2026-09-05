import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useApp, useStdout, Static } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import Gradient from 'ink-gradient';
import crypto from 'crypto';
import { useMouseTracking } from './mouse.jsx';
import { Clickable } from './components/Clickable.jsx';
import { GithubTab } from './components/GithubTab.jsx';
import { Menus, DiffApproval } from './components/Menus.jsx';
import { Banner } from './components/Banner.jsx';
import { TranscriptTurn } from './components/TranscriptTurn.jsx';
import { AgentTerminal } from './components/AgentTerminal.jsx';
import { InputBar } from './components/InputBar.jsx';
import { marked, oneLine, summarizeResult, clampForDisplay } from './format.js';
import { SLASH_COMMANDS, FOCUS_CHAT, FOCUS_INPUT, FOCUS_TERMINAL, THINKING_MESSAGES } from './constants.js';
import { groupTurns, collectFocusableItems, parseTurnActions } from './transcript.js';
import { useKeyBindings } from './hooks/use-key-bindings.js';
import { handleSlashCommand } from './hooks/use-slash-commands.js';
import { buildAgentCallbacks } from './hooks/use-agent-callbacks.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import figlet from 'figlet';
import * as paths from '../core/paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));


export function App({ agentLoop, wsServer }) {
  const { exit } = useApp();
  const [input, setInput] = useState('');
  const [history, setHistory] = useState([...agentLoop.conversationHistory]);
  const [activeToolCalls, setActiveToolCalls] = useState([]);
  const [agentNameAscii, setAgentNameAscii] = useState(() => {
    let name = 'Gemini Agent';
    try {
      const configPath = paths.configPath(agentLoop.workspace);
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const custom = config.agentName || config.agent_name;
        if (custom) name = `${custom} Agent`;
      }
    } catch (e) {}
    try {
      return figlet.textSync(name, { font: 'Standard' }) || name;
    } catch (e) {
      return name;
    }
  });

  useEffect(() => {
    let name = 'Gemini Agent';
    try {
      const configPath = paths.configPath(agentLoop.workspace);
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const custom = config.agentName || config.agent_name;
        if (custom) name = `${custom} Agent`;
      }
    } catch (e) {}
    figlet.text(name, { font: 'Standard' }, (err, data) => {
      if (!err && data) setAgentNameAscii(data);
      else setAgentNameAscii(name);
    });
  }, [agentLoop.workspace]);

  const [isProcessing, setIsProcessing] = useState(false);
  const [status, setStatus] = useState('');
  const [thinkingIndex, setThinkingIndex] = useState(0);
  const [diffRequest, setDiffRequest] = useState(null);
  const [tasks, setTasks] = useState([]);
  
  // Extension Connection Polling
  const [extensionConnected, setExtensionConnected] = useState(false);
  useEffect(() => {
    if (!wsServer) return;
    const checkConnection = () => {
      const connected = wsServer.clients && wsServer.clients.size > 0;
      setExtensionConnected(connected);
    };
    checkConnection();
    const interval = setInterval(checkConnection, 1000);
    return () => clearInterval(interval);
  }, [wsServer]);
  
  // Timeout Warning
  const [isThinkingTooLong, setIsThinkingTooLong] = useState(false);
  useEffect(() => {
    let timer;
    if (isProcessing) {
      timer = setTimeout(() => {
        setIsThinkingTooLong(true);
      }, 10000);
    } else {
      setIsThinkingTooLong(false);
    }
    return () => clearTimeout(timer);
  }, [isProcessing]);

  // UI State
  const [focus, setFocus] = useState(FOCUS_INPUT);
  const [expandedLogIds, setExpandedLogIds] = useState(new Set());
  // Bumping this remounts <Static>. Ink commits Static output permanently and
  // never repaints it, so shrinking the item list (/clear, /new, compaction)
  // would otherwise leave the old transcript stranded on screen.
  const [staticEpoch, setStaticEpoch] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [slashIdx, setSlashIdx] = useState(0);
  const [mode, setMode] = useState(agentLoop.mode || 'plan');
  const [expandedComments, setExpandedComments] = useState(new Set());
  const [selectedToolIdx, setSelectedToolIdx] = useState(-1);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalInput, setTerminalInput] = useState('');
  const [pendingImage, setPendingImage] = useState(null);
  const [activeMenu, setActiveMenu] = useState(null);
  const [planReviewReady, setPlanReviewReady] = useState(false);
  const [walkthroughReady, setWalkthroughReady] = useState(false);
  const [artifacts, setArtifacts] = useState({ task: null, walkthrough: null });
  const [inputHistory, setInputHistory] = useState([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  // Set by the key bindings when Enter carried a modifier, read by InputBar's
  // deferred submit. A ref because the two run in the same event dispatch.
  const newlineRef = useRef(false);
  const [activeTab, setActiveTab] = useState('agent'); // 'agent' | 'github'
  const [githubActivity, setGithubActivity] = useState([]);
  const [selectedPlanId, setSelectedPlanId] = useState(null);
  const [hasNewGitHubEvent, setHasNewGitHubEvent] = useState(false);
  const [githubView, setGithubView] = useState("activity");
  const [prList, setPrList] = useState([]);
  const [selectedPrIdx, setSelectedPrIdx] = useState(0);
  const [prComments, setPrComments] = useState([]);
  const [selectedPrCommentIdx, setSelectedPrCommentIdx] = useState(0);
  const [explorerMode, setExplorerMode] = useState("prs");
  const [loadingPrs, setLoadingPrs] = useState(false);
  const [loadingPrComments, setLoadingPrComments] = useState(false);

  const { stdout } = useStdout();

  /**
   * Discard everything already painted, including Ink's committed <Static>
   * output and the terminal scrollback, so a cleared session really is clear.
   */
  // The palette is open whenever the input is a bare "/word" with no argument yet.
  const slashQuery = focus === FOCUS_INPUT && /^\/[a-z-]*$/i.test(input) ? input.slice(1).toLowerCase() : null;
  const slashMatches = slashQuery === null
    ? []
    : SLASH_COMMANDS.filter((c) => c.name.startsWith(slashQuery)).slice(0, 8);
  const slashOpen = slashMatches.length > 0;
  const slashSelected = Math.min(slashIdx, Math.max(0, slashMatches.length - 1));

  const mouseTracking = useMouseTracking();

  const cycleMode = React.useCallback(() => {
    const next = (agentLoop.mode || 'plan') === 'plan' ? 'auto' : 'plan';
    agentLoop.mode = next;
    setMode(next);
  }, [agentLoop]);

  // Drives the "(12s · ↑ 1.2k tokens)" counter. One timer, one small state
  // update per second — it does not re-render the transcript rows.
  useEffect(() => {
    if (!isProcessing) {
      setElapsed(0);
      return undefined;
    }
    const startedAt = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(id);
  }, [isProcessing]);

  const toggleExpanded = React.useCallback((id) => {
    setExpandedLogIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const resetScreen = React.useCallback(() => {
    try {
      // 2J clears the screen, 3J drops scrollback, H homes the cursor.
      (stdout || process.stdout).write('\x1b[2J\x1b[3J\x1b[H');
    } catch {
      /* non-TTY: nothing painted to discard */
    }
    setStaticEpoch((n) => n + 1);
  }, [stdout]);
  const [terminalHeight, setTerminalHeight] = useState(stdout ? stdout.rows : process.stdout.rows);

  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setTerminalHeight(stdout.rows);
    stdout.on('resize', onResize);
    return () => stdout.off('resize', onResize);
  }, [stdout]);
  const [avoidWords, setAvoidWords] = useState(agentLoop.githubHandler?.config?.avoidWords || []);
  const [newAvoidWord, setNewAvoidWord] = useState("");
  const [githubSetupToken, setGithubSetupToken] = useState('');

  const turns = groupTurns(history);

  const INTERACTIVE_COUNT = 1;
  const staticTurns = turns.slice(0, Math.max(0, turns.length - INTERACTIVE_COUNT));
  const interactiveTurns = turns.slice(Math.max(0, turns.length - INTERACTIVE_COUNT));

  const focusableItems = collectFocusableItems(interactiveTurns, activeToolCalls);

  // Ensure selected tool index is within bounds of all focusable items
  const clampedSelectedToolIdx = Math.min(selectedToolIdx, Math.max(0, focusableItems.length - 1));

  // Sliding window logic removed, relying on interactiveTurns instead.


  useEffect(() => {
    // /plan and /auto mutate agentLoop.mode directly, so mirror it back.
    if (agentLoop.mode !== mode) setMode(agentLoop.mode);
  }, [history, isProcessing, agentLoop.mode, mode]);

  useEffect(() => {
    if (!isProcessing) {
      if (planReviewReady) {
        setActiveMenu({ type: 'plan_review' });
        setPlanReviewReady(false);
        setFocus(FOCUS_INPUT);
        try {
          const implPlanPath = paths.artifactPath(agentLoop.workspace, 'implementation_plan.md');
          const simplePlanPath = paths.artifactPath(agentLoop.workspace, 'plan.md');
          const planPath = fs.existsSync(implPlanPath) ? implPlanPath : simplePlanPath;
          
          exec(`"${agentLoop.editor || 'code'}" "${planPath}" || open "${planPath}" || xdg-open "${planPath}"`);
        } catch (e) {}
      }

      if (walkthroughReady) {
        setWalkthroughReady(false);
        try {
          const walkPath = paths.artifactPath(agentLoop.workspace, 'walkthrough.md');
          
          exec(`"${agentLoop.editor || 'code'}" "${walkPath}" || open "${walkPath}" || xdg-open "${walkPath}"`);
        } catch (e) {}
      }

      try {
        const taskPath = paths.artifactPath(agentLoop.workspace, 'task.md');
        const walkPath = paths.artifactPath(agentLoop.workspace, 'walkthrough.md');

        let taskContent = null;
        let walkContent = null;
        if (fs.existsSync(taskPath)) taskContent = fs.readFileSync(taskPath, 'utf8');
        if (fs.existsSync(walkPath)) walkContent = fs.readFileSync(walkPath, 'utf8');
        
        setArtifacts({ task: taskContent, walkthrough: walkContent });
      } catch (err) {
        // ignore fs errors
      }
    }
  }, [isProcessing, planReviewReady, walkthroughReady, agentLoop.workspace]);

  // Thinking animation: calm typing pace with pause to read each message
  const [thinkingDisplayText, setThinkingDisplayText] = useState('');
  const thinkingIdxRef = useRef(0);
  const thinkingCharRef = useRef(0);
  const pauseTicksRef = useRef(0);
  const isToolRunningRef = useRef(false);
  useEffect(() => {
    if (!isProcessing) {
      setThinkingDisplayText('');
      thinkingIdxRef.current = 0;
      thinkingCharRef.current = 0;
      pauseTicksRef.current = 0;
      isToolRunningRef.current = false;
      return;
    }
    const interval = setInterval(() => {
      // If a tool is actively running, show that status instead of cycling
      if (isToolRunningRef.current) return;

      const currentMsg = THINKING_MESSAGES[thinkingIdxRef.current] || 'Thinking...';
      if (thinkingCharRef.current < currentMsg.length) {
        thinkingCharRef.current++;
        setThinkingDisplayText(currentMsg.substring(0, thinkingCharRef.current));
      } else {
        // Pause for ~1.5s (20 * 75ms) after typing before advancing so user can read
        pauseTicksRef.current++;
        if (pauseTicksRef.current >= 20) {
          pauseTicksRef.current = 0;
          thinkingIdxRef.current = (thinkingIdxRef.current + 1) % THINKING_MESSAGES.length;
          thinkingCharRef.current = 0;
          setThinkingDisplayText('');
        }
      }
    }, 75);
    return () => clearInterval(interval);
  }, [isProcessing]);

  // Claude Code-style response typing effect (natural, readable cadence)
  const [revealedLength, setRevealedLength] = useState(Infinity);
  const lastRevealedContent = useRef('');
  useEffect(() => {
    // When processing ends, check if there's a new response to animate
    if (!isProcessing && history.length > 0) {
      const lastMsg = history[history.length - 1];
      if (lastMsg && (lastMsg.role === 'assistant' || lastMsg.role === 'agent') && !lastMsg.isLocal) {
        const cleanContent = (lastMsg.content || '').replace(/<think>[\s\S]*?<\/think>/, '').trim();
        if (cleanContent && cleanContent !== lastRevealedContent.current) {
          lastRevealedContent.current = cleanContent;
          setRevealedLength(0);
          let charPos = 0;
          // Paced reveal: much faster now
          const step = cleanContent.length > 1200 ? 15 : (cleanContent.length > 500 ? 8 : 4);
          const interval = setInterval(() => {
            charPos = Math.min(charPos + step, cleanContent.length);
            setRevealedLength(charPos);
            if (charPos >= cleanContent.length) {
              clearInterval(interval);
              setRevealedLength(Infinity);
            }
          }, 10);
          return () => clearInterval(interval);
        }
      }
    }
  }, [isProcessing, history.length]);

  // Poll active background tasks
  useEffect(() => {
    let lastTasksJson = '[]';
    const updateInterval = setInterval(() => {
      if (agentLoop.taskManager) {
        const currentTasks = agentLoop.taskManager.listTasks();
        const currentTasksJson = JSON.stringify(currentTasks);
        if (currentTasksJson !== lastTasksJson) {
          lastTasksJson = currentTasksJson;
          setTasks(currentTasks);
        }
      }
    }, 1000);

    return () => clearInterval(updateInterval);
  }, [agentLoop]);

  // Poll GitHub Activity
  useEffect(() => {
    const updateInterval = setInterval(() => {
      if (wsServer) {
        const notifications = wsServer.getGitHubNotifications();
        if (notifications.length > 0) {
          setGithubActivity(prev => [...prev, ...notifications].slice(-50)); // keep last 50
          if (activeTab !== 'github') {
            setHasNewGitHubEvent(true);
          }
        }
      }
    }, 1000);
    return () => clearInterval(updateInterval);
  }, [wsServer, activeTab]);

  const handleSubmit = async (query) => {
    if (!query.trim()) return;
    setInputHistory(prev => [...prev, query]);
    setHistoryIdx(-1);
    setInput('');

    const cleanQuery = query.trim().toLowerCase();
    if (cleanQuery === ':stop' || cleanQuery === '/stop') {
      wsServer.broadcast('extension', { type: 'stop_generation', timestamp: Date.now(), id: Date.now().toString() });
      agentLoop.isProcessing = false;
      if (agentLoop.pendingCommandResolve) {
        agentLoop.pendingCommandResolve({ approved: false });
        agentLoop.pendingCommandResolve = null;
      }
      if (agentLoop.pendingQuestionResolve) {
        agentLoop.pendingQuestionResolve({ success: false, result: 'Cancelled by user' });
        agentLoop.pendingQuestionResolve = null;
      }
      setActiveToolCalls([]);
      setDiffRequest(null);
      setActiveMenu(null);
      setIsProcessing(false);
      setStatus('');
      setHistory(prev => [
        ...prev, 
        { role: 'user', content: query }, 
        { role: 'assistant', content: '🛑 Agent forcefully stopped.', isLocal: true }
      ]);
      return;
    }

    setIsProcessing(true);
    setStatus('Thinking...');
    setActiveToolCalls([]);
    
    if (query.startsWith('/')) {
      await handleSlashCommand(query, {
        agentLoop,
        wsServer,
        resetScreen,
        setActiveMenu,
        setHistory,
        setIsProcessing,
        setPendingImage,
        mouseTracking,
      });
      return;
    }

    let messageContent = query;
    if (pendingImage) {
      messageContent = `[Image attached: ${pendingImage.path} (${pendingImage.sizeKB}KB, ${pendingImage.mime})]\n\n<image_data>\ndata:${pendingImage.mime};base64,${pendingImage.base64}\n</image_data>\n\n${query}`;
      setPendingImage(null);
    }

    // Optimistically update the UI so the user sees their prompt immediately
    setHistory(prev => [...prev, { role: 'user', content: query }]);

    const callbacks = buildAgentCallbacks({
      agentLoop,
      isToolRunningRef,
      setActiveMenu,
      setActiveToolCalls,
      setDiffRequest,
      setFocus,
      setHistory,
      setIsProcessing,
      setPlanReviewReady,
      setStatus,
      setWalkthroughReady,
      wsServer,
    });

    await agentLoop.handleUserMessage(messageContent, callbacks);
  };

  const handleDiffResponse = (action) => {
    if (!diffRequest) return;
    agentLoop.handleDiffResponse(Date.now().toString(), { diffId: diffRequest.diffId, action });
    setDiffRequest(null);
  };

  useKeyBindings({
    activeTab,
    agentLoop,
    cycleMode,
    diffRequest,
    explorerMode,
    focus,
    focusableItems,
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
    selectedToolIdx,
    setActiveTab,
    setExpandedComments,
    setExpandedLogIds,
    setExplorerMode,
    setFocus,
    setGithubView,
    setHasNewGitHubEvent,
    setHistoryIdx,
    setInput,
    setLoadingPrComments,
    setLoadingPrs,
    setPrComments,
    setPrList,
    setSelectedPlanId,
    setSelectedPrCommentIdx,
    setSelectedPrIdx,
    setSelectedToolIdx,
    setSlashIdx,
    setTerminalOpen,
    slashMatches,
    slashOpen,
    slashSelected,
  });


  useEffect(() => {
    let approvalInterval;
    if (activeMenu?.type === 'plan_review') {
      approvalInterval = setInterval(() => {
        try {
          const approvalPath = paths.planApprovalPath(agentLoop.workspace);
          if (fs.existsSync(approvalPath)) {
            const data = JSON.parse(fs.readFileSync(approvalPath, 'utf8'));
            fs.unlinkSync(approvalPath); // Delete it immediately
            
            setActiveMenu(null);
            if (data.status === 'accept') {
              handleSubmit('I have reviewed the implementation plan and approve it. Please proceed with the execution phase.');
            } else if (data.status === 'reject') {
              handleSubmit('I reject the implementation plan. Please wait for my feedback.');
            }
          }
        } catch (e) {
          // Ignore errors during polling
        }
      }, 500);
    }
    return () => clearInterval(approvalInterval);
  }, [activeMenu, agentLoop, handleSubmit]);

  // Rough token estimation for the status bar
  const syncTokenEstimate = Math.round(agentLoop.conversationHistory.reduce((sum, turn) => {
    return sum + ((turn.content?.length || 0) / 4);
  }, 0));
  const tokenLimit = 50000;
  const tokenPct = Math.round((syncTokenEstimate / tokenLimit) * 100);
  const tokenColor = tokenPct > 80 ? 'red' : tokenPct > 50 ? 'yellow' : 'cyan';

  return (
    <Box flexDirection="column" width="100%" height={activeTab === 'github' ? terminalHeight : undefined} overflow="hidden">

      {activeTab === 'github' && (
        <GithubTab
          activeTab={activeTab}
          agentLoop={agentLoop}
          wsServer={wsServer}
          avoidWords={avoidWords}
          setAvoidWords={setAvoidWords}
          newAvoidWord={newAvoidWord}
          setNewAvoidWord={setNewAvoidWord}
          githubSetupToken={githubSetupToken}
          setGithubSetupToken={setGithubSetupToken}
          githubView={githubView}
          expandedComments={expandedComments}
          explorerMode={explorerMode}
          githubActivity={githubActivity}
          loadingPrs={loadingPrs}
          loadingPrComments={loadingPrComments}
          prList={prList}
          prComments={prComments}
          selectedPlanId={selectedPlanId}
          selectedPrIdx={selectedPrIdx}
          setSelectedPrIdx={setSelectedPrIdx}
          selectedPrCommentIdx={selectedPrCommentIdx}
          setSelectedPrCommentIdx={setSelectedPrCommentIdx}
          setSelectedPlanId={setSelectedPlanId}
          setExpandedComments={setExpandedComments}
        />
      )}

      {activeTab === 'agent' && (
        <>
          {/* History */}
      <Box flexDirection="column" marginBottom={1}>
        {(() => {
          // Uses the top-level turns/staticTurns/interactiveTurns computed above



          const showBannerInStatic = turns.length > 0;
          const staticItems = showBannerInStatic ? [{ id: 'app-banner', isBanner: true }, ...staticTurns] : staticTurns;

          return (
            <>
              {!showBannerInStatic && <Banner agentLoop={agentLoop} agentNameAscii={agentNameAscii} />}
              {staticItems.length > 0 && (
                <Static key={staticEpoch} items={staticItems}>
                  {(item) => {
                    if (item.isBanner) return <Banner agentLoop={agentLoop} agentNameAscii={agentNameAscii} />;
                    return (
                      <TranscriptTurn
                        turn={item}
                        isLastTurn={false}
                        isProcessingTurn={false}
                        isStatic
                    artifacts={artifacts}
                    clampedSelectedToolIdx={clampedSelectedToolIdx}
                    expandedLogIds={expandedLogIds}
                    focus={focus}
                    focusableItems={focusableItems}
                    revealedLength={revealedLength}
                    status={status}
                    terminalHeight={terminalHeight}
                    toggleExpanded={toggleExpanded}
                      />
                    );
                  }}
                </Static>
              )}
              {interactiveTurns.map((turn, idx) => {
                const isLastTurn = idx === interactiveTurns.length - 1;
                return (
                  <TranscriptTurn
                    key={turn.id}
                    turn={turn}
                    isLastTurn={isLastTurn}
                    isProcessingTurn={isLastTurn && isProcessing}
                    isStatic={false}
                    artifacts={artifacts}
                    clampedSelectedToolIdx={clampedSelectedToolIdx}
                    expandedLogIds={expandedLogIds}
                    focus={focus}
                    focusableItems={focusableItems}
                    revealedLength={revealedLength}
                    status={status}
                    terminalHeight={terminalHeight}
                    toggleExpanded={toggleExpanded}
                  />
                );
              })}
            </>
          );
        })()}
      </Box>
      {/* Tool Calls (Expandable) */}
      {activeToolCalls.length > 0 && (
        <Box flexDirection="column" marginBottom={1} borderStyle="single" borderColor="dim" padding={1}>
          <Text dimColor bold>⚙️ Tool Executions (click, or Tab to focus + Enter)</Text>
          {activeToolCalls.map((call, idx) => {
            const isFocused = focus === FOCUS_CHAT && focusableItems[clampedSelectedToolIdx]?.call === call;
            const isExpanded = expandedLogIds.has(call.id);
            
            return (
              <Box key={call.id} flexDirection="column" marginLeft={1}>
                <Clickable onClick={() => toggleExpanded(call.id)}>
                  <Text color={isFocused ? 'cyan' : 'gray'}>
                    {isFocused ? '▶ ' : '  '}
                    {isExpanded ? '▼' : '▶'} {call.name} {call.success === false ? '❌' : (call.result ? '✅' : '⏳')}
                  </Text>
                </Clickable>
                
                {isExpanded && call.result && (
                  <Box marginLeft={4} borderStyle="single" borderColor="dim" padding={1}>
                    <Text dimColor>
                      {clampForDisplay(call.result, 20)}
                    </Text>
                  </Box>
                )}
              </Box>
            );
          })}
        </Box>
      )}

      {/* Diff Request */}
      <DiffApproval
        diffRequest={diffRequest}
        handleDiffResponse={handleDiffResponse}
        setFocus={setFocus}
      />

      <InputBar
        activeMenu={activeMenu}
        cycleMode={cycleMode}
        diffRequest={diffRequest}
        elapsed={elapsed}
        extensionConnected={extensionConnected}
        focus={focus}
        handleSubmit={handleSubmit}
        input={input}
        isProcessing={isProcessing}
        isThinkingTooLong={isThinkingTooLong}
        isToolRunningRef={isToolRunningRef}
        mode={mode}
        newlineRef={newlineRef}
        setFocus={setFocus}
        setInput={setInput}
        setSlashIdx={setSlashIdx}
        slashMatches={slashMatches}
        slashOpen={slashOpen}
        slashSelected={slashSelected}
        status={status}
        syncTokenEstimate={syncTokenEstimate}
        terminalOpen={terminalOpen}
        thinkingDisplayText={thinkingDisplayText}
      />

      {/* Interactive Menus */}
      <Menus
        activeMenu={activeMenu}
        setActiveMenu={setActiveMenu}
        agentLoop={agentLoop}
        handleSubmit={handleSubmit}
        mode={mode}
        setActiveTab={setActiveTab}
        setFocus={setFocus}
        setHistory={setHistory}
      />

      {/* Agent Terminal Bottom Sheet */}
      {/* Agent Terminal Bottom Sheet */}
      <AgentTerminal
        terminalOpen={terminalOpen}
        terminalInput={terminalInput}
        setTerminalInput={setTerminalInput}
        setTerminalOpen={setTerminalOpen}
        setHistory={setHistory}
        setFocus={setFocus}
        focus={focus}
        agentLoop={agentLoop}
      />
      </>
      )}

      {/* Fixed Status Bar */}
      <Box marginTop={1} paddingX={1} flexDirection="column" width="100%" borderTopStyle="single" borderTopColor="gray">
        {activeTab === 'agent' ? (
          <>
            <Box flexDirection="row" justifyContent="space-between" width="100%">
              <Clickable onClick={() => { setActiveTab('github'); setHasNewGitHubEvent(false); }}>
                <Text>
                  {isProcessing ? <Text color="yellow"><Spinner type="dots" /> Agent</Text> : <Text color={extensionConnected ? 'cyan' : 'yellow'} bold> {extensionConnected ? '🟢' : '🟡'} Agent</Text>}
                  <Text dimColor> | GitHub {hasNewGitHubEvent ? '🔴 ' : ''}(Ctrl+O) </Text>
                </Text>
              </Clickable>
              <Text dimColor>
                Model: <Text bold>{agentLoop.modelConfig?.modelTier?.toUpperCase() || 'PRO'}</Text> | Tokens: <Text color={tokenColor}>~{syncTokenEstimate.toLocaleString()} / {tokenLimit.toLocaleString()} ({tokenPct}%)</Text>
              </Text>
            </Box>
            <Box flexDirection="row" justifyContent="space-between" width="100%">
              <Text dimColor>
                [Ctrl+T] Terminal{mouseTracking.enabled ? ' | 🖱 /mouse off' : ''}
              </Text>
              <Box flexDirection="row">
                <Text color="yellow">{tasks.filter(t => t.status === 'running').length > 0 ? `${tasks.filter(t => t.status === 'running').length} bg tasks  ` : ''}</Text>
                <Text dimColor>{focus === FOCUS_CHAT ? '[Tab] Input | [↑/↓] Nav | [↵] Toggle' : '[Tab] Nav Logs'} | Context: {history.length}/50</Text>
              </Box>
            </Box>
          </>
        ) : (
          <>
            <Box flexDirection="row" justifyContent="space-between" width="100%">
              <Clickable onClick={() => { setActiveTab('agent'); }}>
                <Text>
                  <Text dimColor> Agent (Ctrl+O) | </Text>
                  <Text color="cyan" bold> 🐙 GitHub</Text>
                </Text>
              </Clickable>
              <Text dimColor>
                Viewing: <Text bold>{hasNewGitHubEvent ? 'NEW ACTIVITY' : 'IDLE'}</Text>
              </Text>
            </Box>
            <Box flexDirection="row" justifyContent="space-between" width="100%">
              <Text dimColor>
                [Ctrl+T] Terminal{mouseTracking.enabled ? ' | 🖱 /mouse off' : ''}
              </Text>
              <Box flexDirection="row">
                <Text color="yellow">{tasks.filter(t => t.status === 'running').length > 0 ? `${tasks.filter(t => t.status === 'running').length} bg tasks  ` : ''}</Text>
                <Text dimColor>[Tab] Nav Logs | Context: {history.length}/50</Text>
              </Box>
            </Box>
          </>
        )}
      </Box>
    </Box>
  );
}
