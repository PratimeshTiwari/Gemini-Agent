import React, { useState, useEffect, useReducer, useRef } from 'react';
import { Box, Text, useInput, useApp, useStdout, Static } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import Gradient from 'ink-gradient';
import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import crypto from 'crypto';
import SelectInput from 'ink-select-input';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import figlet from 'figlet';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

marked.use(markedTerminal({
  tab: 2,
  width: 100,
  showSectionPrefix: false,
  tableOptions: {
    style: { head: ['cyan'] }
  }
}));

const FOCUS_CHAT = 'chat';
const FOCUS_INPUT = 'input';
const FOCUS_TERMINAL = 'terminal';

const THINKING_MESSAGES = [
  'Thinking...',
  'Gemining...',
  'Vibing...',
  'Analyzing syntax...',
  'Consulting the AI elders...',
  'Pondering the orb...',
  'Brewing code...',
  'Synthesizing logic...',
];

function parseTurnActions(turn) {
  const actions = [];
  const finalMessages = [];

  for (let sIdx = 0; sIdx < turn.steps.length; sIdx++) {
    const msg = turn.steps[sIdx];

    if (msg.role === 'assistant' || msg.role === 'agent') {
      const thinkMatch = msg.content.match(/<think>([\s\S]*?)<\/think>/);
      let cleanContent = msg.content.replace(/<think>[\s\S]*?<\/think>/, '').trim();
      const imgMatch = cleanContent.match(/🖼️ Image attached: (.*?\.png|.*?\.jpg|.*?\.jpeg|.*?\.webp)/);

      if (imgMatch) {
        cleanContent = cleanContent.replace(imgMatch[0], '').trim();
        actions.push({
          type: 'image',
          id: `turn_${turn.id}_act_${sIdx}`,
          content: imgMatch[1],
          msg
        });
      }

      if (thinkMatch) {
        actions.push({
          type: 'think',
          id: `turn_${turn.id}_act_${sIdx}`,
          content: thinkMatch[1].trim(),
          msg
        });
      }

      if (cleanContent) {
        finalMessages.push({
          type: 'text',
          content: cleanContent,
          msg
        });
      }
    } else if (msg.type === 'tool_call') {
      const nextMsg = turn.steps[sIdx + 1];
      let result = null;
      let success = null;
      if (nextMsg && nextMsg.type === 'tool_result') {
        result = nextMsg.result;
        success = nextMsg.success;
        sIdx++; // Group tool_result with tool_call into one action
      }
      actions.push({
        type: 'tool',
        id: `turn_${turn.id}_act_${sIdx}`,
        toolName: msg.toolName || msg.name,
        args: msg.args,
        result,
        success,
        msg
      });
    } else if (msg.type === 'tool_result') {
      actions.push({
        type: 'tool_result',
        id: `turn_${turn.id}_act_${sIdx}`,
        result: msg.result,
        success: msg.success,
        msg
      });
    } else if (msg.role === 'system') {
      if (msg.type === 'command_output') {
        actions.push({
          type: 'command_output',
          id: `turn_${turn.id}_act_${sIdx}`,
          content: msg.content,
          msg
        });
      } else {
        actions.push({
          type: 'system',
          id: `turn_${turn.id}_act_${sIdx}`,
          content: msg.content,
          msg
        });
      }
    }
  }

  return { actions, finalMessages };
}

