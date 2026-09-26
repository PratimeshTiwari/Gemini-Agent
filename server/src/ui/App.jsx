import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useStdout, Static } from 'ink';
import { Menus, DiffApproval } from './components/Menus.jsx';
import { Banner } from './components/Banner.jsx';
import { TranscriptTurn, UserBar, TurnSummary, TurnRow } from './components/TranscriptTurn.jsx';
import { AgentTerminal } from './components/AgentTerminal.jsx';
import { Dots } from './components/RunningLine.jsx';
import { InputBar } from './components/InputBar.jsx';
import { clampForDisplay, extractCodeBlocks } from './format.js';
import { SLASH_COMMANDS, FOCUS_INPUT, FOCUS_TERMINAL, THINKING_MESSAGES, reservedRows, isCompactHeight } from './constants.js';
import { resolveEffort } from '../core/effort.js';
import { modelMismatch, browserModelPin } from '../core/model-match.js';
import { groupTurns, parseTurnActions } from './transcript.js';
import { expandPastes, attachedPastes } from './paste.js';
import { drainChatQueue } from './chat-queue.js';
import { useKeyBindings } from './hooks/use-key-bindings.js';
import { useHotkeys } from './hooks/use-hotkeys.js';
import { canCopy, copyToClipboard } from './clipboard.js';
import { checkForUpdate, readPendingReload } from '../core/update.js';
import { handleSlashCommand } from './hooks/use-slash-commands.js';
import { isSlowCommand } from '../core/slash-commands.js';
import { buildAgentCallbacks } from './hooks/use-agent-callbacks.js';
import fs from 'fs';
import { exec } from 'child_process';
import { bannerText } from './banner-text.js';
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
/**
 * When this process started.
 *
 * Module scope so it cannot move, and so a remount cannot reset it. The
 * artifact panel compares file mtimes against it to tell "this
 * conversation's task list" from "the last one's, still on disk".
 */
const SESSION_STARTED_AT = Date.now();

