import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useStdout, Static } from 'ink';
import Spinner from 'ink-spinner';
import { GithubTab } from './components/GithubTab.jsx';
import { Menus, DiffApproval } from './components/Menus.jsx';
import { Banner } from './components/Banner.jsx';
import { TranscriptTurn } from './components/TranscriptTurn.jsx';
import { AgentTerminal } from './components/AgentTerminal.jsx';
import { InputBar } from './components/InputBar.jsx';
import { clampForDisplay } from './format.js';
import { SLASH_COMMANDS, FOCUS_INPUT, FOCUS_TERMINAL, THINKING_MESSAGES, RESERVED_ROWS } from './constants.js';
import { groupTurns } from './transcript.js';
import { expandPastes } from './paste.js';
import { useKeyBindings } from './hooks/use-key-bindings.js';
import { useHotkeys } from './hooks/use-hotkeys.js';
import { useGithubTab } from './hooks/use-github-tab.js';
import { handleSlashCommand } from './hooks/use-slash-commands.js';
import { buildAgentCallbacks } from './hooks/use-agent-callbacks.js';
import fs from 'fs';
import { exec } from 'child_process';
import figlet from 'figlet';
import * as paths from '../core/paths.js';

/**
 * The terminal front-end.
 *
 * The one rule that governs this file: **Ink's live frame must always be
 * shorter than the terminal.** When the frame overflows the viewport, Ink
 * stops doing incremental updates and starts writing `clearTerminal` — ESC[2J
 * ESC[3J — plus a full repaint on *every* render (see
 * `shouldClearTerminalForFrame` in ink/build/ink.js). That wipes the scrollback
 * and the user's text selection several times a second, which is what "I can't
 * scroll, I can't copy, and it flickers" actually was.
 *
 * So: everything settled goes into <Static>, which Ink writes once and then
 * leaves alone in the scrollback, and the live frame holds only the in-flight
 * turn, the input and the status bar — bounded by `liveBudget` rows.
 */
