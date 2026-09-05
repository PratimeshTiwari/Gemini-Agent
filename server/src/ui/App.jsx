import React, { useState, useEffect, useReducer, useRef } from 'react';
import { Box, Text, useInput, useApp, useStdout, Static } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import Gradient from 'ink-gradient';
import crypto from 'crypto';
import SelectInput from 'ink-select-input';
import { useMouseTracking } from './mouse.jsx';
import { Clickable } from './components/Clickable.jsx';
import { GithubTab } from './components/GithubTab.jsx';
import { Menus, DiffApproval } from './components/Menus.jsx';
import { marked, oneLine, summarizeResult, clampForDisplay } from './format.js';
import { SLASH_COMMANDS, FOCUS_CHAT, FOCUS_INPUT, FOCUS_TERMINAL, THINKING_MESSAGES } from './constants.js';
import { groupTurns, collectFocusableItems, parseTurnActions } from './transcript.js';
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
      const parts = query.slice(1).split(/\s+/);
      const command = parts[0].toLowerCase();
      const args = parts.slice(1);

      if (command === 'shortcuts' || command === 'help') {
        const shortcutsMessage = {
          role: 'assistant',
          isLocal: true,
          content: [
            '### ⌨️ UI & Navigation',
            '  [Tab]             - Toggle focus between Chat Input and Tool Executions',
            '  [Up/Down]         - Navigate between tool executions or CLI tabs',
            '  [Enter]           - Expand/Minimize raw output of tools, or Open GitHub Plan',
            '  [Ctrl+T]          - Toggle the Agent Terminal at the bottom of the screen',
            '  [Ctrl+O]          - Toggle between Agent Chat and GitHub PR Dashboard',
            "  :stop             - Immediately cancel the agent's current generation",
            '',
            '### 🧠 AI & LLM Settings',
            '  /mode             - Change agent topology (Single, Duo, Swarm)',
            '  /model            - Switch model tier (Flash, Flash Thinking, Pro)',
            '  /allowlist        - Manage auto-approved/blocked command rules',
            '  /config           - Configure models for specific roles',
            '  /plan             - Switch to Plan Mode (requires approval for edits)',
            '  /auto             - Switch to Auto Mode (auto-applies safe edits)',
            '',
            '### 📁 Workspace & Context',
            '  /workspace <path> - Change the active workspace',
            '  /memory           - View current agent memory context',
            '  /context          - Show current context window usage',
            '  /compact          - Compact history to save tokens',
            '  /clear            - Clear local history',
            '  /new              - Start a new chat session',
            '  /undo             - Undo the last step/action',
            '  /init-skills      - Create workspace rules (.agent/rules.md)',
            '',
            '### 🛠️ System & Tools',
            '  /github           - Run GitHub specific commands (e.g., /github refresh)',
            '  /image            - Attach an image (e.g., /image path/to/img.png)',
            '  /paste-image      - Attach image directly from clipboard (macOS only)',
            '  /mouse            - Toggle mouse tracking (clickable rows)',
            '  /agent-dir        - Open the agent data directory',
            '  /restart          - Restart the server',
            '  /exit             - Quit the agent'
          ].join('\n')
        };
        setHistory(prev => [...prev, { role: 'user', content: query }, shortcutsMessage]);
        setIsProcessing(false);
        return;
      }

      if (command === 'exit') {
        setHistory(prev => [...prev, { role: 'user', content: query }, { role: 'assistant', content: '👋 Goodbye! Agent shutting down.', isLocal: true }]);
        setIsProcessing(false);
        setTimeout(() => process.exit(0), 100);
        return;
      }

      if (command === 'restart') {
        const indexPath = path.resolve(__dirname, '..', 'index.js');
        const now = new Date();
        try {
          fs.utimesSync(indexPath, now, now);
        setHistory(prev => [...prev, { role: 'user', content: query }, { role: 'assistant', content: '🔄 Restarting server...', isLocal: true }]);
        } catch (err) {
          setHistory(prev => [...prev, { role: 'user', content: query }, { role: 'assistant', content: '❌ Failed to restart server: ' + err.message, isLocal: true }]);
        }
        setIsProcessing(false);
        return;
      }

      if (command === 'clear') {
        agentLoop.conversationHistory = [];
        setHistory([]);
        resetScreen();
        setIsProcessing(false);
        return;
      }

      if (command === 'new') {
        agentLoop.conversationHistory = [];
        agentLoop.promptBuilder.resetPromptState();
        agentLoop.sessionStore.clear();
        setHistory([]);
        resetScreen();
        wsServer.broadcast('extension', { type: 'new_chat', payload: {} });
        setHistory([{ role: 'assistant', content: '✨ Starting a new chat in Gemini...', isLocal: true }]);
        setIsProcessing(false);
        return;
      }

      if (command === 'mode') {
        setActiveMenu({ type: 'mode' });
        setIsProcessing(false);
        return;
      }

      if (command === 'config') {
        setActiveMenu({ type: 'config_role' });
        setIsProcessing(false);
        return;
      }

      if (command === 'model') {
        setActiveMenu({ type: 'model' });
        setIsProcessing(false);
        return;
      }

      if (command === 'github' && args.length === 0) {
        setActiveMenu({ type: 'github' });
        setIsProcessing(false);
        return;
      }

      if (command === 'init-skills') {
        const { resolve } = await import('path');
        const { existsSync, mkdirSync, writeFileSync } = await import('fs');
        const rulesPath = paths.rulesPath(agentLoop.workspace);
        paths.ensureParent(rulesPath);
        
        let msg = '';
        if (!existsSync(rulesPath)) {
          writeFileSync(rulesPath, `# Workspace Rules\n\nAdd any custom instructions, architectural rules, or context specific to this project here.\n`, 'utf-8');
          msg = `✅ Created workspace memory at: ${rulesPath}\nEdit this file to teach the agent custom skills!`;
        } else {
          msg = `⚠️ Workspace rules already exist at: ${rulesPath}`;
        }
        setHistory(prev => [...prev, { role: 'user', content: query }, { role: 'assistant', content: msg, isLocal: true }]);
        setIsProcessing(false);
        return;
      }

      if (command === 'image' || command === 'paste-image') {
        let finalFilePath = '';
        let ext = '';
        if (command === 'paste-image') {
          if (process.platform !== 'darwin') {
             setHistory(prev => [...prev, { role: 'assistant', content: '⚠️ Clipboard image paste is only supported on macOS.' }]);
             setIsProcessing(false); return;
          }
          const { execSync } = await import('child_process');
          const { resolve } = await import('path');
          const { existsSync, mkdirSync } = await import('fs');
          
          try {
            const clipboardCheck = execSync(`osascript -e 'clipboard info'`, { encoding: 'utf-8', timeout: 5000 }).trim();
            if (!clipboardCheck.includes('«class PNGf»') && !clipboardCheck.includes('«class TIFF»') && !clipboardCheck.includes('JPEG')) {
              setHistory(prev => [...prev, { role: 'assistant', content: '⚠️ No image found in clipboard.' }]);
              setIsProcessing(false); return;
            }
            finalFilePath = resolve(paths.ensureDir(paths.tmpDir(agentLoop.workspace)), 'clipboard-image.png');
            execSync(`osascript -e 'set theFile to (open for access POSIX file "${finalFilePath}" with write permission)\n try\n write (the clipboard as «class PNGf») to theFile\n end try\n close access theFile'`, { timeout: 10000 });
            ext = '.png';
          } catch (e) {
            setHistory(prev => [...prev, { role: 'assistant', content: `❌ Failed to paste image: ${e.message}` }]);
            setIsProcessing(false); return;
          }
        } else {
          const { resolve, extname } = await import('path');
          const { existsSync } = await import('fs');
          finalFilePath = resolve(agentLoop.workspace, args.join(' '));
          if (!existsSync(finalFilePath)) {
             setHistory(prev => [...prev, { role: 'user', content: query }, { role: 'assistant', content: `❌ File not found: ${finalFilePath}` }]);
             setIsProcessing(false); return;
          }
          ext = extname(finalFilePath).toLowerCase();
        }

        try {
          const { readFileSync } = await import('fs');
          const imageBuffer = readFileSync(finalFilePath);
          const mimeTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };
          const mime = mimeTypes[ext] || 'image/png';
          setPendingImage({
            base64: imageBuffer.toString('base64'),
            mime,
            path: finalFilePath,
            sizeKB: Math.round(imageBuffer.length / 1024)
          });
          setHistory(prev => [...prev, { role: 'user', content: query }, { role: 'assistant', content: `🖼️ Image attached: ${finalFilePath} (${Math.round(imageBuffer.length / 1024)}KB)\nType your prompt and the image will be included.` }]);
        } catch (e) {
          setHistory(prev => [...prev, { role: 'user', content: query }, { role: 'assistant', content: `❌ Error reading image: ${e.message}` }]);
        }
        setIsProcessing(false);
        return;
      }

      if (command === 'mouse') {
        const arg = (args[0] || '').toLowerCase();
        let msg;
        if (!mouseTracking.supported) {
          msg = '⚠️ This terminal does not report mouse events.';
        } else if (arg === 'on' || (arg === '' && !mouseTracking.enabled)) {
          mouseTracking.enable();
          msg = '🖱️ Mouse tracking **on** — click tool rows, slash commands and menus.\n\n'
            + 'The terminal hands the mouse to the app while this is on: drag-select needs '
            + 'Option/Shift held, and the wheel no longer scrolls scrollback. `/mouse off` gives them back.';
        } else {
          mouseTracking.disable();
          msg = '🖱️ Mouse tracking **off** — text selection and scrollback are back.';
        }
        setHistory(prev => [...prev, { role: 'user', content: query }, { role: 'assistant', content: msg, isLocal: true }]);
        setIsProcessing(false);
        return;
      }

      // Handle standard agent loop commands
      const validAgentCommands = ['plan', 'auto', 'context', 'undo', 'workspace', 'memory', 'compact', 'clear', 'agent-dir', 'config', 'mode', 'model', 'allowlist', 'github'];
      if (validAgentCommands.includes(command)) {
        const result = await agentLoop.handleSlashCommand(command, args);
        
        if (command === 'clear' || command === 'undo' || command === 'compact') {
          const newHistory = [...agentLoop.conversationHistory];
          if (result && result.message) {
            newHistory.push({ role: 'assistant', content: result.message });
          }
          setHistory(newHistory);
        } else if (result && result.message) {
          setHistory(prev => [...prev, { role: 'user', content: query }, { role: 'assistant', content: result.message }]);
        }
      } else {
        setHistory(prev => [...prev, { role: 'user', content: query }, { role: 'assistant', content: `❌ Unrecognized command: \`/${command}\`\nType \`/help\` to see the list of available commands.` }]);
      }
      setIsProcessing(false);
      return;
    }

    let messageContent = query;
    if (pendingImage) {
      messageContent = `[Image attached: ${pendingImage.path} (${pendingImage.sizeKB}KB, ${pendingImage.mime})]\n\n<image_data>\ndata:${pendingImage.mime};base64,${pendingImage.base64}\n</image_data>\n\n${query}`;
      setPendingImage(null);
    }

    // Optimistically update the UI so the user sees their prompt immediately
    setHistory(prev => [...prev, { role: 'user', content: query }]);

    const callbacks = {
      sendToPanel: (msg) => {
        wsServer.broadcast('extension', msg);
        if (msg.type === 'agent_response') {
          setHistory([...agentLoop.conversationHistory]);
          setIsProcessing(false);
          setActiveToolCalls([]);
        } else if (msg.type === 'ask_question') {
          setActiveMenu({ type: 'ask_question', payload: msg.payload });
          setFocus(FOCUS_INPUT);
        } else if (msg.type === 'request_command_approval') {
          setActiveMenu({ type: 'command_approval', payload: msg.payload });
          setFocus(FOCUS_INPUT);
        } else if (msg.type === 'status') {
          setStatus(msg.payload.message || 'Processing...');
          isToolRunningRef.current = false;
        } else if (msg.type === 'tool_call') {
          setStatus(`Running ${msg.payload.name}...`);
          isToolRunningRef.current = true;
          setActiveToolCalls(prev => [...prev, { id: Date.now().toString(), type: 'call', name: msg.payload.name, args: msg.payload.args }]);
        } else if (msg.type === 'tool_result') {
          setActiveToolCalls(prev => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last) {
              last.result = msg.payload.result;
              last.success = msg.payload.success;
              
              if (last.success && (last.name === 'create_file' || last.name === 'edit_file' || last.name === 'write_to_file')) {
                const pathArg = last.args?.path || last.args?.TargetFile;
                if (pathArg && (pathArg.endsWith('implementation_plan.md') || pathArg.endsWith('plan.md')) && agentLoop.mode === 'plan') {
                  setPlanReviewReady(true);
                }
                if (pathArg && pathArg.endsWith('walkthrough.md')) {
                  setWalkthroughReady(true);
                }
              }
            }
            return updated;
          });
        } else if (msg.type === 'response_stream') {
          // Intentionally do NOT update status here to prevent UI tearing and scroll glitches
          // caused by re-rendering the entire history component 50+ times per second.
          // This also allows the 'Thinking...' messages to continue cycling during generation!
        }
      },
      injectPrompt: (msg) => {
        const success = wsServer.broadcast('extension', {
          id: crypto.randomUUID(),
          type: 'inject_prompt',
          payload: msg,
          timestamp: Date.now(),
        });
        
        if (!success) {
          try {
            const startUrl = 'https://gemini.google.com/app';
            if (process.platform === 'darwin') exec(`open "${startUrl}"`);
            else if (process.platform === 'win32') exec(`start "" "${startUrl}"`);
            else exec(`xdg-open "${startUrl}"`);
          } catch (e) {}

          agentLoop.isProcessing = false;
          setIsProcessing(false);
          setHistory(prev => [
            ...prev, 
            { role: 'assistant', content: '⚠️ **Gemini Extension Reconnecting...**\n\nAutomatically launched `https://gemini.google.com/app` in your browser. Once the tab opens, please submit your prompt again.' }
          ]);
        }
      },
      requestDiffApproval: (diff) => {
        setDiffRequest(diff);
        setIsProcessing(false);
      }
    };

    await agentLoop.handleUserMessage(messageContent, callbacks);
  };

  const handleDiffResponse = (action) => {
    if (!diffRequest) return;
    agentLoop.handleDiffResponse(Date.now().toString(), { diffId: diffRequest.diffId, action });
    setDiffRequest(null);
  };

  useInput((char, key) => {
    if (diffRequest) {
      // Deliberately inert: the diff is answered through the SelectInput below,
      // so a stray keystroke can never approve or reject an edit.
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

    if (key.tab) {
      setFocus(f => {
        const nextFocus = f === FOCUS_INPUT ? FOCUS_CHAT : FOCUS_INPUT;
        if (nextFocus === FOCUS_CHAT) {
          setSelectedToolIdx(focusableItems.length - 1);
        }
        return nextFocus;
      });
      return;
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

    // Input Navigation & History
    if (focus === FOCUS_INPUT) {
      if (key.upArrow) {
        if (inputHistory.length > 0) {
          const nextIdx = historyIdx === -1 ? inputHistory.length - 1 : Math.max(0, historyIdx - 1);
          setHistoryIdx(nextIdx);
          setInput(inputHistory[nextIdx]);
        }
        return;
      }
      if (key.downArrow) {
        if (historyIdx !== -1) {
          const nextIdx = historyIdx + 1;
          if (nextIdx >= inputHistory.length) {
            setHistoryIdx(-1);
            setInput('');
          } else {
            setHistoryIdx(nextIdx);
            setInput(inputHistory[nextIdx]);
          }
        }
        return;
      }
    }

    // Chat Navigation (Expand/Collapse Tool Logs)
    if (focus === FOCUS_CHAT) {
      // Clamp selected index just in case it got out of bounds
      const clampedIdx = Math.min(selectedToolIdx, Math.max(0, focusableItems.length - 1));
      
      if (key.upArrow) {
        setSelectedToolIdx(Math.max(0, clampedIdx - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedToolIdx(Math.min(focusableItems.length - 1, clampedIdx + 1));
        return;
      }
      if (key.return) {
        const item = focusableItems[clampedIdx];
        if (item) {
          setExpandedLogIds(prev => {
            const next = new Set(prev);
            if (next.has(item.id)) next.delete(item.id);
            else next.add(item.id);
            return next;
          });
        }
        return;
      }
    }
  });

  const submitTerminalCommand = async (cmd) => {
    if (!cmd.trim()) {
      setTerminalOpen(false);
      setFocus(FOCUS_INPUT);
      return;
    }
    
    // Check if docker sandbox is enabled
    let useSandbox = false;
    try {
      const configPath = paths.configPath(agentLoop.workspace);
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (config.useDockerSandbox) useSandbox = true;
      }
    } catch(e) {}

    let finalCommand = cmd;
    if (useSandbox) {
      const escapedCmd = cmd.replace(/'/g, "'\\''");
      finalCommand = `docker run --rm -v "${agentLoop.workspace}:/workspace" -w /workspace node:20-alpine sh -c '${escapedCmd}'`;
    } else {
      finalCommand = `cd "${agentLoop.workspace}" && ${cmd}`;
    }

    exec(finalCommand, (err, stdout, stderr) => {
      let output = stdout || stderr || (err ? err.message : '');
      if (!output) output = 'Command executed successfully (no output).';
      
      setHistory(prev => [
        ...prev,
        { role: 'user', content: `$ ${cmd}`, timestamp: Date.now() },
        { role: 'system', type: 'command_output', content: output.trim(), cmd: cmd, timestamp: Date.now() }
      ]);
    });

    setTerminalInput('');
    setTerminalOpen(false);
    setFocus(FOCUS_INPUT);
  };

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
          selectedPrCommentIdx={selectedPrCommentIdx}
        />
      )}

      {activeTab === 'agent' && (
        <>
          {/* History */}
      <Box flexDirection="column" marginBottom={1}>
        {(() => {
          // Uses the top-level turns/staticTurns/interactiveTurns computed above

          const renderBanner = () => (
            <Box key="banner" flexDirection="column" marginBottom={1} width="100%">
              <Gradient name="mind">
                <Text>{agentNameAscii}</Text>
              </Gradient>
              <Text color="magenta">Developed by Pratimesh Tiwari</Text>
              <Text dimColor>
                {agentLoop.workspace}
                {'  ·  '}
                {(() => {
                  const topology = agentLoop.topology || 'single';
                  const roles = ['main'];
                  if (topology === 'duo' || topology === 'swarm') roles.push('reviewer');
                  if (topology === 'swarm') roles.push('reasoner');
                  return [...new Set(roles.map((r) => agentLoop.modelConfig?.[r]).filter(Boolean))].join(', ') || 'gemini';
                })()}
                {agentLoop.githubHandler?.poller?.username ? `  ·  github @${agentLoop.githubHandler.poller.username}` : ''}
              </Text>
            </Box>
          );

          const renderTurn = (turn, isLastTurn, isProcessingTurn, isStatic) => {
            const duration = ((turn.endTime - turn.startTime) / 1000).toFixed(1);
            const { actions, finalMessages } = parseTurnActions(turn);

            const isTurnHeaderFocused = !isStatic && focus === FOCUS_CHAT && focusableItems[clampedSelectedToolIdx]?.id === `turn_${turn.id}`;
            const isTurnActionsExpanded = isStatic || expandedLogIds.has(`turn_${turn.id}`) || (isLastTurn && isProcessingTurn);
            const turnHeaderPrefix = isTurnHeaderFocused ? <Text color="cyan">❯ </Text> : <Text>  </Text>;

            return (
              <Box key={turn.id} flexDirection="column" marginBottom={1} width="100%" flexShrink={1}>
                {/* User Message */}
                {turn.userMsg && (
                  <Box flexDirection="column" marginBottom={1} width="100%" flexShrink={1}>
                    <Text bold wrap="wrap"><Text color="white">❯</Text> {turn.userMsg.content}</Text>
                  </Box>
                )}

                {/* Agent Actions Block */}
                {turn.steps.length > 0 && (
                  <Box flexDirection="column" width="100%" flexShrink={1}>
                    {(() => {
                      const isFocused = !isStatic && focus === FOCUS_CHAT && focusableItems[clampedSelectedToolIdx]?.id === `turn_${turn.id}`;
                      const isExpanded = isStatic || expandedLogIds.has(`turn_${turn.id}`) || (isLastTurn && isProcessingTurn);
                      const focusPrefix = isFocused ? <Text color="cyan">❯ </Text> : <Text>  </Text>;

                      return (
                        <Box flexDirection="column" width="100%" flexShrink={1}>
                          {actions.length > 0 && (
                            <Box flexDirection="column" marginBottom={1} width="100%" flexShrink={1}>
                              <Clickable onClick={() => toggleExpanded(`turn_${turn.id}`)}>
                                <Text color={isFocused ? 'cyan' : 'gray'}>
                                  {focusPrefix}
                                  {isExpanded ? '▼' : '▶'} Worked for {isLastTurn && isProcessingTurn ? <Text color="cyan"><Spinner type="dots" /> {status}</Text> : <Text>{duration}s</Text>}
                                </Text>
                              </Clickable>
                              
                              {isExpanded && (
                                <Box flexDirection="column" paddingLeft={1} borderLeftStyle="single" borderLeftColor="dim" marginLeft={2} marginTop={1} width="100%" flexShrink={1}>
                                  {(() => {
                                    // Static turns are painted once and never repainted, so they
                                    // may be any height. A live turn must stay inside the viewport.
                                    const liveBudget = Math.max(3, Math.floor((terminalHeight - 16) / 3));
                                    const hidden = isStatic ? 0 : Math.max(0, actions.length - liveBudget);
                                    return hidden > 0 ? (
                                      <Text dimColor>  … {hidden} earlier step{hidden === 1 ? '' : 's'} hidden — they appear in full once the turn finishes</Text>
                                    ) : null;
                                  })()}
                                  {(isStatic
                                    ? actions
                                    : actions.slice(Math.max(0, actions.length - Math.max(3, Math.floor((terminalHeight - 16) / 3))))
                                  ).map((act, idx) => {
                                    // Paired tool_call + tool_result: one collapsed row.
                                    if (act.type === 'tool') {
                                      const open = expandedLogIds.has(act.id);
                                      const mark = act.success === false ? '✗' : '⏺';
                                      const markColor = act.success === false ? 'red' : 'green';
                                      return (
                                        <Box key={act.id} flexDirection="column" width="100%" flexShrink={1}>
                                          <Clickable onClick={() => toggleExpanded(act.id)} flexDirection="row">
                                            <Text color={markColor}>{'  ' + mark + ' '}</Text>
                                            <Text bold color={isFocused ? 'cyan' : 'gray'}>{act.toolName}</Text>
                                            <Text dimColor> · {summarizeResult(act.toolName, act.result)}</Text>
                                          </Clickable>
                                          {open && (
                                            <Box flexDirection="column" paddingLeft={4} marginY={1} width="100%" flexShrink={1}>
                                              <Text dimColor wrap="wrap">{clampForDisplay(act.result, 20)}</Text>
                                            </Box>
                                          )}
                                        </Box>
                                      );
                                    }
                                    // A result with no matching call (rare, but possible mid-stream).
                                    if (act.type === 'tool_result') {
                                      const open = expandedLogIds.has(act.id);
                                      return (
                                        <Box key={act.id} flexDirection="column" width="100%" flexShrink={1}>
                                          <Clickable onClick={() => toggleExpanded(act.id)} flexDirection="row">
                                            <Text color="green">{'  ⏺ '}</Text>
                                            <Text dimColor>{oneLine(act.result)}</Text>
                                          </Clickable>
                                          {open && (
                                            <Box flexDirection="column" paddingLeft={4} marginY={1} width="100%" flexShrink={1}>
                                              <Text dimColor wrap="wrap">{clampForDisplay(act.result, 20)}</Text>
                                            </Box>
                                          )}
                                        </Box>
                                      );
                                    }
                                    if (act.type === 'think') {
                                      const open = expandedLogIds.has(act.id);
                                      const lineCount = act.content.split('\n').length;
                                      return (
                                        <Box key={act.id} flexDirection="column" width="100%" flexShrink={1}>
                                          <Clickable onClick={() => toggleExpanded(act.id)}>
                                            <Text dimColor>{'  ✻ Thinking… '}({lineCount} line{lineCount === 1 ? '' : 's'})</Text>
                                          </Clickable>
                                          {open && (
                                            <Box paddingLeft={4} marginY={1} width="100%" flexShrink={1}>
                                              <Text dimColor wrap="wrap">{act.content}</Text>
                                            </Box>
                                          )}
                                        </Box>
                                      );
                                    }
                                    if (act.type === 'command_output') {
                                      return (
                                        <Box key={act.id} marginY={0} width="100%" flexShrink={1}>
                                          <Text dimColor wrap="wrap">{clampForDisplay(act.content, 6, 400)}</Text>
                                        </Box>
                                      );
                                    }
                                    if (act.type === 'system') {
                                      return (
                                        <Box key={act.id} marginY={0} width="100%" flexShrink={1}>
                                          <Text dimColor wrap="wrap">{act.content ?? act.msg?.content}</Text>
                                        </Box>
                                      );
                                    }
                                    if (act.type === 'image') {
                                      return <Text key={act.id} dimColor>{'  ∙ Attached image: '}{act.content}</Text>;
                                    }
                                    return null;
                                  })}
                                </Box>
                              )}
                            </Box>
                          )}
                          
                          {finalMessages.map((fm, idx) => {
                            const isLastFinalMsg = isLastTurn && !isProcessingTurn && idx === finalMessages.length - 1;
                            const rawParsed = marked.parse((fm.content || '').replace(/\*\*(.*?)\*\*/g, '\x1b[1m$1\x1b[22m').replace(/^###\s+(.*$)/gm, '\x1b[1;32m$1\x1b[0m')).trim();
                            const displayText = (isLastFinalMsg && !isStatic && revealedLength < Infinity)
                              ? rawParsed.substring(0, revealedLength)
                              : rawParsed;
                            return (
                              <Box key={idx} flexDirection="row" marginTop={actions.length > 0 ? 1 : 0} marginBottom={1} width="100%" flexShrink={1}>
                                {!fm.msg.isLocal && <Text color="green">● </Text>}
                                <Box flexGrow={1} flexShrink={1}>
                                  <Text wrap="wrap">{displayText}{isLastFinalMsg && !isStatic && revealedLength < Infinity ? <Text color="cyan">▋</Text> : null}</Text>
                                </Box>
                              </Box>
                            );
                          })}
                        </Box>
                      );
                    })()}

                    {/* Artifacts Summary Box */}
                    {isLastTurn && !isProcessingTurn && (artifacts.task || artifacts.walkthrough) && (
                      <Box flexDirection="column" borderStyle="round" borderColor="yellow" padding={1} marginTop={1}>
                        <Text bold color="yellow">📋 Workspace Artifacts Summary</Text>
                        
                        {artifacts.task && (
                          <Box flexDirection="column" marginTop={1}>
                            <Text bold underline color="cyan">task.md</Text>
                            <Box paddingLeft={2}>
                              <Text dimColor wrap="wrap">{artifacts.task}</Text>
                            </Box>
                          </Box>
                        )}
                        
                        {artifacts.walkthrough && (
                          <Box flexDirection="column" marginTop={1}>
                            <Text bold underline color="cyan">walkthrough.md</Text>
                            <Box paddingLeft={2}>
                              <Text dimColor wrap="wrap">{artifacts.walkthrough}</Text>
                            </Box>
                          </Box>
                        )}
                      </Box>
                    )}
                  </Box>
                )}
              </Box>
            );
          };

          const showBannerInStatic = turns.length > 0;
          const staticItems = showBannerInStatic ? [{ id: 'app-banner', isBanner: true }, ...staticTurns] : staticTurns;

          return (
            <>
              {!showBannerInStatic && renderBanner()}
              {staticItems.length > 0 && (
                <Static key={staticEpoch} items={staticItems}>
                  {(item) => {
                    if (item.isBanner) return renderBanner();
                    return renderTurn(item, false, false, true);
                  }}
                </Static>
              )}
              {interactiveTurns.map((turn, idx) => {
                const isLastTurn = idx === interactiveTurns.length - 1;
                return renderTurn(turn, isLastTurn, isLastTurn && isProcessing, false);
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

      {/* Status Spinner */}
      {isProcessing && !diffRequest && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="cyan">
            <Spinner type="dots" /> {isToolRunningRef.current ? status : (thinkingDisplayText || status)}
            <Text dimColor>
              {' ('}{elapsed}s
              {syncTokenEstimate > 0 ? ` · ↑ ${syncTokenEstimate >= 1000 ? `${(syncTokenEstimate / 1000).toFixed(1)}k` : syncTokenEstimate} tokens` : ''}
              {')'}
            </Text>
          </Text>
          {isThinkingTooLong && (
            <Text color="yellow">  (Taking a while... ensure Chrome is not minimized!)</Text>
          )}
        </Box>
      )}

      {/* Main Input */}
      {!diffRequest && !terminalOpen && !activeMenu && (
        <Box flexDirection="column" marginTop={1}>
          {!extensionConnected && (
            <Box marginBottom={1}>
              <Text color="yellow">⚠️ Open a Gemini tab in Chrome — the extension is not connected</Text>
            </Box>
          )}
          {slashOpen && (
            <Box flexDirection="column" marginBottom={1} paddingX={1}>
              {slashMatches.map((cmd, idx) => (
                <Clickable
                  key={cmd.name}
                  onClick={() => {
                    setInput('');
                    setSlashIdx(0);
                    handleSubmit(`/${cmd.name}`);
                  }}
                  flexDirection="row"
                >
                  <Text color={idx === slashSelected ? 'cyan' : 'gray'} bold={idx === slashSelected}>
                    {(idx === slashSelected ? '❯ ' : '  ') + `/${cmd.name}`.padEnd(16)}
                  </Text>
                  <Text dimColor>{cmd.desc}</Text>
                </Clickable>
              ))}
            </Box>
          )}
          <Clickable
            onClick={() => setFocus(FOCUS_INPUT)}
            flexDirection="row"
            borderStyle="round"
            borderColor={focus === FOCUS_INPUT ? 'cyan' : 'gray'}
            paddingX={1}
            width="100%"
          >
            <Text bold color={focus === FOCUS_INPUT ? 'cyan' : 'gray'}>{'> '}</Text>
            {focus === FOCUS_INPUT ? (
              <TextInput
                focus={focus === FOCUS_INPUT}
                value={input}
                onChange={(v) => {
                  setInput(v);
                  setSlashIdx(0);
                }}
                onSubmit={(value) => {
                  if (slashOpen) {
                    const picked = `/${slashMatches[slashSelected].name}`;
                    setInput('');
                    setSlashIdx(0);
                    handleSubmit(picked);
                    return;
                  }
                  handleSubmit(value);
                }}
                placeholder="Ask anything, or / for commands"
              />
            ) : (
              <Text dimColor>{input || 'Press Tab to focus input…'}</Text>
            )}
          </Clickable>
          <Clickable onClick={cycleMode} paddingX={1}>
            <Text color={mode === 'auto' ? 'green' : 'yellow'}>
              ▶▶ {mode} mode on <Text dimColor>(shift+tab to cycle)</Text>
            </Text>
          </Clickable>
        </Box>
      )}


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
      {terminalOpen && (
        <Box borderStyle="single" borderColor="green" padding={1} flexDirection="column" width="100%">
          <Text bold color="green">💻 Agent Terminal (Press ESC to close)</Text>
          <Box>
            <Text bold color="green">$ </Text>
            {focus === FOCUS_TERMINAL ? (
              <TextInput focus={focus === FOCUS_TERMINAL} value={terminalInput} onChange={setTerminalInput} onSubmit={submitTerminalCommand} />
            ) : (
              <Text>{terminalInput}</Text>
            )}
          </Box>
        </Box>
      )}
      </>
      )}

      {/* Fixed Status Bar */}
      <Box marginTop={1} paddingX={1} flexDirection="column" width="100%" borderTopStyle="single" borderTopColor="gray">
        {activeTab === 'agent' ? (
          <>
            <Box flexDirection="row" justifyContent="space-between" width="100%">
              <Text>
                {isProcessing ? <Text color="yellow"><Spinner type="dots" /> Agent</Text> : <Text color={extensionConnected ? 'cyan' : 'yellow'} bold> {extensionConnected ? '🟢' : '🟡'} Agent</Text>}
                <Text dimColor> | GitHub {hasNewGitHubEvent ? '🔴 ' : ''}(Ctrl+O) </Text>
              </Text>
              <Text dimColor>
                Model: <Text bold>{agentLoop.modelConfig?.modelTier?.toUpperCase() || 'PRO'}</Text> | Tokens: <Text color={tokenColor}>~{syncTokenEstimate.toLocaleString()} / {tokenLimit.toLocaleString()} ({tokenPct}%)</Text>
              </Text>
            </Box>
            <Box flexDirection="row" justifyContent="space-between" width="100%">
              <Text dimColor>
                [Ctrl+T] Terminal{mouseTracking.enabled ? ' | 🖱 /mouse off to select text' : ''}
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
              <Text>
                <Text dimColor> Agent (Ctrl+O) | </Text>
                <Text color="cyan" bold> 🐙 GitHub</Text>
              </Text>
              <Text dimColor>
                Viewing: <Text bold>{hasNewGitHubEvent ? 'NEW ACTIVITY' : 'IDLE'}</Text>
              </Text>
            </Box>
            <Box flexDirection="row" justifyContent="space-between" width="100%">
              <Text dimColor>
                [Ctrl+T] Terminal{mouseTracking.enabled ? ' | 🖱 /mouse off to select text' : ''}
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