export function App({ agentLoop, wsServer }) {
  const [input, setInput] = useState('');
  const [history, setHistory] = useState([...agentLoop.conversationHistory]);


  const [activeToolCalls, setActiveToolCalls] = useState([]);
  /**
   * The wordmark, rendered once.
   *
   * This was two reads of the same config and two renders of the same string
   * — a synchronous one to seed the state and an async `figlet.text` in an
   * effect that recomputed it on mount and set it again. The async half was
   * pure duplicate work: the value was already correct before it ran.
   *
   * `figlet` itself is gone; `ui/figfont.js` renders the one font this app
   * uses, verified byte-for-byte against figlet across 25,110 strings.
   */
  const [agentNameAscii] = useState(() => {
    let name = 'Agent CLI';
    try {
      const configPath = paths.configPath(agentLoop.workspace);
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        /**
         * The name as given, with nothing glued on.
         *
         * This appended " Agent", so `/name Jarvis` drew **Jarvis Agent** —
         * while the command that set it had just replied "The agent is called
         * Jarvis". The two disagreed, and the default never went through this
         * path, so `Agent CLI` stayed `Agent CLI` while every chosen name got
         * a suffix. Reported after setting the name to "AGENT CLI" and
         * watching the banner read **AGENT CLI Agent**.
         */
        const custom = config.agentName || config.agent_name;
        if (custom) name = custom;
      }
    } catch (e) {}
    try {
      return bannerText(name) || name;
    } catch (e) {
      return name;
    }
  });

  const [isProcessing, setIsProcessing] = useState(false);
  const [status, setStatus] = useState('');
  const [diffRequest, setDiffRequest] = useState(null);
  /**
   * Prompts typed while a turn was running.
   *
   * `AgentLoop.handleUserMessage` returns early when it is busy, having only
   * pushed a transient status line that the thinking-message cycle paints
   * over — so the message was **discarded**. By then `handleSubmit` had
   * already echoed it into the transcript and cleared the input box, which is
   * the worst combination available: it looks sent, the text is gone, and
   * nothing will ever answer it. Reported after typing four prompts and
   * getting one reply.
   *
   * Held here rather than in the loop because this is where the transcript
   * and the "queued" marker live, and because the loop's contract — one turn
   * at a time — is the thing that makes the rest of it tractable.
   */
  const [queued, setQueued] = useState([]);
  const [tasks, setTasks] = useState([]);

  /*
   * Notices raised outside a turn land in the transcript.
   *
   * `_notify` sends a `status`, which every front-end reads as the spinner's
   * label — and the spinner only exists while a turn is running. The CLI
   * registers its callbacks per-submit, so between turns there was nothing
   * listening at all, and a notice went nowhere.
   *
   * `/effort` runs outside a turn. So did every connect-time row. That is why
   * "✓ Browser model is now 3.1 Pro" and `extension_stale` were both invisible
   * in the terminal while the model switch was being debugged — the answers
   * were arriving and the screen had no way to show them.
   *
   * `isLocal` marks it UI-only, so `mergeLoopHistory` does not count it as a
   * loop turn and shift every later merge by one.
   */
  useEffect(() => {
    if (!agentLoop?.setNoticeSink) return undefined;
    agentLoop.setNoticeSink((text) => setHistory((prev) => [
      ...prev,
      { role: 'assistant', content: text, isLocal: true, timestamp: Date.now() },
    ]));
    return () => agentLoop.setNoticeSink(null);
  }, [agentLoop]);

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
  const [artifacts, setArtifacts] = useState({ task: null, review: null, walkthrough: null });

  /**
   * The artifact panel opens on its own key, and does not clear the screen.
   *
   * It used to ride on `verbose` — the *transcript* toggle — so seeing your
   * task list meant expanding every tool result in the history, and vice
   * versa. Worse, `toggleVerbose` clears and reprints the whole transcript
   * (the only `ESC[2J` this app writes, because `<Static>` cannot be
   * repainted). This panel is in the **live** frame, so it needs no reprint
   * at all: React redraws it and nothing else moves.
   */
  const [artifactsOpen, setArtifactsOpen] = useState(false);

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


  const resetScreen = React.useCallback(() => {
    try {
      // 2J clears the screen, 3J drops scrollback, H homes the cursor.
      (stdout || process.stdout).write('\x1b[2J\x1b[3J\x1b[H');
    } catch {
      /* non-TTY: nothing painted to discard */
    }
    // The rows have to be forgotten too: <Static> starts from index 0 again on
    // remount, and rows we still believe are emitted would simply never print.
    emittedRef.current = new Map();
    staticRowsRef.current = [{ id: 'app-banner', isBanner: true }];
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
  /*
   * Committed a **row** at a time, not a turn at a time.
   *
   * `<Static>` advances on `items.length` and never redraws an item — its own
   * doc says it is for "things that don't change after they're rendered". A
   * turn does change: rows keep arriving for as long as the loop runs. Handing
   * it one anyway left exactly one repair, remounting `<Static>` so the whole
   * transcript prints again — and Ink cannot un-write what it already wrote, so
   * the new copy lands *below* the old one. Reported at 210x64 as the banner
   * and the turn drawn three times, once per tool round.
   *
   * A row, by contrast, is final as soon as the next one exists. So rows are
   * committed as they settle and the live frame holds only the unsettled tail —
   * which is at most the newest row and the summary. That is why this also
   * fixes short terminals instead of breaking them: the earlier attempt held
   * the *whole turn* live to avoid the reprint, and a multi-round turn does not
   * fit a 13-row viewport.
   *
   * The last item is excluded while the loop runs because it is the one that
   * can still change: a `tool` item is created by its call and rewritten when
   * its result arrives, and nothing follows it in between.
   */
  const turnInFlight = isProcessing || !!agentLoop?.isProcessing;
  const emittedRef = useRef(new Map());
  const staticRowsRef = useRef([{ id: 'app-banner', isBanner: true }]);

  /*
   * Appended into a **new array**, never pushed into the old one.
   *
   * `<Static>` memoises `items.slice(index)` on `[items, index]`, so an array
   * mutated in place is an array it never looks at again: the first attempt
   * here pushed onto `staticRowsRef.current` and the transcript rendered
   * nothing at all — banner included, 2,284 bytes for a whole session.
   */
  const parsedTurns = turns.map((turn) => ({ turn, items: parseTurnActions(turn) }));
  const fresh = [];
  for (let i = 0; i < parsedTurns.length; i++) {
    const { turn, items: parsed } = parsedTurns[i];
    const settled = !(i === parsedTurns.length - 1 && turnInFlight);
    const ready = settled ? parsed.items : parsed.items.slice(0, -1);
    const seen = emittedRef.current.get(turn.id) || { user: false, items: 0, summary: false };

    if (!seen.user && turn.userMsg) {
      fresh.push({ id: `row_user_${turn.id}`, kind: 'user', content: turn.userMsg.content });
      seen.user = true;
    }
    for (let n = seen.items; n < ready.length; n++) {
      fresh.push({ id: `row_${ready[n].id}`, kind: 'item', item: ready[n], previous: ready[n - 1] });
    }
    if (ready.length > seen.items) seen.items = ready.length;
    if (settled && !seen.summary && parsed.actions.length > 0) {
      const timed = typeof turn.startTime === 'number' && typeof turn.endTime === 'number'
        && turn.endTime >= turn.startTime;
      fresh.push({
        id: `row_sum_${turn.id}`,
        kind: 'summary',
        duration: timed ? ((turn.endTime - turn.startTime) / 1000).toFixed(1) : null,
        worked: parsed.actions.filter((a) => a.type !== 'fs_event').length,
        touched: parsed.actions.reduce((n, a) => (a.type === 'fs_event' ? n + a.paths.length : n), 0),
      });
      seen.summary = true;
    }
    emittedRef.current.set(turn.id, seen);
  }
  if (fresh.length > 0) staticRowsRef.current = [...staticRowsRef.current, ...fresh];

  // What is left to draw live: the tail of the newest turn, if it has one.
  const tail = parsedTurns[parsedTurns.length - 1];
  const tailSeen = tail ? emittedRef.current.get(tail.turn.id) : null;
  const liveTurns = tail && !tailSeen?.summary ? [tail.turn] : [];
  const liveFrom = tailSeen?.items || 0;
  /*
   * Whether the live turn still owes its prompt bar.
   *
   * `TranscriptTurn` used to decide this from `fromItem === 0`, and that is not
   * the same question: the bar is committed to <Static> the moment the turn
   * exists, while `fromItem` stays 0 until the first *row* settles. Between
   * those two — which is the whole of the thinking phase — the bar was drawn
   * twice, once committed and once live. Reported from use with both `❯ can you
   * list files` rows on screen at `Analyzing syntax… (7s)`.
   */
  const liveNeedsBar = !!tail && !tailSeen?.user;

  /*
   * There is no "a committed turn grew" case any more, and the effect that
   * handled it is gone with it.
   *
   * It watched the committed turns for a change of shape and bumped
   * `staticEpoch`, remounting `<Static>` so the whole transcript printed
   * again. That was the only repair available while a Static item was a
   * *turn*, and it is why the transcript duplicated on a terminal tall
   * enough to show both copies. A row cannot grow, so nothing needs
   * reprinting and the epoch now moves only for `resetScreen` — ctrl+e and
   * the clears that deliberately start the screen over.
   */

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
  /*
   * The browser is on a different model from the one this rung is written for.
   *
   * Reported from use: the status bar read PRO while the Gemini tab's picker
   * read Flash. `/effort` switches the picker when it runs, but the user can
   * change it back, a new tab can open on something else, and the plan's
   * default is Google's to choose — so the disagreement has to be *watched*,
   * not assumed away at the moment of setting it.
   *
   * Read straight off the loop, like the effort in the status bar at `:1312`:
   * these are live values, and a React copy of them is a second thing that can
   * disagree. `modelMismatch` is silent unless it knows both halves.
   *
   * **Shed below `COMPACT_BELOW_ROWS`, and that is arithmetic rather than
   * taste.** Three notice rows do not fit a 9-row terminal: 6 reserved + 3
   * notices + the floored 1 for the turn is 10, and a frame taller than the
   * viewport is the clear-and-repaint path — the single most important rule in
   * `ui/`. `frame-budget.test.js` fails on exactly that height without this.
   * It is the right one of the three to drop: `/update`'s two rows are about
   * work in progress, and the effort is still on the status bar.
   */
  /*
   * Silent while a switch is in flight — see `_switchInFlight`. The row is for
   * a standing disagreement; during the second between dispatch and
   * confirmation it would sit directly under "switching the browser to X" and
   * contradict it.
   */
  const mismatch = (isCompactHeight(terminalHeight) || agentLoop._switchInFlight)
    ? null
    : modelMismatch(
    agentLoop.modelConfig?.effort,
    agentLoop.modelOptions || [],
    // Resolved here rather than inside: `browserModels` is keyed by rung id and
    // `modelConfig.effort` can still be a pre-2026-09-20 word on an old config.
    browserModelPin(agentLoop.modelConfig, resolveEffort(agentLoop.modelConfig?.effort).id),
  );
  /*
   * What the browser's picker says is selected, or null when it has never been
   * read. `modelOptions` is not cleared by a failed ask, so this can be a
   * moment stale — which is the right trade for a status row: a name that was
   * true recently beats no name at all, and the mismatch row beside it is what
   * catches a real disagreement.
   */
  const browserModelLabel = (agentLoop.modelOptions || [])
    .find((m) => m && m.selected)?.label || null;

  const noticeRows = (update.available ? 1 : 0) + (pendingReload ? 1 : 0) + (mismatch ? 1 : 0);

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

  /**
   * How many lines the expanded artifact panel may draw.
   *
   * It was not budgeted at all, and it is in the live frame. Measured at
   * 13x80 with a six-item task list: **0 clears closed, 6 open** — two of
   * those the deliberate cost of the two toggles, four the frame overflowing.
   * `RESERVED_ROWS` is the furniture and never included this panel, so an
   * expanded `task.md` plus `walkthrough.md` asked for 9 + 14 rows of a
   * 13-row terminal.
   *
   * Budgeted against the terminal rather than `liveBudget`, because the two
   * never coexist: the panel draws only when `!isProcessing`, and the live
   * turn only when processing. Capped at 12 so a tall terminal does not turn
   * the prompt area into a document viewer — the file is on disk, and the
   * row names it.
   */
  const artifactLines = Math.max(
    1,
    Math.min(12, terminalHeight - reservedRows(terminalHeight) - 2),
  );

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

    /**
     * The three documents the panel tracks, read as a set.
     *
     * `review.md` joined `task.md` and `walkthrough.md` because the agent
     * started writing one — the checks it intends to run, written *before*
     * the work rather than claimed after it. That ordering is the whole
     * value: a handover that reports `3/3` against a list invented in the
     * same sentence is the failure already recorded in
     * `plans/verified-handover.md`.
     *
     * Compared field by field rather than by identity, so a render that
     * changes nothing returns the previous object and React can skip it.
     */
    try {
      /**
       * An artifact belongs to a conversation, and the files outlive it.
       *
       * On a brand-new chat the panel was drawing the *last* session's
       * `review.md` — reported that way, and it is a lie in the one place
       * that is supposed to say what the agent is working on now. The files
       * are deliberately durable (they are written for the user to read and
       * survive a restart), so the panel has to be the thing that decides.
       *
       * The rule is just the mtime: **written during this session, or not
       * shown**. Two looser rules were tried and both leaked the same lie a
       * beat later — `history.length > 0` is true within seconds of launch
       * because the file watcher appends a turn whenever anything on disk
       * moves, and "has a user turn" brings the stale file back the moment
       * you say anything at all.
       *
       * The file is not hidden, only unclaimed: it is on disk, `/plans` lists
       * it, and the moment the agent writes to it this session the panel
       * picks it up. What the panel must not do is present the last
       * conversation's checklist as this one's.
       */
      const read = (name) => {
        const at = paths.artifactPath(agentLoop.workspace, name);
        if (!fs.existsSync(at)) return null;
        if (fs.statSync(at).mtimeMs < SESSION_STARTED_AT) return null;
        return fs.readFileSync(at, 'utf8');
      };
      const next = { task: read('task.md'), review: read('review.md'), walkthrough: read('walkthrough.md') };
      setArtifacts((prev) => (
        prev.task === next.task && prev.review === next.review && prev.walkthrough === next.walkthrough
          ? prev
          : next));
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
      // Stopping means stopping. A queue that outlives the stop would start
      // the next prompt the moment the user thought they had halted it.
      setQueued([]);
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
      // Only the ones that actually wait. A spinner for a command that answers
      // in the same tick is drawn and erased around a `<Static>` write, and the
      // row it leaves behind is permanent — see `isSlowCommand`.
      //
      // The args go too: `/update` reaches the network and `/update done` reads
      // a file, so the first word cannot answer this on its own.
      const [slashWord, ...slashArgs] = query.slice(1).split(/\s+/);
      if (!turnInFlight && isSlowCommand(slashWord.toLowerCase(), slashArgs)) {
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
        pendingImage,
      });
      return;
    }

    // Busy? Queue it rather than letting the loop drop it on the floor.
    // Read from the loop, not from React's copy, which this function sets.
    if (agentLoop.isProcessing) {
      setQueued((q) => [...q, query]);
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
    // `__echo` marks this as the optimistic copy of a prompt the loop is about
    // to record too. `mergeLoopHistory` claims it when the loop's own copy
    // arrives, instead of drawing the prompt twice.
    setHistory(prev => [...prev, { role: 'user', content: query, timestamp: Date.now(), __echo: true }]);

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

  /**
   * Send the next queued prompt once the loop is genuinely idle.
   *
   * Gated on `agentLoop.isProcessing` rather than React's `isProcessing`: the
   * two disagree during a diff approval, and draining then would inject a
   * prompt into a turn that is parked on a decision.
   */
  useEffect(() => {
    if (queued.length === 0) return;
    if (isProcessing || agentLoop.isProcessing || diffRequest || activeMenu) return;
    const [next, ...rest] = queued;
    setQueued(rest);
    handleSubmit(next);
  }, [queued, isProcessing, diffRequest, activeMenu]);

  /**
   * Answer the diff prompt — and, on one of the three answers, stop asking.
   *
   * The mode switch belongs here rather than on a banner of its own. In plan
   * mode the model can already call `edit_file`; it just gets a diff first.
   * So "let me write without asking" is not a question that needs its own
   * screen — it is a third answer to the question already on screen, offered
   * at the one moment the user has the evidence to answer it: they are
   * looking at the change.
   *
   * Deliberately not a timed prompt. A countdown is right for a notice with a
   * safe default; this is a decision about whether later edits apply
   * unreviewed, and expiring it either picks silently or makes the user race
   * a clock while reading the diff it is about. It would also re-render the
   * live frame once a second forever, which is the one thing this UI is built
   * not to do — App's existing tick runs only while a turn does.
   */
  const handleDiffResponse = (action) => {
    if (!diffRequest) return;
    if (action === 'accept-auto') {
      agentLoop.mode = 'auto';
      setMode('auto');
    }
    const resolved = action === 'accept-auto' ? 'accept' : action;
    agentLoop.handleDiffResponse(Date.now().toString(), { diffId: diffRequest.diffId, action: resolved });
    setDiffRequest(null);
  };

  // The ctrl+ chords never reach Ink — see ui/hotkeys.js. They are inert while a
  // diff or a menu is up, so nothing can act behind a question the user has not
  // answered yet.
  useHotkeys({
    expand: toggleVerbose,
    artifacts: () => setArtifactsOpen((open) => !open),
    terminal: () => setTerminalOpen((prev) => {
      setFocus(prev ? FOCUS_INPUT : FOCUS_TERMINAL);
      return !prev;
    }),
    'paste-image': () => handleSubmit('/paste-image'),

    // The model picker, a stalled turn, a tab that was minimised — the three
    // times you need that tab and have to go hunting through windows for it.
    'focus-browser': () => agentLoop.focusModelTab?.(),

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
  }, !diffRequest && !activeMenu);

  useKeyBindings({
    input,
    queued,
    setQueued,
    activeMenu,
    agentLoop,
    cycleMode,
    diffRequest,
    focus,
    handleSubmit,
    historyIdx,
    inputHistory,
    isProcessing,
    newlineRef,
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
  const staticItems = staticRowsRef.current;

  return (
    <Box flexDirection="column" width="100%" overflow="hidden">
      {/*
        Settled transcript: written once, then owned by the terminal.

        Mounted unconditionally, *outside* the tab switch. <Static> only writes
        the items it has not written before, and it tracks that in component
        state — so unmounting it and mounting it again reprints the entire
        transcript, banner included. Putting it inside a tab branch meant a
        trip away and back reprinted everything, which is
        where the second banner came from.
      */}
      <Static key={staticEpoch} items={staticItems}>
        {(row) => {
          if (row.isBanner) {
            return <Banner key={row.id} agentLoop={agentLoop} agentNameAscii={agentNameAscii} />;
          }
          if (row.kind === 'user') {
            return (
              <UserBar key={row.id} content={row.content} isLive={false}
                terminalWidth={terminalWidth} compact={compact} />
            );
          }
          if (row.kind === 'summary') {
            return (
              // No `marginBottom`: the gap before the next turn belongs to that
              // turn's prompt bar, so that a turn which has both a summary and
              // a following bar does not get two blank rows. See UserBar.
              <Box key={row.id} flexDirection="column" width="100%">
                <TurnSummary
                  isLive={false}
                  duration={row.duration}
                  worked={row.worked}
                  touched={row.touched}
                />
              </Box>
            );
          }
          return (
            <TurnRow
              key={row.id}
              item={row.item}
              previous={row.previous}
              isLive={false}
              verbose={verbose}
              terminalWidth={terminalWidth}
            />
          );
        }}
      </Static>

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
          {/*
            The model the prompt is written for, against the one the tab is on.
            Both names, because "wrong model" without saying which is a warning
            you cannot act on — and `ctrl+b` is the key that shows the tab, so
            the row carries the fix rather than only the complaint.
          */}
          {mismatch && (
            <Text color="yellow" wrap="truncate">
              {'⚠ browser is on '}<Text bold>{mismatch.current}</Text>
              {', this rung wants '}<Text bold>{mismatch.wanted}</Text>
              <Text dimColor>{'  —  ctrl+b shows the tab'}</Text>
            </Text>
          )}

          {/* The in-flight turn — the only transcript rows Ink repaints. */}
          {liveTurns.map((turn) => (
            <TranscriptTurn
              key={turn.id}
              turn={turn}
              isLive
              fromItem={liveFrom}
              showUserBar={liveNeedsBar}
              compact={compact}
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
            mode={mode}
            terminalHeight={terminalHeight}
          />

          <InputBar
            queued={queued}
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
            artifactsOpen={artifactsOpen}
            artifactLines={artifactLines}
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
          {isProcessing
            ? <Text color="cyan"><Dots tick={animTick} /> agent</Text>
            : <Text color={extensionConnected ? 'cyan' : 'yellow'} bold>
                {extensionConnected ? '●' : '○'} agent
              </Text>}
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
          {attachedCount > 0 ? `${attachedCount} paste${attachedCount === 1 ? '' : 's'}  ·  ` : ''}
          {/*
            An attached image had no representation anywhere. The transcript
            said so once and scrolled away, so the only way to know one was
            armed was to remember attaching it — and the only way to find out
            was to send it. Same shape as the pastes beside it: one field in a
            row that is already drawn and already budgeted, costing nothing
            when there is no image.
          */}
          {pendingImage ? <Text color="yellow">{'1 image  ·  '}</Text> : ''}
          {runningTasks > 0 ? <Text color="yellow">{runningTasks} bg{'  ·  '}</Text> : ''}
          <Text color={mode === 'plan' ? 'yellow' : 'cyan'}>{mode}</Text>
          <Text dimColor> ⇥{'  ·  '}</Text>
          {/*
            Two different facts, and the row says which one it has.

            The effort is **ours** — how hard to work, now `low`/`medium`/`high`
            since it stopped being named after Google's models. The model is the
            **browser's**, and it is whatever its picker currently offers. Naming
            our rungs after their models is what made "flash" mean two things,
            and the status bar inherited that confusion.

            So: show the model when the picker has actually been read, because
            that is the more specific fact and the one a mismatch is about. Fall
            back to the rung when it has not — never invent a model, and never
            leave the row blank, which would read as "off".
          */}
          {browserModelLabel
            ? <Text color="cyan">{browserModelLabel}</Text>
            : <Text>{`effort: ${resolveEffort(agentLoop.modelConfig?.effort).id}`}</Text>}
          {'  ·  '}
          <Text color={tokenColor}>{tokenPct}% of {tokenLimit >= 1000 ? `${Math.round(tokenLimit / 1000)}k` : tokenLimit}</Text>
        </Text>
        </Box>
      </Box>
    </Box>
  );
}