export function App({ agentLoop, wsServer }) {
  const { exit } = useApp();
  const [input, setInput] = useState('');
  const [history, setHistory] = useState([...agentLoop.conversationHistory]);
  const [activeToolCalls, setActiveToolCalls] = useState([]);
  const [agentNameAscii, setAgentNameAscii] = useState(() => {
    let name = 'Gemini Agent';
    try {
      const customNamePath = path.join(agentLoop.workspace, 'setAgentName.json');
      if (fs.existsSync(customNamePath)) {
        const custom = JSON.parse(fs.readFileSync(customNamePath, 'utf8'));
        if (custom.agentName) name = `${custom.agentName} Agent`;
      } else {
        const configPath = path.join(agentLoop.workspace, '.gemini', 'config.json');
        if (fs.existsSync(configPath)) {
          const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
          if (config.agent_name) name = `${config.agent_name} Agent`;
        }
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
      const customNamePath = path.join(agentLoop.workspace, 'setAgentName.json');
      if (fs.existsSync(customNamePath)) {
        const custom = JSON.parse(fs.readFileSync(customNamePath, 'utf8'));
        if (custom.agentName) name = `${custom.agentName} Agent`;
      } else {
        const configPath = path.join(agentLoop.workspace, '.gemini', 'config.json');
        if (fs.existsSync(configPath)) {
          const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
          if (config.agent_name) name = `${config.agent_name} Agent`;
        }
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

  // 1. Group history into turns
  const turns = [];
  let currentTurn = null;
  let turnId = 0;
  history.forEach((msg, i) => {
    msg._globalIdx = i;
    if (msg.role === 'user') {
      if (currentTurn) turns.push(currentTurn);
      currentTurn = { id: turnId++, userMsg: msg, steps: [], startTime: msg.timestamp || Date.now(), endTime: msg.timestamp || Date.now() };
    } else if (currentTurn) {
      currentTurn.steps.push(msg);
      currentTurn.endTime = msg.timestamp || currentTurn.endTime;
    } else {
      currentTurn = { id: turnId++, userMsg: null, steps: [msg], startTime: msg.timestamp || Date.now(), endTime: msg.timestamp || Date.now() };
    }
  });
  if (currentTurn) turns.push(currentTurn);

  const INTERACTIVE_COUNT = 1;
  const staticTurns = turns.slice(0, Math.max(0, turns.length - INTERACTIVE_COUNT));
  const interactiveTurns = turns.slice(Math.max(0, turns.length - INTERACTIVE_COUNT));

  // 2. Compute dense array of ALL focusable items for UI navigation
  const focusableItems = [];
  interactiveTurns.forEach(turn => {
    const hasActions = turn.steps.some(m => m.type === 'tool_call' || m.type === 'tool_result' || m.role === 'system' || (m.role === 'assistant' && m.content.includes('<think>')));
    if (hasActions) {
      focusableItems.push({ type: 'turn_actions', id: `turn_${turn.id}`, turnId: turn.id, turn });
    }
  });

  activeToolCalls.forEach((call, idx) => {
    focusableItems.push({ type: 'activeCall', sourceIdx: idx, id: call.id, call });
  });

  // Ensure selected tool index is within bounds of all focusable items
  const clampedSelectedToolIdx = Math.min(selectedToolIdx, Math.max(0, focusableItems.length - 1));

  // Sliding window logic removed, relying on interactiveTurns instead.



  useEffect(() => {
    if (!isProcessing) {
      if (planReviewReady) {
        setActiveMenu({ type: 'plan_review' });
        setPlanReviewReady(false);
        setFocus(FOCUS_INPUT);
        try {
          const implPlanPath = path.join(agentLoop.workspace, '.gemini', 'implementation_plan.md');
          const simplePlanPath = path.join(agentLoop.workspace, '.gemini', 'plan.md');
          const planPath = fs.existsSync(implPlanPath) ? implPlanPath : simplePlanPath;
          
          exec(`"${agentLoop.editor || 'code'}" "${planPath}" || open "${planPath}" || xdg-open "${planPath}"`);
        } catch (e) {}
      }

      if (walkthroughReady) {
        setWalkthroughReady(false);
        try {
          const walkRoot = path.join(agentLoop.workspace, '.gemini', 'walkthrough.md');
          const walkFallback = path.join(agentLoop.workspace, 'walkthrough.md');
          const walkPath = fs.existsSync(walkRoot) ? walkRoot : walkFallback;
          
          exec(`"${agentLoop.editor || 'code'}" "${walkPath}" || open "${walkPath}" || xdg-open "${walkPath}"`);
        } catch (e) {}
      }

      try {
        const taskRoot = path.resolve(agentLoop.workspace, '.gemini/task.md');
        const taskFallback = path.resolve(agentLoop.workspace, 'task.md');
        const taskPath = fs.existsSync(taskRoot) ? taskRoot : taskFallback;
        
        const walkRoot = path.resolve(agentLoop.workspace, '.gemini/walkthrough.md');
        const walkFallback = path.resolve(agentLoop.workspace, 'walkthrough.md');
        const walkPath = fs.existsSync(walkRoot) ? walkRoot : walkFallback;

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
            '  /localllm         - Toggle local LLM engine',
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
            '  /init-skills      - Create workspace rules (.gemini/rules.md)',
            '',
            '### 🛠️ System & Tools',
            '  /github           - Run GitHub specific commands (e.g., /github refresh)',
            '  /image            - Attach an image (e.g., /image path/to/img.png)',
            '  /paste-image      - Attach image directly from clipboard (macOS only)',
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
        setIsProcessing(false);
        return;
      }

      if (command === 'new') {
        agentLoop.conversationHistory = [];
        agentLoop.promptBuilder.resetPromptState();
        agentLoop.sessionStore.clear();
        setHistory([]);
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

      if (command === 'localllm') {
        setActiveMenu({ type: 'localllm' });
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
        const geminiDir = resolve(agentLoop.workspace, '.gemini');
        const rulesPath = resolve(geminiDir, 'rules.md');
        
        if (!existsSync(geminiDir)) mkdirSync(geminiDir, { recursive: true });
        
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
            const tmpDir = resolve(agentLoop.workspace, '.gemini-agent');
            if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
            finalFilePath = resolve(tmpDir, 'clipboard-image.png');
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

      // Handle standard agent loop commands
      const validAgentCommands = ['plan', 'auto', 'context', 'undo', 'workspace', 'memory', 'compact', 'clear', 'agent-dir', 'config', 'mode', 'model', 'allowlist', 'localllm', 'github'];
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
      if (char === 'y') handleDiffResponse('accept');
      if (char === 'n') handleDiffResponse('reject');
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
      const configPath = path.join(agentLoop.workspace, '.gemini', 'config.json');
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
          const approvalPath = path.join(agentLoop.workspace, '.gemini', 'plan_approval.json');
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
        <Box flexDirection="column" flexGrow={1} borderStyle="single" borderColor="cyan" padding={1}>
          <Text bold color="cyan">📋 GitHub PR Dashboard</Text>
          
          
          {githubView === "avoid_words" && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold color="yellow">🚫 Avoid Words Editor</Text>
              <Text color="gray">These words indicate that a comment is noise (e.g. LGTM, +1) and should not be analyzed by the AI.</Text>
              
              <Box flexDirection="column" marginY={1} borderStyle="single" borderColor="gray" padding={1}>
                {avoidWords.map((word, i) => (
                  <Text key={i}>• {word}</Text>
                ))}
                {avoidWords.length === 0 && <Text dimColor>No avoid words configured.</Text>}
              </Box>
              
              <Box>
                <Text bold color="green">Add Word: </Text>
                <TextInput
                  focus={githubView === "avoid_words"}
                  value={newAvoidWord}
                  onChange={setNewAvoidWord}
                  onSubmit={(val) => {
                    if (!val.trim()) return;
                    const updated = [...avoidWords, val.trim()];
                    setAvoidWords(updated);
                    setNewAvoidWord("");
                    
                    if (agentLoop.githubHandler) {
                      agentLoop.githubHandler.config.avoidWords = updated;
                      agentLoop.modelConfig = agentLoop.modelConfig || {};
                      agentLoop.modelConfig.githubAvoidWords = updated;
                      agentLoop._saveConfig();
                    }
                  }}
                />
              </Box>
              <Text dimColor marginTop={1}>[Enter] to add | [ESC] to return to Dashboard</Text>
            </Box>
          )}



          {githubView === "pr_explorer" && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold color="magenta">🧭 PR Explorer</Text>
              
              {explorerMode === "prs" && (
                <Box flexDirection="column" marginY={1}>
                  <Text color="gray">Select a PR to view comments:</Text>
                  {loadingPrs ? (
                    <Text dimColor><Spinner type="dots" /> Loading PRs...</Text>
                  ) : prList.length === 0 ? (
                    <Box marginY={1}>
                      <Text dimColor>No open PRs found.</Text>
                    </Box>
                  ) : null}
                  {prList.map((pr, i) => (
                    <Text key={i} color={i === selectedPrIdx ? "white" : "gray"}>
                      {i === selectedPrIdx ? "❯ " : "  "}[{pr.repo.name}] #{pr.number} {pr.title}
                    </Text>
                  ))}
                </Box>
              )}
              
              {explorerMode === "comments" && (
                <Box flexDirection="column" marginY={1}>
                  <Box marginBottom={1}>
                    <Text bold color="cyan">PR #{prList[selectedPrIdx]?.number}</Text>
                    <Text color="gray"> — </Text>
                    <Text color="white">{prList[selectedPrIdx]?.title}</Text>
                  </Box>
                  <Text color="gray" dimColor>↵ Enter to dispatch to AI Agent  ·  ESC to go back</Text>
                  <Box flexDirection="column" marginTop={1}>
                    {loadingPrComments ? (
                      <Text dimColor><Spinner type="dots" /> Loading comments...</Text>
                    ) : prComments.length === 0 ? (
                      <Text dimColor>No comments found for this PR.</Text>
                    ) : null}
                    {prComments.map((c, i) => {
                      const isSelected = i === selectedPrCommentIdx;
                      const date = c.created_at ? new Date(c.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
                      const typeTag = c.type === 'review_comment' ? '[review]' : '[comment]';
                      return (
                        <Box key={i} flexDirection="column" marginBottom={1} borderStyle={isSelected ? 'single' : undefined} borderColor={isSelected ? 'cyan' : undefined} paddingX={isSelected ? 1 : 0}>
                          <Box flexDirection="row">
                            <Text color={isSelected ? 'cyan' : 'yellow'} bold>{isSelected ? '❯ ' : '  '}@{c.author}</Text>
                            <Text color="gray"> {typeTag}</Text>
                            {date ? <Text color="gray" dimColor>  {date}</Text> : null}
                            {c.path ? <Text color="magenta" dimColor>  📄 {c.path}</Text> : null}
                          </Box>
                          <Box marginLeft={isSelected ? 0 : 2}>
                            <Text color={isSelected ? 'white' : 'gray'} wrap="wrap">
                              {c.body.replace(/\n/g, ' ').substring(0, 100)}{c.body.length > 100 ? '...' : ''}
                            </Text>
                          </Box>
                        </Box>
                      );
                    })}
                  </Box>
                </Box>
              )}
              
              <Text dimColor marginTop={1}>[↑/↓] Navigate | [Enter] Select | [ESC] Back</Text>
            </Box>
          )}

          {githubView === "activity" && (
            <Box flexDirection="column" marginTop={1}>

          {!agentLoop.githubHandler ? (
            <Box flexDirection="column" marginTop={1}>
              <Text color="yellow" bold>⚠️ GitHub Setup Pending</Text>
              <Text>The GitHub PR integration is currently disabled because the <Text bold>GITHUB_TOKEN</Text> environment variable is not set.</Text>
              <Text></Text>
              <Text>To enable PR comment and CI failure watching:</Text>
              <Text>1. Go to <Text color="blue" underline>https://github.com/settings/tokens/new</Text> and generate a token with `repo` scope.</Text>
              <Text>2. Paste it below to automatically save it to your ~/.zshrc and start the integration.</Text>
              <Text></Text>
              <Box>
                <Text bold color="green">Token: </Text>
                <TextInput 
                  focus={activeTab === 'github' && !agentLoop.githubHandler}
                  value={githubSetupToken}
                  onChange={setGithubSetupToken}
                  onSubmit={async (val) => {
                    const token = val.trim();
                    if (!token) return;
                    try {
                      // Validate token first
                      const res = await fetch('https://api.github.com/user', {
                        headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'Gemini-Agent' }
                      });
                      if (!res.ok) {
                        console.error(`❌ Invalid token: GitHub API returned ${res.status}`);
                        setGithubSetupToken('');
                        return;
                      }

                      // Save to .gemini/config.json
                      agentLoop.modelConfig = agentLoop.modelConfig || {};
                      agentLoop.modelConfig.githubToken = token;
                      agentLoop._saveConfig(); // Fixed method name
                      
                      process.env.GITHUB_TOKEN = token;
                      
                      const { GitHubEventHandler } = await import('../github/github-event-handler.js');
                      const handler = new GitHubEventHandler({
                        token,
                        workspace: agentLoop.workspace,
                        configOverrides: { enableCIWatch: true }
                      });
                      
                      handler.on('status', ({ message }) => console.log(`  [GitHub] ${message}`));
                      handler.on('error', ({ message }) => console.error(`  [GitHub] ❌ ${message}`));
                      handler.on('notification', ({ message }) => console.log(`  [GitHub] ${message}`));
                      
                      agentLoop.githubHandler = handler;
                      wsServer.githubHandler = handler;
                      if (typeof wsServer._wireGitHubEvents === 'function') {
                        wsServer._wireGitHubEvents();
                      }
                      handler.start().catch(err => console.error(err));
                      
                      setGithubSetupToken('');
                    } catch (e) {
                      console.error("Failed to setup token:", e);
                    }
                  }}
                />
              </Box>
              <Text></Text>
              <Text dimColor>Press [Ctrl+O] to return to the Agent tab.</Text>
            </Box>
          ) : (
            <Box borderStyle="round" borderColor="cyan" padding={1} flexDirection="column" width="100%" flexShrink={1}>
              <Box flexDirection="row" marginBottom={1}>
                <Text bold color="cyan">📋 GitHub PR Dashboard</Text>
              </Box>
              <Box flexDirection="row" marginBottom={1} justifyContent="space-between">
                <Text>Status: {agentLoop.githubHandler?.getStatus()?.prsWatched || 0} PRs Watched | CI Watch: <Text color="green" bold>{agentLoop.githubHandler?.config?.enableCIWatch ? 'ON' : 'OFF'}</Text></Text>
                <Text dimColor>Last poll: {agentLoop.githubHandler?.getStatus()?.lastPollTime || 'Never'}</Text>
              </Box>

              {agentLoop.githubHandler?._currentAnalysis && (
                <Box borderStyle="round" borderColor="yellow" paddingX={2} marginBottom={1} flexDirection="column">
                  <Text color="yellow" bold>
                    <Text>🔄 Analyzing comment by @{agentLoop.githubHandler._currentAnalysis.author} on PR #{agentLoop.githubHandler._currentAnalysis.prNumber}...</Text>
                  </Text>
                  <Text dimColor>Please wait while the AI generates a plan. Queue size: {agentLoop.githubHandler?._commentQueue?.length || 0}</Text>
                </Box>
              )}
              <Box borderStyle="single" borderColor="gray" flexDirection="column" flexGrow={1} padding={1}>
                <Text bold marginBottom={1}>── Recent Activity ───────────────────────</Text>
                {githubActivity.length === 0 ? (
                  <Text dimColor>No activity yet. Waiting for PR comments or CI runs...</Text>
                ) : (
                  githubActivity.slice().reverse().map((activity, i) => {
                    if (activity.type === 'github_plan_generated') {
                      const visiblePlans = githubActivity.slice().reverse().filter(a => a.type === 'github_plan_generated').slice(0, 10);
                      const isSelected = activity.id === selectedPlanId || (selectedPlanId === null && visiblePlans[0]?.id === activity.id);
                      const isExpanded = expandedComments.has(activity.id);
                      let snippet = '';
                      if (activity.payload.comment && activity.payload.comment.body) {
                        snippet = activity.payload.comment.body;
                        if (!isExpanded) {
                          const lines = snippet.split('\n');
                          snippet = lines.slice(0, 2).join('\n') + (lines.length > 2 || snippet.length > 100 ? '...' : '');
                          if (snippet.length > 100) snippet = snippet.substring(0, 100) + '...';
                        }
                      }
                      return (
                        <Box key={activity.id} flexDirection="column" marginBottom={1}>
                          <Text color={isSelected ? 'cyan' : 'white'}>{isSelected ? '❯ ' : '  '}📝 PR #{activity.payload.prNumber} — AI Plan Generated</Text>
                          <Text dimColor marginLeft={4}>Category: {activity.payload.category}</Text>
                          {snippet && (
                            <Box marginLeft={4} flexDirection="column">
                              <Text dimColor>💬 {snippet}</Text>
                            </Box>
                          )}
                          <Text dimColor marginLeft={4}>→ {activity.payload.filePath.split('/').slice(-2).join('/')}</Text>
                        </Box>
                      );
                    } else if (activity.type === 'github_notification') {
                      return (
                        <Box key={activity.id} flexDirection="column" marginBottom={1}>
                          <Text>  ℹ️ {activity.payload.message}</Text>
                        </Box>
                      );
                    }
                    return null;
                  }).filter(Boolean).slice(0, 10)
                )}
              </Box>

              <Box marginTop={1}>
                <Text dimColor>[↑/↓] Navigate  [Space] Expand Comment  [Enter] Open Plan  [A] Avoid Words  [P] PR Explorer  [R] Refresh  [Ctrl+O] Agent</Text>
              </Box>
            </Box>
          )}
          </Box>
          )}
        </Box>
      )}

      {activeTab === 'agent' && (
        <>
          {/* History */}
      <Box flexDirection="column" marginBottom={1}>
        {(() => {
          // Uses the top-level turns/staticTurns/interactiveTurns computed above

          const renderBanner = () => (
            <Box key="banner" flexDirection="column" marginBottom={1} width="100%">
              <Box borderStyle="round" borderColor="dim" flexDirection="column" paddingX={2} paddingY={0} width="100%" alignItems="center">
                <Box flexDirection="column" alignItems="center">
                  <Gradient name="mind">
                    <Text>{agentNameAscii}</Text>
                  </Gradient>
                  <Box marginBottom={1}><Text color="magenta">Developed by Pratimesh Tiwari</Text></Box>
                </Box>
                
                <Box flexDirection="column" width="100%">
                  <Text color="gray">Workspace: <Text color="white">{agentLoop.workspace}</Text></Text>
                  <Text color="gray">GitHub: <Text color="white">{agentLoop.githubHandler?.poller?.username ? `Connected as @${agentLoop.githubHandler.poller.username}` : 'Not Connected'}</Text></Text>
                  <Text color="gray">Models: <Text color="white">{(() => {
                    const topology = agentLoop.topology || 'single';
                    const activeRoles = ['main'];
                    if (topology === 'duo' || topology === 'swarm') activeRoles.push('reviewer');
                    if (topology === 'swarm') activeRoles.push('reasoner');
                    return [...new Set(activeRoles.map(r => agentLoop.modelConfig?.[r]).filter(Boolean))].join(', ') || 'gemini';
                  })()}</Text></Text>
                  <Text color="gray">Extension: <Text color={extensionConnected ? 'green' : 'yellow'}>{extensionConnected ? '🟢 Connected' : '⚠️ Open a Gemini tab in Chrome'}</Text></Text>
                </Box>
              </Box>
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
                      const actions = [];
                      const finalMessages = [];
                      
                      turn.steps.forEach((msg, sIdx) => {
                        if (msg.role === 'assistant' || msg.role === 'agent') {
                          const thinkMatch = msg.content.match(/<think>([\s\S]*?)<\/think>/);
                          let cleanContent = msg.content.replace(/<think>[\s\S]*?<\/think>/, '').trim();
                          const imgMatch = cleanContent.match(/🖼️ Image attached: (.*?\.png|.*?\.jpg|.*?\.jpeg|.*?\.webp)/);
                          
                          if (imgMatch) {
                            cleanContent = cleanContent.replace(imgMatch[0], '').trim();
                            actions.push({ type: 'image', content: imgMatch[1], msg });
                          }
                          
                          if (thinkMatch) {
                            actions.push({ type: 'think', content: thinkMatch[1].trim(), msg });
                          }
                          if (cleanContent) {
                            finalMessages.push({ type: 'text', content: cleanContent, msg });
                          }
                        } else if (msg.type === 'tool_call') {
                          actions.push({ type: 'tool_call', msg });
                        } else if (msg.type === 'tool_result') {
                          actions.push({ type: 'tool_result', msg });
                        } else if (msg.role === 'system') {
                          actions.push({ type: 'system', msg });
                        }
                      });

                      const isFocused = !isStatic && focus === FOCUS_CHAT && focusableItems[clampedSelectedToolIdx]?.id === `turn_${turn.id}`;
                      const isExpanded = isStatic || expandedLogIds.has(`turn_${turn.id}`) || (isLastTurn && isProcessingTurn);
                      const focusPrefix = isFocused ? <Text color="cyan">❯ </Text> : <Text>  </Text>;

                      return (
                        <Box flexDirection="column" width="100%" flexShrink={1}>
                          {actions.length > 0 && (
                            <Box flexDirection="column" marginBottom={1} width="100%" flexShrink={1}>
                              <Text color={isFocused ? 'cyan' : 'gray'}>
                                {focusPrefix}
                                {isExpanded ? '▼' : '▶'} Worked for {isLastTurn && isProcessingTurn ? <Text color="cyan"><Spinner type="dots" /> {status}</Text> : <Text>{duration}s</Text>}
                              </Text>
                              
                              {isExpanded && (
                                <Box flexDirection="column" paddingLeft={1} borderLeftStyle="single" borderLeftColor="dim" marginLeft={2} marginTop={1} width="100%" flexShrink={1}>
                                  {actions.map((act, idx) => {
                                    if (act.type === 'tool_call') {
                                      const argsStr = JSON.stringify(act.msg.args || {});
                                      const shortArgs = argsStr.length > 60 ? argsStr.substring(0, 60) + '...' : argsStr;
                                      return (
                                        <Text key={idx} color={isFocused ? 'cyan' : 'gray'}>
                                          {isFocused ? '❯ ' : '  '}▶ <Text bold>Executed</Text> {act.msg.toolName} <Text dimColor>{shortArgs}</Text>
                                        </Text>
                                      );
                                    }
                                    if (act.type === 'tool_result') {
                                      const resultStr = typeof act.msg.result === 'string' ? act.msg.result : JSON.stringify(act.msg.result || {});
                                      const shortResult = resultStr.length > 60 ? resultStr.substring(0, 60) + '...' : resultStr;
                                      const resStr = typeof act.msg.result === 'string' ? act.msg.result : JSON.stringify(act.msg.result, null, 2);
                                      const lines = resStr.split('\n');
                                      const truncatedStr = lines.length > 15 ? lines.slice(0, 15).join('\n') + '\n... [Truncated]' : resStr;
                                      return (
                                        <Box key={idx} flexDirection="column" marginY={0} width="100%" flexShrink={1}>
                                          <Text color="gray">
                                            {'    '}✔ <Text bold>Result</Text> <Text dimColor>{shortResult}</Text>
                                          </Text>
                                          <Box flexDirection="column" paddingLeft={4} marginY={1} width="100%" flexShrink={1}>
                                            <Box borderStyle="round" borderColor="dim" paddingX={1} width="100%" flexShrink={1}>
                                              <Text dimColor wrap="wrap">{truncatedStr}</Text>
                                            </Box>
                                          </Box>
                                        </Box>
                                      );
                                    }
                                    if (act.type === 'think') {
                                      const lines = act.content.split('\n');
                                      const truncatedStr = lines.length > 10 ? lines.slice(0, 10).join('\n') + '\n... [Truncated]' : act.content;
                                      return (
                                        <Box key={idx} marginY={1} width="100%" flexShrink={1}>
                                          <Text dimColor wrap="wrap">∙ {truncatedStr}</Text>
                                        </Box>
                                      );
                                    }
                                    if (act.type === 'system') {
                                      return (
                                        <Box key={idx} marginY={1} width="100%" flexShrink={1}>
                                          <Text dimColor wrap="wrap">{act.msg.content}</Text>
                                        </Box>
                                      );
                                    }
                                    if (act.type === 'image') {
                                      return <Text key={idx} dimColor>∙ Attached Image: {act.content}</Text>;
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
                              <Box key={idx} borderStyle={fm.msg.isLocal ? undefined : 'round'} borderColor="blue" paddingX={fm.msg.isLocal ? 0 : 1} marginTop={actions.length > 0 ? 1 : 0} marginBottom={1} width="100%" flexShrink={1} flexDirection="column">
                                {!fm.msg.isLocal && (
                                  <Box borderBottomStyle="single" borderBottomColor="blue" paddingBottom={0} marginBottom={1} width="100%">
                                    <Text bold color="blue">Gemini</Text>
                                  </Box>
                                )}
                                <Text wrap="wrap">{displayText}{isLastFinalMsg && !isStatic && revealedLength < Infinity ? <Text color="cyan">▋</Text> : null}</Text>
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
                <Static items={staticItems}>
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
          <Text dimColor bold>⚙️ Tool Executions (Tab to focus, Enter to expand)</Text>
          {activeToolCalls.map((call, idx) => {
            const isFocused = focus === FOCUS_CHAT && focusableItems[clampedSelectedToolIdx]?.call === call;
            const isExpanded = expandedLogIds.has(call.id);
            
            return (
              <Box key={call.id} flexDirection="column" marginLeft={1}>
                <Text color={isFocused ? 'cyan' : 'gray'}>
                  {isFocused ? '▶ ' : '  '}
                  {isExpanded ? '▼' : '▶'} {call.name} {call.success === false ? '❌' : (call.result ? '✅' : '⏳')}
                </Text>
                
                {isExpanded && call.result && (
                  <Box marginLeft={4} borderStyle="single" borderColor="dim" padding={1}>
                    <Text dimColor>
                      {typeof call.result === 'string' 
                        ? (call.result.split('\n').length > 20 ? call.result.split('\n').slice(0, 20).join('\n') + '\n\n... [Result Truncated]' : call.result)
                        : (JSON.stringify(call.result, null, 2).split('\n').length > 20 ? JSON.stringify(call.result, null, 2).split('\n').slice(0, 20).join('\n') + '\n\n... [Result Truncated]' : JSON.stringify(call.result, null, 2))}
                    </Text>
                  </Box>
                )}
              </Box>
            );
          })}
        </Box>
      )}

      {/* Diff Request */}
      {diffRequest && (
        <Box borderStyle="single" borderColor="yellow" padding={1} flexDirection="column" width="100%" flexShrink={1}>
          <Text bold color="yellow" wrap="wrap">⚠️ Diff Approval Required: {diffRequest.filePath}</Text>
          <Text wrap="wrap">Approve this change? (y/n)</Text>
        </Box>
      )}

      {/* Status Spinner */}
      {isProcessing && !diffRequest && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="cyan">
            <Spinner type="dots" /> {isToolRunningRef.current ? status : (thinkingDisplayText || status)}
          </Text>
          {isThinkingTooLong && (
            <Text color="yellow">  (Taking a while... ensure Chrome is not minimized!)</Text>
          )}
        </Box>
      )}

      {/* Main Input */}
      {!diffRequest && !terminalOpen && !activeMenu && (
        <Box flexDirection="column" marginTop={1} paddingTop={1} borderTopStyle="single" borderTopColor="gray">
          {(() => {
            const hasExtension = wsServer.clients && Array.from(wsServer.clients.values()).some(c => c.type === 'extension');
            if (!hasExtension) {
              return (
                <Box marginBottom={1} flexDirection="column">
                  <Text color="yellow">⚠️ Extension not connected — Ensure a Gemini tab is open in Chrome</Text>
                  <Text color="dim">💡 Tip: Open gemini.google.com/app and check the extension is enabled</Text>
                </Box>
              );
            }
            return null;
          })()}
          <Box flexDirection="row">
            <Text bold color={focus === FOCUS_INPUT ? 'cyan' : 'gray'}>❯ </Text>
            {focus === FOCUS_INPUT ? (
              <TextInput focus={focus === FOCUS_INPUT} value={input} onChange={setInput} onSubmit={handleSubmit} />
            ) : (
              <Text dimColor>{input || 'Press Tab to focus input...'}</Text>
            )}
          </Box>
        </Box>
      )}


      {/* Interactive Menus */}
      {activeMenu?.type === 'ask_question' && (
        <Box flexDirection="column" borderStyle="single" borderColor="blue" padding={1}>
          <Text bold color="cyan">❓ {activeMenu.payload.question}</Text>
          <SelectInput
            items={activeMenu.payload.options.map(o => ({ label: o, value: o }))}
            onSelect={(item) => {
              setActiveMenu(null);
              agentLoop.answerQuestion(item.value);
              setHistory(prev => [...prev, { role: 'system', content: `[System: You answered: ${item.value}]` }]);
              setFocus(FOCUS_INPUT);
            }}
          />
        </Box>
      )}

      {activeMenu?.type === 'command_approval' && (
        <Box flexDirection="column" borderStyle="single" borderColor={activeMenu.payload.riskLevel === 'critical' ? 'red' : 'yellow'} padding={1}>
          <Text bold color={activeMenu.payload.riskLevel === 'critical' ? 'red' : 'yellow'}>
            ⚠️ Command Execution Request ({activeMenu.payload.riskLevel.toUpperCase()})
          </Text>
          <Text>Command: <Text bold>{activeMenu.payload.command}</Text></Text>
          <Text>Directory: {activeMenu.payload.cwd}</Text>
          <Text>Reason: {activeMenu.payload.riskReason}</Text>
          <SelectInput
            items={[
              { label: 'Allow Command Once', value: 'allow_once' },
              { label: 'Allow Always (Add to Allowlist)', value: 'allow_always' },
              { label: 'Reject Command', value: 'reject' },
              { label: 'Reject Always (Add to Blocklist)', value: 'reject_always' }
            ]}
            onSelect={(item) => {
              setActiveMenu(null);
              agentLoop.answerCommandApproval(item.value, activeMenu.payload.command);
              
              let statusMsg = '';
              if (item.value === 'allow_once') statusMsg = 'allowed once';
              if (item.value === 'allow_always') statusMsg = 'allowed always (added to allowlist)';
              if (item.value === 'reject') statusMsg = 'rejected';
              if (item.value === 'reject_always') statusMsg = 'rejected always (added to blocklist)';
              
              setHistory(prev => [...prev, { role: 'system', content: `[System: You ${statusMsg} the command: ${activeMenu.payload.command}]` }]);
              setFocus(FOCUS_INPUT);
            }}
          />
        </Box>
      )}

      {activeMenu?.type === 'plan_review' && (
        <Box flexDirection="column" borderStyle="single" borderColor="magenta" padding={1}>
          <Text bold color="magenta">📝 Implementation Plan Ready for Review</Text>
          <Text>The agent has created an implementation_plan.md artifact.</Text>
          <SelectInput
            items={[
              { label: 'Proceed with Implementation Plan', value: 'accept' },
              { label: 'Reject', value: 'reject' },
              { label: 'Provide Custom Feedback (Chat)', value: 'custom' }
            ]}
            onSelect={(item) => {
              setActiveMenu(null);
              if (item.value === 'accept') {
                handleSubmit('I have reviewed the implementation plan and approve it. Please proceed with the execution phase.');
              } else if (item.value === 'reject') {
                handleSubmit('I reject the implementation plan. Please wait for my feedback.');
              } else {
                setFocus(FOCUS_INPUT);
              }
            }}
          />
        </Box>
      )}

      {activeMenu?.type === 'mode' && (
        <Box flexDirection="column" borderStyle="single" borderColor="cyan" padding={1}>
          <Text bold color="cyan">Select Agent Topology Mode:</Text>
          <SelectInput
            items={[
              { label: `Single (Gemini only)${agentLoop.topology === 'single' ? '  ← (Current)' : ''}`, value: 'single' },
              { label: `Duo (Gemini + Reviewer)${agentLoop.topology === 'duo' ? '  ← (Current)' : ''}`, value: 'duo' },
              { label: `Swarm (Gemini + Reasoner + Reviewer)${agentLoop.topology === 'swarm' ? '  ← (Current)' : ''}`, value: 'swarm' }
            ]}
            onSelect={async (item) => {
              setActiveMenu(null);
              await agentLoop.handleSlashCommand('mode', [item.value]);
              setHistory([...agentLoop.conversationHistory]);
              setFocus(FOCUS_INPUT);
            }}
          />
        </Box>
      )}

      {activeMenu?.type === 'model' && (
        <Box flexDirection="column" borderStyle="single" borderColor="cyan" padding={1}>
          <Text bold color="cyan">Select Model Tier:</Text>
          <Text dimColor>  Tip: Also switch the model in your Gemini browser tab</Text>
          <SelectInput
            items={[
              { label: `⚡ Flash (Fast, minimal reasoning)${agentLoop.modelConfig?.modelTier === 'flash' ? '  ← (Current)' : ''}`, value: 'flash' },
              { label: `🧠 Flash Thinking (Moderate reasoning)${agentLoop.modelConfig?.modelTier === 'flash-thinking' ? '  ← (Current)' : ''}`, value: 'flash-thinking' },
              { label: `🔬 Pro (Deep principal-engineer reasoning)${agentLoop.modelConfig?.modelTier === 'pro' ? '  ← (Current)' : ''}`, value: 'pro' }
            ]}
            onSelect={async (item) => {
              setActiveMenu(null);
              await agentLoop.handleSlashCommand('model', [item.value]);
              setHistory([...agentLoop.conversationHistory]);
              setFocus(FOCUS_INPUT);
            }}
          />
        </Box>
      )}

      {activeMenu?.type === 'localllm' && (
        <Box flexDirection="column" borderStyle="single" borderColor="cyan" padding={1}>
          <Text bold color="cyan">Toggle Local LLM Engine (node-llama-cpp):</Text>
          <SelectInput
            items={[
              { label: `Enable Local LLM${agentLoop.modelConfig?.useLocalLlm ? '  ← (Current)' : ''}`, value: 'on' },
              { label: `Disable Local LLM (Cloud Only)${!agentLoop.modelConfig?.useLocalLlm ? '  ← (Current)' : ''}`, value: 'off' }
            ]}
            onSelect={async (item) => {
              setActiveMenu(null);
              await agentLoop.handleSlashCommand('localllm', [item.value]);
              setHistory([...agentLoop.conversationHistory]);
              setFocus(FOCUS_INPUT);
            }}
          />
        </Box>
      )}
      
      {activeMenu?.type === 'config_role' && (
        <Box flexDirection="column" borderStyle="single" borderColor="cyan" padding={1}>
          <Text bold color="cyan">Select Role to Configure:</Text>
          <SelectInput
            items={[
              { label: 'View Current Config', value: 'view' },
              { label: 'Main Agent', value: 'main' },
              { label: 'Reviewer Subagent', value: 'reviewer' },
              { label: 'Reasoner Subagent', value: 'reasoner' }
            ]}
            onSelect={async (item) => {
              if (item.value === 'view') {
                setActiveMenu(null);
                await agentLoop.handleSlashCommand('config', []);
                setHistory([...agentLoop.conversationHistory]);
                setFocus(FOCUS_INPUT);
              } else {
                setActiveMenu({ type: 'config_model', role: item.value });
              }
            }}
          />
        </Box>
      )}

      {activeMenu?.type === 'config_model' && (
        <Box flexDirection="column" borderStyle="single" borderColor="cyan" padding={1}>
          <Text bold color="cyan">Select Model for {activeMenu.role}:</Text>
          <SelectInput
            items={[
              { label: 'Google Gemini', value: 'gemini' },
              { label: 'ChatGPT', value: 'chatgpt' },
              { label: 'Claude', value: 'claude' }
            ]}
            onSelect={async (item) => {
              const role = activeMenu.role;
              setActiveMenu(null);
              await agentLoop.handleSlashCommand('config', [role, item.value]);
              setHistory([...agentLoop.conversationHistory]);
              setFocus(FOCUS_INPUT);
            }}
          />
        </Box>
      )}

      {activeMenu?.type === 'github' && (
        <Box flexDirection="column" borderStyle="single" borderColor="cyan" padding={1}>
          <Text bold color="cyan">📋 GitHub Integration Menu</Text>
          <SelectInput
            items={[
              { label: 'Refresh PR Activity Now', value: 'refresh' },
              { label: `CI Failure Watch [Currently: ${agentLoop.githubHandler?.config?.enableCIWatch ? 'ON' : 'OFF'}]`, value: 'ci-watch' },
              { label: 'Clear Poller State & Rescan', value: 'clear-state' },
              { label: 'Open PR Dashboard (Ctrl+O)', value: 'dashboard' },
              { label: 'Remove/Update GitHub Token', value: 'remove-token' },
            ]}
            onSelect={(item) => {
              setActiveMenu(null);
              if (item.value === 'dashboard') {
                setActiveTab('github');
                setFocus(FOCUS_CHAT);
              } else if (item.value === 'ci-watch') {
                const current = agentLoop.githubHandler?.config?.enableCIWatch;
                handleSubmit(`/github ci-watch ${current ? 'off' : 'on'}`);
              } else if (item.value === 'remove-token') {
                handleSubmit('/github remove-token');
              } else {
                handleSubmit(`/github ${item.value}`);
              }
            }}
          />
        </Box>
      )}

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
                [Ctrl+T] Terminal
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
                [Ctrl+T] Terminal
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