export function App({ agentLoop, wsServer }) {
  const [input, setInput] = useState('');
  const [history, setHistory] = useState([...agentLoop.conversationHistory]);
  const [activeToolCalls, setActiveToolCalls] = useState([]);
  const [agentNameAscii, setAgentNameAscii] = useState(() => {
    let name = 'Agent CLI';
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
    let name = 'Agent CLI';
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
  const [diffRequest, setDiffRequest] = useState(null);
  const [tasks, setTasks] = useState([]);

  // Extension Connection Polling
  const [extensionConnected, setExtensionConnected] = useState(false);
  useEffect(() => {
    if (!wsServer) return;
    const checkConnection = () => {
      // Same boolean means React bails out of the re-render, so this poll is
      // free while nothing changes.
      setExtensionConnected(Boolean(wsServer.clients && wsServer.clients.size > 0));
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
  // One switch for the whole transcript rather than a per-row selection model:
  // without a mouse there is nothing to point at a single row with, and this is
  // the shape Claude Code uses. Toggling it reprints the transcript.
  const [verbose, setVerbose] = useState(false);
  // Bumping this remounts <Static>. Ink commits Static output permanently and
  // never repaints it, so shrinking the item list (/clear, /new, compaction) —
  // or re-rendering it at a new verbosity — needs a fresh mount.
  const [staticEpoch, setStaticEpoch] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [slashIdx, setSlashIdx] = useState(0);
  const [mode, setMode] = useState(agentLoop.mode || 'plan');
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalInput, setTerminalInput] = useState('');
  const [pendingImage, setPendingImage] = useState(null);
  const [activeMenu, setActiveMenu] = useState(null);
  const [planReviewReady, setPlanReviewReady] = useState(false);
  const [walkthroughReady, setWalkthroughReady] = useState(false);
  const [artifacts, setArtifacts] = useState({ task: null, walkthrough: null });
  // Pasted blocks, kept out of the prompt as markers. See ui/paste.js.
  const [pastes, setPastes] = useState([]);
  const addPaste = React.useCallback((paste) => {
    setPastes((prev) => [...prev, paste].slice(-20));
  }, []);
  const [inputHistory, setInputHistory] = useState([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  // Set while the input line holds a recalled history entry rather than typing.
  const [paletteSuppressed, setPaletteSuppressed] = useState(false);
  // Set by the key bindings when Enter carried a modifier, read by InputBar's
  // deferred submit. A ref because the two run in the same event dispatch.
  const newlineRef = useRef(false);
  const [activeTab, setActiveTab] = useState('agent'); // 'agent' | 'github'
  // The whole GitHub screen — state, polling and actions — lives in its own
  // hook. See hooks/use-github-tab.js for why.
  const github = useGithubTab({ agentLoop, wsServer, activeTab });

  const { stdout } = useStdout();

  // The palette is open whenever the user has *typed* a bare "/word" with no
  // argument yet. Recalling one from history does not count: the palette's ↑/↓
  // handler runs ahead of the history one, so an opened palette would strand
  // the user with both arrows dead until they cleared the line.
  const slashQuery = focus === FOCUS_INPUT && !paletteSuppressed && /^\/[a-z-]*$/i.test(input)
    ? input.slice(1).toLowerCase()
    : null;
  const slashMatches = slashQuery === null
    ? []
    : SLASH_COMMANDS.filter((c) => c.name.startsWith(slashQuery)).slice(0, 6);
  const slashOpen = slashMatches.length > 0;
  const slashSelected = Math.min(slashIdx, Math.max(0, slashMatches.length - 1));

  const cycleMode = React.useCallback(() => {
    const next = (agentLoop.mode || 'plan') === 'plan' ? 'auto' : 'plan';
    agentLoop.mode = next;
    setMode(next);
  }, [agentLoop]);

  // Drives the "(12s · ↑ 1.2k tokens)" counter. One timer, one small state
  // update per second — the live frame is a handful of rows, so this is cheap.
  useEffect(() => {
    if (!isProcessing) {
      setElapsed(0);
      return undefined;
    }
    const startedAt = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(id);
  }, [isProcessing]);

  // How many turns <Static> has already been handed. Monotonic on purpose: a
  // turn Ink has committed is on the screen for good, so moving it back into
  // the live frame would draw it a second time.
  const committedRef = useRef(0);

  const resetScreen = React.useCallback(() => {
    try {
      // 2J clears the screen, 3J drops scrollback, H homes the cursor.
      (stdout || process.stdout).write('\x1b[2J\x1b[3J\x1b[H');
    } catch {
      /* non-TTY: nothing painted to discard */
    }
    committedRef.current = 0;
    setStaticEpoch((n) => n + 1);
  }, [stdout]);

  // Committed output cannot be repainted, so changing verbosity means clearing
  // the screen and letting <Static> print the transcript again at the new
  // setting. This is the only way to open a step that has already scrolled by.
  const toggleVerbose = React.useCallback(() => {
    setVerbose((v) => !v);
    resetScreen();
  }, [resetScreen]);

  const [terminalHeight, setTerminalHeight] = useState(
    (stdout && stdout.rows) || process.stdout.rows || 24,
  );
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setTerminalHeight(stdout.rows || 24);
    stdout.on('resize', onResize);
    return () => stdout.off('resize', onResize);
  }, [stdout]);

  const turns = groupTurns(history);

  // Only the turn that is still running stays in the live frame. Everything
  // else is committed to <Static>, where it becomes ordinary scrollback the
  // terminal can scroll and select like any other command's output.
  const target = isProcessing ? Math.max(0, turns.length - 1) : turns.length;
  if (target > committedRef.current) committedRef.current = target;
  const staticCount = Math.min(committedRef.current, turns.length);
  const staticTurns = turns.slice(0, staticCount);
  const liveTurns = turns.slice(staticCount);

  // Rows the live frame may spend on the in-flight turn. Everything below it —
  // the spinner, the input box, the mode chip and the status bar — is fixed
  // furniture, and going over the viewport is what triggers Ink's full-clear
  // repaint path.
  const liveBudget = Math.max(3, terminalHeight - RESERVED_ROWS);

  useEffect(() => {
    // /plan and /auto mutate agentLoop.mode directly, so mirror it back.
    if (agentLoop.mode !== mode) setMode(agentLoop.mode);
  }, [history, isProcessing, agentLoop.mode, mode]);

  useEffect(() => {
    if (isProcessing) return;

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
      const taskContent = fs.existsSync(taskPath) ? fs.readFileSync(taskPath, 'utf8') : null;
      const walkContent = fs.existsSync(walkPath) ? fs.readFileSync(walkPath, 'utf8') : null;
      setArtifacts((prev) => (prev.task === taskContent && prev.walkthrough === walkContent
        ? prev
        : { task: taskContent, walkthrough: walkContent }));
    } catch (err) {
      /* ignore fs errors */
    }
  }, [isProcessing, planReviewReady, walkthroughReady, agentLoop.workspace]);

  // The thinking line. One row, rewritten on a calm cadence — the old 75ms
  // typewriter plus a 10ms per-character reveal of the whole reply is what made
  // the transcript strobe.
  const [thinkingText, setThinkingText] = useState(THINKING_MESSAGES[0]);
  const isToolRunningRef = useRef(false);
  useEffect(() => {
    if (!isProcessing) {
      isToolRunningRef.current = false;
      setThinkingText(THINKING_MESSAGES[0]);
      return undefined;
    }
    let i = 0;
    const id = setInterval(() => {
      if (isToolRunningRef.current) return;
      i = (i + 1) % THINKING_MESSAGES.length;
      setThinkingText(THINKING_MESSAGES[i]);
    }, 2500);
    return () => clearInterval(id);
  }, [isProcessing]);

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

  const handleSubmit = async (query) => {
    if (!query.trim()) return;
    setInputHistory(prev => [...prev, query]);
    setHistoryIdx(-1);
    setPaletteSuppressed(false);
    setInput('');

    const cleanQuery = query.trim().toLowerCase();
    if (cleanQuery === ':stop' || cleanQuery === '/stop') {
      wsServer.broadcast('extension', { type: 'stop_generation', timestamp: Date.now(), id: Date.now().toString() });
      agentLoop.isProcessing = false;
      agentLoop.abortExtensionWork();
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
      });
      return;
    }

    // The prompt carries markers; the model gets what was actually pasted. The
    // transcript keeps the marker form, so a 500-line paste never becomes a
    // 500-row user message in the live frame.
    let messageContent = expandPastes(query, pastes);
    if (pendingImage) {
      messageContent = `[Image attached: ${pendingImage.path} (${pendingImage.sizeKB}KB, ${pendingImage.mime})]\n\n<image_data>\ndata:${pendingImage.mime};base64,${pendingImage.base64}\n</image_data>\n\n${messageContent}`;
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

  // The ctrl+ chords never reach Ink — see ui/hotkeys.js. They are inert while a
  // diff or a menu is up, so nothing can act behind a question the user has not
  // answered yet.
  useHotkeys({
    expand: toggleVerbose,
    tabs: () => setActiveTab((prev) => {
      const next = prev === 'agent' ? 'github' : 'agent';
      if (next === 'github') github.clearNewEvent();
      return next;
    }),
    terminal: () => setTerminalOpen((prev) => {
      setFocus(prev ? FOCUS_INPUT : FOCUS_TERMINAL);
      return !prev;
    }),
    'paste-image': () => handleSubmit('/paste-image'),
  }, !diffRequest && !activeMenu);

  useKeyBindings({
    activeMenu,
    activeTab,
    agentLoop,
    cycleMode,
    diffRequest,
    focus,
    github,
    handleSubmit,
    historyIdx,
    inputHistory,
    isProcessing,
    newlineRef,
    setActiveTab,
    setHistoryIdx,
    setInput,
    setPaletteSuppressed,
    setSlashIdx,
    setTerminalOpen,
    setFocus,
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
  const runningTasks = tasks.filter(t => t.status === 'running').length;

  // The banner is committed with the rest of the scrollback rather than living
  // in the live frame: it is ten rows of figlet that would otherwise be
  // repainted on every tick and eat the whole budget on a short terminal.
  const staticItems = [{ id: 'app-banner', isBanner: true }, ...staticTurns];

  return (
    <Box flexDirection="column" width="100%" overflow="hidden">
      {activeTab === 'github' ? (
        <GithubTab
          agentLoop={agentLoop}
          wsServer={wsServer}
          github={github}
          maxRows={Math.max(6, terminalHeight - 8)}
        />
      ) : (
        <>
          {/* Settled transcript: written once, then owned by the terminal. */}
          <Static key={staticEpoch} items={staticItems}>
            {(item) => (item.isBanner
              ? <Banner key={item.id} agentLoop={agentLoop} agentNameAscii={agentNameAscii} />
              : (
                <TranscriptTurn
                  key={item.id}
                  turn={item}
                  isLive={false}
                  verbose={verbose}
                  status={status}
                  liveBudget={liveBudget}
                />
              ))}
          </Static>

          {/* The in-flight turn — the only transcript rows Ink repaints. */}
          {liveTurns.map((turn) => (
            <TranscriptTurn
              key={turn.id}
              turn={turn}
              isLive
              verbose={verbose}
              status={status}
              liveBudget={liveBudget}
            />
          ))}

          {/* Tool calls for the running turn, capped to what the frame can hold. */}
          {activeToolCalls.length > 0 && (
            <Box flexDirection="column" marginBottom={1}>
              {activeToolCalls.slice(-Math.max(1, liveBudget - 1)).map((call) => (
                <Box key={call.id} flexDirection="column">
                  <Text color={call.result === undefined ? 'cyan' : 'gray'}>
                    {'  '}
                    {call.success === false
                      ? '✖'
                      : call.result !== undefined
                        ? '✔'
                        : <Text color="cyan"><Spinner type="dots" /></Text>}
                    {' '}{call.name}
                  </Text>
                  {verbose && call.result !== undefined && (
                    <Box marginLeft={4}>
                      <Text dimColor wrap="wrap">{clampForDisplay(call.result, 10)}</Text>
                    </Box>
                  )}
                </Box>
              ))}
            </Box>
          )}

          <DiffApproval
            diffRequest={diffRequest}
            handleDiffResponse={handleDiffResponse}
            setFocus={setFocus}
          />

          <InputBar
            setPaletteSuppressed={setPaletteSuppressed}
            activeMenu={activeMenu}
            diffRequest={diffRequest}
            elapsed={elapsed}
            extensionConnected={extensionConnected}
            focus={focus}
            handleSubmit={handleSubmit}
            input={input}
            isProcessing={isProcessing}
            isThinkingTooLong={isThinkingTooLong}
            isToolRunningRef={isToolRunningRef}
            addPaste={addPaste}
            pastes={pastes}
            mode={mode}
            newlineRef={newlineRef}
            setInput={setInput}
            setSlashIdx={setSlashIdx}
            slashMatches={slashMatches}
            slashOpen={slashOpen}
            slashSelected={slashSelected}
            status={status}
            syncTokenEstimate={syncTokenEstimate}
            terminalOpen={terminalOpen}
            thinkingText={thinkingText}
            artifacts={artifacts}
            verbose={verbose}
          />

          <Menus
            activeMenu={activeMenu}
            setActiveMenu={setActiveMenu}
            agentLoop={agentLoop}
            handleSubmit={handleSubmit}
            mode={mode}
            setActiveTab={setActiveTab}
            setFocus={setFocus}
            setHistory={setHistory}
            setInput={setInput}
          />

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
      <Box paddingX={1} flexDirection="column" width="100%" borderTopStyle="single" borderTopColor="gray">
        <Box flexDirection="row" justifyContent="space-between" width="100%">
          <Text>
            {activeTab === 'agent' ? (
              <>
                {isProcessing
                  ? <Text color="yellow"><Spinner type="dots" /> Agent</Text>
                  : <Text color={extensionConnected ? 'cyan' : 'yellow'} bold>{extensionConnected ? '🟢' : '🟡'} Agent</Text>}
                <Text dimColor> │ GitHub {github.hasNewEvent ? '🔴 ' : ''}(ctrl+o)</Text>
              </>
            ) : (
              <>
                <Text dimColor>Agent (ctrl+o) │ </Text>
                <Text color="cyan" bold>🐙 GitHub</Text>
              </>
            )}
          </Text>
          <Text dimColor>
            {agentLoop.modelConfig?.modelTier?.toUpperCase() || 'PRO'}
            {' · '}
            <Text color={tokenColor}>~{syncTokenEstimate.toLocaleString()}/{tokenLimit.toLocaleString()} ({tokenPct}%)</Text>
          </Text>
        </Box>
        <Box flexDirection="row" justifyContent="space-between" width="100%">
          <Text dimColor>
            ctrl+t terminal · ctrl+e {verbose ? 'collapse' : 'expand'} · shift+tab mode
          </Text>
          <Text dimColor>
            {runningTasks > 0 ? <Text color="yellow">{runningTasks} bg · </Text> : ''}
            {history.length}/50 ctx
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
