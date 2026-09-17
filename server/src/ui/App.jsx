import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useStdout, Static } from 'ink';
import { GithubTab } from './components/GithubTab.jsx';
import { Menus, DiffApproval } from './components/Menus.jsx';
import { Banner } from './components/Banner.jsx';
import { TranscriptTurn } from './components/TranscriptTurn.jsx';
import { AgentTerminal } from './components/AgentTerminal.jsx';
import { Dots } from './components/RunningLine.jsx';
import { InputBar } from './components/InputBar.jsx';
import { clampForDisplay, extractCodeBlocks } from './format.js';
import { SLASH_COMMANDS, FOCUS_INPUT, FOCUS_TERMINAL, THINKING_MESSAGES, reservedRows, isCompactHeight } from './constants.js';
import { resolveEffort } from '../core/effort.js';
import { groupTurns } from './transcript.js';
import { expandPastes, attachedPastes } from './paste.js';
import { drainChatQueue } from './chat-queue.js';
import { drainTerminalQueue } from './terminal-queue.js';
import { useKeyBindings } from './hooks/use-key-bindings.js';
import { useHotkeys } from './hooks/use-hotkeys.js';
import { canCopy, copyToClipboard } from './clipboard.js';
import { checkForUpdate, readPendingReload } from '../core/update.js';
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

  /**
   * Whether this agent is behind its own remote, and what a past `/update`
   * left you to reload.
   *
   * The check runs **after** the first paint and never blocks: it is a `git
   * fetch`, and a network call on the startup path is a hang waiting for an
   * aeroplane. It fails silently, because an update check that can break
   * startup is worse than no update check.
   */
  const [update, setUpdate] = useState({ available: false, behind: 0 });
  const [pendingReload, setPendingReload] = useState(() => readPendingReload());
  // Pasted blocks, kept out of the prompt as markers. See ui/paste.js.
  const [pastes, setPastes] = useState([]);
  const addPaste = React.useCallback((paste) => {
    setPastes((prev) => [...prev, paste].slice(-20));
  }, []);
  const [inputHistory, setInputHistory] = useState([]);

  /**
   * Commands that failed in an editor terminal, waiting to be asked for.
   *
   * Kept here rather than pushed into the prompt so the offer costs one field
   * in a row that already exists, instead of rewriting what you were typing.
   */
  const [pendingFailures, setPendingFailures] = useState([]);
  const [historyIdx, setHistoryIdx] = useState(-1);

  /**
   * The prompt field's caret, reached imperatively.
   *
   * `use-key-bindings` owns up and down, because the precedence between the
   * slash palette, moving a line and recalling history has to be decided in one
   * place. It asks the field to move first and only falls through to history
   * when the caret was already on the first or last line.
   */
  const cursorRef = useRef(null);
  const setInputAtEnd = React.useCallback((next) => {
    setInput(next);
    // The field puts the caret at the end of anything handed to it wholesale;
    // this is here so the intent reads at the call site.
    setTimeout(() => cursorRef.current?.toEnd?.(), 0);
  }, []);
  // Set while the input line holds a recalled history entry rather than typing.
  const [paletteSuppressed, setPaletteSuppressed] = useState(false);
  // Set by the key bindings when Enter carried a modifier, read by InputBar's
  // deferred submit. A ref because the two run in the same event dispatch.
  const newlineRef = useRef(false);
  const [activeTab, setActiveTab] = useState('agent'); // 'agent' | 'github'
  // The whole GitHub screen — state, polling and actions — lives in its own
  // hook. See hooks/use-github-tab.js for why.
  const github = useGithubTab({ agentLoop, wsServer, activeTab, setHistory });

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

  /**
   * The one animation clock in the app.
   *
   * Every animated thing in the live frame used to own a timer: `RunningLine`,
   * the status bar's spinner, the "Worked for" spinner, and one more per
   * in-flight tool call. `ink-spinner` starts an interval per instance, and each
   * of those state updates repaints the *whole* live frame — Ink does not diff
   * by line — so the frame was being redrawn three-plus-N times per tick to
   * animate a single idea, out of step with itself.
   *
   * One tick, passed down. It runs only while a turn does, so an idle screen
   * still writes nothing at all, which is the bar `ui/constants.js` sets.
   */
  const [animTick, setAnimTick] = useState(0);
  useEffect(() => {
    if (!isProcessing) return undefined;
    const id = setInterval(() => setAnimTick((n) => n + 1), 80);
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
  // Width matters for the same reason height does: a row wider than the
  // viewport wraps onto a second line, which grows the live frame past the
  // budget and brings back Ink's clear-and-repaint path.
  const [terminalWidth, setTerminalWidth] = useState(
    (stdout && stdout.columns) || process.stdout.columns || 80,
  );
  /**
   * A narrower terminal has to reprint, or the settled transcript smears.
   *
   * `<Static>` rows are written once and Ink cannot repaint them, so they keep
   * whatever width they were wrapped at. Narrow the window and the terminal
   * re-wraps that committed text itself, mid-paragraph, against a live frame
   * that has already re-laid-out — which is the spill you get from dragging the
   * window while the app is drawing.
   *
   * Reprinting is the same move `ctrl+e` makes and the same one `/clear` makes:
   * clear, bump the epoch, let `<Static>` lay the transcript out again at the
   * width it is now. Only on a **width** change — height alone does not re-wrap
   * anything — and debounced, because a drag fires this continuously and
   * clearing on every tick would be its own kind of flicker.
   */
  const lastWidthRef = useRef((stdout && stdout.columns) || 80);
  useEffect(() => {
    if (!stdout) return undefined;
    let settle;
    const onResize = () => {
      setTerminalHeight(stdout.rows || 24);
      const width = stdout.columns || 80;
      setTerminalWidth(width);
      if (width === lastWidthRef.current) return;
      lastWidthRef.current = width;
      clearTimeout(settle);
      settle = setTimeout(() => resetScreen(), 150);
    };
    stdout.on('resize', onResize);
    return () => {
      clearTimeout(settle);
      stdout.off('resize', onResize);
    };
  }, [stdout, resetScreen]);

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
  // Furniture the frame is about to draw, not furniture it might draw. The
  // palette is the reason this is a sum rather than a constant: it is six rows
  // when it is open and none when it is not, and a single number can only be
  // right about one of those.
  // How tall the prompt may draw, and what that costs the live frame.
  //
  // RESERVED_ROWS budgets the input box at its one-line height, so every extra
  // line is a row the live frame has to find. Charging them is necessary and
  // not sufficient: `liveBudget` has a floor, so a tall enough prompt pushes
  // the total past the viewport however much the in-flight turn gives up.
  // Measured at 20 rows, a ten-line prompt produced 17 full-screen clears in a
  // second. So the prompt is bounded too, and scrolls inside its bound.
  //
  // A third of the viewport: enough that the common two- or three-line prompt
  // is never scrolled, and never so much that the transcript disappears behind
  // the thing you are typing into.
  const promptMaxRows = Math.max(1, Math.floor(terminalHeight / 3));
  const promptExtraRows = Math.max(
    0,
    Math.min(input.split('\n').length, promptMaxRows) - 1,
  );

  // A terminal too short for the furniture drops its spacing rather than
  // overflowing the viewport — see COMPACT_BELOW_ROWS. The floor comes down
  // with it: giving the turn three rows it has no room for is what put the
  // frame over the viewport in the first place.
  const compact = isCompactHeight(terminalHeight);

  // One line each, and charged for. A row that draws without being budgeted is
  // how the frame outgrows the viewport.
  const noticeRows = (update.available ? 1 : 0) + (pendingReload ? 1 : 0);

  /**
   * What is left after the furniture — floored at one row, never at three.
   *
   * The floor used to be 3, and it was the bug twice. It exists so the turn
   * always has *something* to draw in, but `Math.max(3, …)` does not mean
   * "at least three if there is room", it means "three even when there is not"
   * — and the frame then asks for more rows than the terminal has, which is
   * Ink's clear-and-repaint path. Adding the two notice rows reproduced it at
   * 13 rows: 9 furniture + 2 notices + a floored 3 is 14 in a 13-row terminal.
   *
   * Flooring at 1 loses nothing, because whenever there *is* room the
   * subtraction already yields more than 3. The floor only ever bound in the
   * case where binding it was wrong.
   */
  const liveBudget = Math.max(1, terminalHeight - reservedRows(terminalHeight)
    - promptExtraRows
    - (slashOpen ? slashMatches.length : 0)
    - (extensionConnected ? 0 : 1)
    - (isThinkingTooLong ? 1 : 0)
    - noticeRows);

  // Shown in the status bar rather than under the prompt: it is rare, it is one
  // short field, and a conditional row under the input is a row RESERVED_ROWS
  // has to budget for whether or not it is ever drawn.
  const attachedCount = attachedPastes(input, pastes).length;

  useEffect(() => {
    // /plan and /auto mutate agentLoop.mode directly, so mirror it back.
    if (agentLoop.mode !== mode) setMode(agentLoop.mode);
  }, [history, isProcessing, agentLoop.mode, mode]);

  useEffect(() => {
    if (isProcessing) return;

    if (planReviewReady) {
      // Clear any verdict left over from a previous review before opening this
      // one. The companion writes plan-approval.json whenever its lenses are
      // clicked, including when no review is running; the poller below only
      // reads while the menu is up, so a stale file would be consumed the
      // instant the *next* review started and answer it for the user.
      try {
        const stale = paths.planApprovalPath(agentLoop.workspace);
        if (fs.existsSync(stale)) fs.unlinkSync(stale);
      } catch (e) { /* nothing to clear */ }

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

  // `/update done` clears the file; this notices and the row goes away.
  useEffect(() => {
    if (!pendingReload) return undefined;
    const id = setInterval(() => setPendingReload(readPendingReload()), 2000);
    return () => clearInterval(id);
  }, [pendingReload]);

  useEffect(() => {
    let cancelled = false;
    // One beat after mount, so the first frame is already on screen.
    const id = setTimeout(() => {
      checkForUpdate(agentLoop.agentSourceDir)
        .then((result) => { if (!cancelled) setUpdate(result); })
        .catch(() => {});
    }, 1500);
    return () => { cancelled = true; clearTimeout(id); };
  }, [agentLoop.agentSourceDir]);

  // Selections sent over from the editor with "Add to Agent Chat".
  //
  // They ride the same attachment machinery as a paste: a short marker in the
  // prompt, the real text swapped in on submit. So a 400-line selection costs
  // one row of the live frame, and the model still gets all of it.
  useEffect(() => {
    const id = setInterval(() => {
      const added = drainChatQueue(agentLoop.workspace);
      if (added.length === 0) return;
      setPastes((prev) => [...prev, ...added].slice(-20));
      setInputAtEnd((prev) => {
        const markers = added.map((a) => a.marker).join(' ');
        // `prev` already ends in a space when a previous drain put it there;
        // joining blindly produced a double gap between markers.
        return prev ? `${prev.replace(/\s+$/, '')} ${markers} ` : `${markers} `;
      });
      setPaletteSuppressed(true);
    }, 500);
    return () => clearInterval(id);
  }, [agentLoop.workspace]);

  // Commands that failed in a VS Code terminal, forwarded by the companion.
  //
  // Offered, not acted on — and putting the marker straight into the prompt was
  // already acting. The companion forwards *every* non-zero exit from *any*
  // terminal, so a prompt would collect a failure you already knew about, from a
  // command you ran deliberately, and sometimes a typo you had already noticed
  // and fixed. Three of them accumulated in one prompt in use, each needing
  // deleting by hand before the prompt could be used.
  //
  // The line: **what you asked for is inserted, what merely happened is
  // offered.** The editor's "Add to Agent Chat" is a deliberate act and still
  // lands in the box; a command failing somewhere else is not, so it waits
  // behind ctrl+f and says so in the status bar.
  //
  // Draining still happens on the same tick, because the file is the
  // companion's outbox and leaving it to grow is a different problem.
  useEffect(() => {
    const id = setInterval(() => {
      if (isProcessing) return; // never interrupt a running turn
      const failures = drainTerminalQueue(agentLoop.workspace);
      if (failures.length === 0) return;
      // Held, not inserted. See `pendingFailures`.
      setPendingFailures((prev) => [...prev, ...failures].slice(-20));
    }, 1000);
    return () => clearInterval(id);
  }, [agentLoop.workspace, isProcessing]);

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
      // `:stop` never reaches the model, so its echo is local — counting it as
      // loop history would shift the merge by one and cost a turn on screen.
      setHistory(prev => [
        ...prev,
        { role: 'user', content: query, isLocal: true, timestamp: Date.now() },
        { role: 'assistant', content: '🛑 Agent forcefully stopped.', isLocal: true, timestamp: Date.now() }
      ]);
      return;
    }

    /**
     * A local command must not disturb a turn that is still running.
     *
     * Every submit used to `setIsProcessing(true)` and `setActiveToolCalls([])`
     * before looking at what it was, and every slash handler ends with
     * `setIsProcessing(false)`. So typing anything starting with `/` while the
     * agent was mid-turn wiped the live turn's tool rows and then declared the
     * turn finished — while the loop carried on working.
     *
     * Reported exactly that way: `/efforttt` typed during a turn, and the CLI
     * "stopped responding and did not output the result". It had not stopped.
     * Gemini ran the tool calls and produced the answer, and the terminal was
     * left with no spinner, no rows, and no reason to believe anything was
     * still happening.
     *
     * A local command is local: it answers in the transcript and leaves the
     * turn's state alone. `setIsProcessing` is swapped for a no-op while the
     * loop is busy, because the handlers are many and each one calls it.
     */
    const turnInFlight = Boolean(agentLoop.isProcessing);

    if (query.startsWith('/')) {
      if (!turnInFlight) {
        setIsProcessing(true);
        setStatus('Thinking...');
        setActiveToolCalls([]);
      }
      await handleSlashCommand(query, {
        agentLoop,
        wsServer,
        resetScreen,
        setActiveMenu,
        setHistory,
        setIsProcessing: turnInFlight ? () => {} : setIsProcessing,
        setPendingImage,
        // So `/github …` can answer on the GitHub screen instead of filling
        // the agent's transcript with polling notices.
        github,
      });
      return;
    }

    setIsProcessing(true);
    setStatus('Thinking...');
    setActiveToolCalls([]);

    // The prompt carries markers; the model gets what was actually pasted. The
    // transcript keeps the marker form, so a 500-line paste never becomes a
    // 500-row user message in the live frame.
    let messageContent = expandPastes(query, pastes);
    if (pendingImage) {
      messageContent = `[Image attached: ${pendingImage.path} (${pendingImage.sizeKB}KB, ${pendingImage.mime})]\n\n<image_data>\ndata:${pendingImage.mime};base64,${pendingImage.base64}\n</image_data>\n\n${messageContent}`;
      setPendingImage(null);
    }

    // Optimistically update the UI so the user sees their prompt immediately
    // Stamped here. `groupTurns` falls back to `Date.now()` for a message with
    // no timestamp, and that fallback is re-evaluated on every render — so an
    // unstamped user message gave the turn a start time that crept forward
    // while its end time stayed put, and "Worked for" counted backwards.
    setHistory(prev => [...prev, { role: 'user', content: query, timestamp: Date.now() }]);

    const callbacks = buildAgentCallbacks({
      agentLoop,
      isToolRunningRef,
      setActiveMenu,
      setActiveToolCalls,
      setDiffRequest,
      setFocus,
      setHistory,
      setInputAtEnd,
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

    // ctrl+u and ctrl+w are what every readline prompt has bound for decades,
    // and they have to come through this channel rather than useInput:
    // ink-text-input types any key it does not recognise, so a ctrl+u handled
    // there would clear the line and then put a "u" in it.
    'clear-input': () => {
      setInput('');
      setHistoryIdx(-1);
      setPaletteSuppressed(false);
      // Attachments belong to the text that referenced them.
      setPastes([]);
    },
    'delete-word': () => setInput((value) => value.replace(/\s*\S+\s*$/, '')),

    /**
     * The last code block in the transcript, onto the clipboard.
     *
     * Drag-select is still the primary way to copy and `format.js` un-indented
     * the blocks so that it works. This is the shortcut for the case people
     * actually hit — the reply just arrived and the code in it is the point.
     *
     * "Last" means the last block of the most recent message that has one,
     * searched backwards: an agent turn is commonly followed by tool results
     * and notices, and copying nothing because the newest message happens to be
     * "✔ read_file" would read as the chord being broken.
     */
    'copy-code': () => {
      // Appended, never replacing: <Static> counts what it has printed by
      // index, so a transcript that gets shorter makes Ink skip that many turns
      // permanently. Same `isLocal` shape as every other UI-only message.
      const notify = (text) => setHistory((prev) => [
        ...prev,
        { role: 'assistant', content: text, isLocal: true, timestamp: Date.now() },
      ]);

      if (!canCopy()) {
        notify('📋 Nothing here can reach the clipboard — install `xclip` or `wl-copy`.');
        return;
      }
      let found = null;
      for (let i = history.length - 1; i >= 0 && !found; i -= 1) {
        const blocks = extractCodeBlocks(history[i]?.content);
        if (blocks.length) found = blocks[blocks.length - 1];
      }
      if (!found) {
        notify('📋 No code block in the transcript yet.');
        return;
      }
      copyToClipboard(found.code).then((ok) => {
        const lines = found.code.split('\n').length;
        notify(ok
          ? `📋 Copied ${lines} line${lines === 1 ? '' : 's'}${found.lang ? ` of ${found.lang}` : ''}.`
          : '📋 The clipboard command failed.');
      });
    },
    'attach-failures': () => {
      if (pendingFailures.length === 0) return;
      setPastes((prev) => [...prev, ...pendingFailures].slice(-20));
      setInputAtEnd((prev) => {
        const markers = pendingFailures.map((f) => f.marker).join(' ');
        return prev ? `${prev.replace(/\s+$/, '')} ${markers} ` : `${markers} `;
      });
      setPendingFailures([]);
      setPaletteSuppressed(true);
    },
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
    setInputAtEnd,
    cursorRef,
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
            } else if (data.status === 'changes_requested') {
              // A review with comments attached to lines, like a PR review.
              // Sent as one message so the agent revises the whole plan once
              // rather than round-tripping per comment.
              const comments = Array.isArray(data.comments) ? data.comments : [];
              const body = comments.length > 0
                ? comments.map((c) => `- ${c.section ? `**${c.section}** ` : ''}(line ${c.line}): ${c.comment}`).join('\n')
                : '(no comments were recorded)';
              handleSubmit(
                'I reviewed the implementation plan and left comments. Revise the plan to address '
                + `each one, then show me the updated plan.\n\n${body}`,
              );
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

  // What the browser thread is carrying — the system prompt, the tool
  // definitions, every tool result fed back, not just the turns we kept a copy
  // of. Summing conversationHistory reported a fraction of the real number.
  const syncTokenEstimate = agentLoop.contextTokens ?? 0;
  // The rung's real budget, not a constant. This was hardcoded to 50000 while
  // `/context` and the settings page both reported the actual one — three
  // places, two answers, and the bar was the one people watch.
  const tokenLimit = agentLoop.contextLimit || 50000;
  const tokenPct = Math.round((syncTokenEstimate / tokenLimit) * 100);
  const tokenColor = tokenPct > 80 ? 'red' : tokenPct > 50 ? 'yellow' : 'cyan';
  const runningTasks = tasks.filter(t => t.status === 'running').length;
  // Which repo of a group we are on. Empty for an ordinary single-repo
  // workspace, where showing it would be noise.
  // The scope is a *path* from the state root down to the workspace, so it can
  // be several segments long — and the status bar is a fixed-height instrument
  // that must never wrap. The last segment is the identifying part ("repo-1");
  // the rest is the route to it, which the workspace line in the banner already
  // gives. Measured under a pty: the unclamped value wrapped the bar onto two
  // rows, which is one row of live frame nobody budgeted for.
  const activeScope = (() => {
    const scope = paths.getActiveScope(agentLoop.workspace);
    if (!scope) return null;
    const leaf = scope.split('/').filter(Boolean).pop() || scope;
    return leaf.length > 20 ? `${leaf.slice(0, 19)}…` : leaf;
  })();

  // The banner is committed with the rest of the scrollback rather than living
  // in the live frame: it is ten rows of figlet that would otherwise be
  // repainted on every tick and eat the whole budget on a short terminal.
  const staticItems = [{ id: 'app-banner', isBanner: true }, ...staticTurns];

  return (
    <Box flexDirection="column" width="100%" overflow="hidden">
      {/*
        Settled transcript: written once, then owned by the terminal.

        Mounted unconditionally, *outside* the tab switch. <Static> only writes
        the items it has not written before, and it tracks that in component
        state — so unmounting it and mounting it again reprints the entire
        transcript, banner included. Putting it inside the `activeTab` branch
        meant a trip to the GitHub tab and back reprinted everything, which is
        where the second banner came from.
      */}
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
              terminalWidth={terminalWidth}
            />
          ))}
      </Static>

      {activeTab === 'github' ? (
        /*
          The GitHub screen gets everything the status bar does not.

          `RESERVED_ROWS` is the *agent* tab's furniture — the thinking line,
          the prompt box, the palette, the notices. None of it is drawn here:
          on this tab the frame is the screen and the status bar, and nothing
          else. Budgeting it at `terminalHeight - 8` left four rows at the top
          still showing the tail of the figlet banner, which is scrollback and
          can never be repainted away — the screen has to be tall enough to
          push it off instead.

          `GithubTab` sets `height` with `overflow="hidden"`, so its height is
          exactly what this says and cannot grow — the usual reason to keep a
          spare row, a line that wraps and is charged one but drawn as two,
          cannot happen inside a box that clips. The status bar below is one
          row plus a margin that `compact` drops.

          So the arithmetic looks like it should be `- 2`, and `- 2` is wrong:
          measured, it costs exactly one `ESC[2J` + `ESC[3J` on the way *back*
          to the agent tab, because Ink's frame carries a trailing newline that
          the row count does not. `- 3` is zero clears at every size tested
          (40x100, 24x90, 24x72, 13x80, 13x72, 10x80, 9x72, 40x60), and the row
          it gives up is the one the banner's last line sits on — a visible
          cost, where a clear-and-repaint is an invisible one that eats the
          scrollback.
        */
        <GithubTab
          agentLoop={agentLoop}
          wsServer={wsServer}
          github={github}
          maxRows={Math.max(6, terminalHeight - (compact ? 2 : 3))}
          width={terminalWidth}
        />
      ) : (
        <>

          {/*
            Notices, at the top of everything Ink can repaint.

            Above the in-flight turn because that is as high as a *live* row can
            go — `<Static>` owns the scrollback above it and cannot be
            repainted. One line each, both charged to `liveBudget` through
            `noticeRows`, and both absent when there is nothing to say.

            `wrap="truncate"` is load-bearing, not tidiness. The first version
            of the reload row was ~105 characters, which wraps at 80 columns —
            charged as one row and drawn as two, which put the frame over the
            viewport at 13 rows and brought back the clear-and-repaint path.
            Measured: 1 ESC[2J at 13x80 and 10x80 where there had been none.
          */}
          {pendingReload && (
            <Text color="yellow" wrap="truncate">
              {'⟳ '}
              {pendingReload.steps.map((s) => s.what).join(' · ')}
              <Text dimColor>{'  —  /update done when finished'}</Text>
            </Text>
          )}
          {update.available && (
            <Text color="cyan" wrap="truncate">
              {'⬆ '}{update.behind} update{update.behind === 1 ? '' : 's'} available
              <Text dimColor>{'  —  /update to pull'}</Text>
            </Text>
          )}

          {/* The in-flight turn — the only transcript rows Ink repaints. */}
          {liveTurns.map((turn) => (
            <TranscriptTurn
              key={turn.id}
              turn={turn}
              isLive
              verbose={verbose}
              status={status}
              liveBudget={liveBudget}
              tick={animTick}
              terminalWidth={terminalWidth}
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
                        : <Dots tick={animTick} />}
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
            terminalHeight={terminalHeight}
          />

          <InputBar
            filedSession={agentLoop.filedSession}
            history={history}
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
            setInputAtEnd={setInputAtEnd}
            cursorRef={cursorRef}
            promptMaxRows={promptMaxRows}
            animTick={animTick}
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
            compact={compact}
          />

          <Menus
            activeMenu={activeMenu}
            setActiveMenu={setActiveMenu}
            agentLoop={agentLoop}
            terminalWidth={terminalWidth}
            handleSubmit={handleSubmit}
            mode={mode}
            setActiveTab={setActiveTab}
            setFocus={setFocus}
            setHistory={setHistory}
            setInput={setInput}
            setInputAtEnd={setInputAtEnd}
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

      {/*
        The status bar: one row, fixed columns.

        It used to be two rows under a horizontal rule — identity and tabs left,
        effort and tokens right, then a permanent row of keybindings left and a
        second context number right. Four values on two rows, right-aligned
        against different left-hand content, so none of them lined up with each
        other and the two "how full am I" numbers (`~1,427/50,000` in tokens,
        `2/50 ctx` in turns) asked one question in two units.

        One row now: **who and where** on the left, **state and cost** on the
        right, always in that order. The keybindings moved into `/help`, which
        already listed every one of them — a hint is a teaching surface, and
        this one was charging permanent screen rent for something that is
        load-bearing exactly once. The rule above it went with them: the blank
        row already separated the bar from the prompt, and the line was drawing
        a boundary that was never in doubt.
      */}
      <Box marginTop={compact ? 0 : 1} paddingX={1} flexDirection="row" justifyContent="space-between" width="100%">
        <Box flexShrink={1} overflow="hidden">
        <Text wrap="truncate">
          {activeTab === 'agent' ? (
            <>
              {isProcessing
                ? <Text color="cyan"><Dots tick={animTick} /> agent</Text>
                : <Text color={extensionConnected ? 'cyan' : 'yellow'} bold>
                    {extensionConnected ? '●' : '○'} agent
                  </Text>}
              <Text dimColor>{'  ·  '}github{github.hasNewEvent ? '*' : ''} ^o</Text>
            </>
          ) : (
            <>
              <Text color="cyan" bold>● github</Text>
              <Text dimColor>{'  ·  '}agent ^o</Text>
            </>
          )}
          {activeScope ? <Text dimColor>{'  ·  '}{activeScope}</Text> : null}
          <Text dimColor>{'  ·  '}/help</Text>
        </Text>
        </Box>
        <Box flexShrink={0}>
        <Text dimColor wrap="truncate">
          {/*
            An offer has to be visible or it is not an offer. Yellow because it
            is the one field here that wants a decision from you; it appears
            only when something is waiting and takes no room otherwise.
          */}
          {pendingFailures.length > 0 ? (
            <Text color="yellow">
              {pendingFailures.length} failed ^f{'  ·  '}
            </Text>
          ) : ''}
          {attachedCount > 0 ? `${attachedCount} paste${attachedCount === 1 ? '' : 's'}  ·  ` : ''}
          {runningTasks > 0 ? <Text color="yellow">{runningTasks} bg{'  ·  '}</Text> : ''}
          <Text color={mode === 'plan' ? 'yellow' : 'cyan'}>{mode}</Text>
          <Text dimColor> ⇥{'  ·  '}</Text>
          {resolveEffort(agentLoop.modelConfig?.effort).id.toUpperCase()}
          {'  ·  '}
          <Text color={tokenColor}>{tokenPct}% of {tokenLimit >= 1000 ? `${Math.round(tokenLimit / 1000)}k` : tokenLimit}</Text>
        </Text>
        </Box>
      </Box>
    </Box>
  );
}
