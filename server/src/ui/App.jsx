import React, { useState, useEffect, useReducer } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import crypto from 'crypto';
import SelectInput from 'ink-select-input';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';

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

export function App({ agentLoop, wsServer }) {
  const { exit } = useApp();
  const [input, setInput] = useState('');
  const [history, setHistory] = useState([...agentLoop.conversationHistory]);
  const [activeToolCalls, setActiveToolCalls] = useState([]);

  const [isProcessing, setIsProcessing] = useState(false);
  const [status, setStatus] = useState('');
  const [thinkingIndex, setThinkingIndex] = useState(0);
  const [diffRequest, setDiffRequest] = useState(null);
  const [tasks, setTasks] = useState([]);
  
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

  // 2. Compute dense array of ALL focusable items for UI navigation
  const focusableItems = [];
  turns.forEach(turn => {
    turn.steps.forEach(msg => {
      let isFocusable = false;
      if (msg.role === 'assistant' || msg.role === 'agent') isFocusable = true;
      if (msg.type === 'tool_call' || msg.type === 'tool_result') isFocusable = true;
      if (msg.role === 'system' && msg.content?.includes('Command Output')) isFocusable = true;
      
      if (isFocusable) {
        focusableItems.push({ type: 'history', sourceIdx: msg._globalIdx, id: msg.timestamp || msg._globalIdx, turnId: turn.id, msg });
      }
    });
  });

  activeToolCalls.forEach((call, idx) => {
    focusableItems.push({ type: 'activeCall', sourceIdx: idx, id: call.id, call });
  });

  // Ensure selected tool index is within bounds of all focusable items
  const clampedSelectedToolIdx = Math.min(selectedToolIdx, Math.max(0, focusableItems.length - 1));

  // 3. Virtual Scrolling: Calculate sliding window based on focused item
  let focusedTurnId = turns.length > 0 ? turns[turns.length - 1].id : 0;
  if (focus === FOCUS_CHAT && focusableItems.length > 0) {
    const focusedItem = focusableItems[clampedSelectedToolIdx];
    if (focusedItem && focusedItem.turnId !== undefined) {
      focusedTurnId = focusedItem.turnId;
    }
  }

  // Display the focused turn, the one before it, and the one after it (window size of 3)
  const windowStart = Math.max(0, focusedTurnId - 2);
  const windowEnd = Math.min(turns.length, focusedTurnId + 1);
  const visibleTurns = turns.slice(windowStart, windowEnd);



  useEffect(() => {
    if (!isProcessing) {
      if (planReviewReady) {
        setActiveMenu({ type: 'plan_review' });
        setPlanReviewReady(false);
        setFocus(FOCUS_INPUT);
        try {
          const cp = require('child_process');
          const path = require('path');
          const fs = require('fs');
          
          const implPlanPath = path.join(agentLoop.workspace, '.gemini', 'implementation_plan.md');
          const simplePlanPath = path.join(agentLoop.workspace, '.gemini', 'plan.md');
          const planPath = fs.existsSync(implPlanPath) ? implPlanPath : simplePlanPath;
          
          cp.exec(`"${agentLoop.editor || 'code'}" "${planPath}" || open "${planPath}" || xdg-open "${planPath}"`);
        } catch (e) {}
      }

      if (walkthroughReady) {
        setWalkthroughReady(false);
        try {
          const cp = require('child_process');
          const path = require('path');
          const fs = require('fs');
          
          const walkRoot = path.join(agentLoop.workspace, '.gemini', 'walkthrough.md');
          const walkFallback = path.join(agentLoop.workspace, 'walkthrough.md');
          const walkPath = fs.existsSync(walkRoot) ? walkRoot : walkFallback;
          
          cp.exec(`"${agentLoop.editor || 'code'}" "${walkPath}" || open "${walkPath}" || xdg-open "${walkPath}"`);
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

  useEffect(() => {
    let interval;
    if (isProcessing && THINKING_MESSAGES.includes(status)) {
       interval = setInterval(() => {
         setThinkingIndex(i => {
           const next = (i + 1) % THINKING_MESSAGES.length;
           setStatus(THINKING_MESSAGES[next]);
           return next;
         });
       }, 500); // Faster cycle for better visual feedback
    }
    return () => clearInterval(interval);
  }, [isProcessing, status]);

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
    setIsProcessing(true);
    setStatus('Thinking...');
    setActiveToolCalls([]);
    
    if (query === ':stop') {
      wsServer.broadcast('extension', { type: 'stop_generation', timestamp: Date.now(), id: Date.now().toString() });
      agentLoop.isProcessing = false;
      setDiffRequest(null);
      setHistory(prev => [...prev, { role: 'user', content: query }, { role: 'assistant', content: '🛑 Agent generation stopped.' }]);
      setIsProcessing(false);
      return;
    }
    
    if (query.startsWith('/')) {
      const parts = query.slice(1).split(/\s+/);
      const command = parts[0].toLowerCase();
      const args = parts.slice(1);

      if (command === 'shortcuts' || command === 'help') {
        const shortcutsMessage = {
          role: 'assistant',
          content: [
            '### ⌨️ UI & Navigation',
            '  [Tab]     - Toggle focus between Chat Input and Tool Executions',
            '  [Up/Down] - Navigate between tool executions or CLI tabs',
            '  [Enter]   - Expand/Minimize raw output of tools, or Open GitHub Plan',
            '  [Ctrl+T]  - Toggle the Agent Terminal at the bottom of the screen',
            '  [Ctrl+O]  - Toggle between Agent Chat and GitHub PR Dashboard',
            "  :stop     - Immediately cancel the agent's current generation",
            '',
            '### 🧠 AI & LLM Settings',
            '  /mode       - Change agent topology (Single, Duo, Swarm)',
            '  /model      - Switch model tier (Flash, Flash Thinking, Pro)',
            '  /reasoning  - Change agent cognitive effort (alias for /model)',
            '  /config     - Configure models for specific roles',
            '  /localllm   - Toggle local LLM engine',
            '  /plan       - Switch to Plan Mode (requires approval for edits)',
            '  /auto       - Switch to Auto Mode (auto-applies safe edits)',
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
            '  /github     - Run GitHub specific commands (e.g., /github refresh)',
            '  /image      - Attach an image (e.g., /image path/to/img.png)',
            '  /paste-image- Attach image directly from clipboard (macOS only)',
            '  /agent-dir  - Open the agent data directory',
            '  /restart    - Restart the server',
            '  /exit       - Quit the agent'
          ].join('\n')
        };
        setHistory(prev => [...prev, { role: 'user', content: query }, shortcutsMessage]);
        setIsProcessing(false);
        return;
      }

      if (command === 'exit') {
        setHistory(prev => [...prev, { role: 'user', content: query }, { role: 'assistant', content: '👋 Goodbye! Agent shutting down.' }]);
        setIsProcessing(false);
        setTimeout(() => process.exit(0), 100);
        return;
      }

      if (command === 'restart') {
        const indexPath = path.resolve(__dirname, '..', 'index.js');
        const now = new Date();
        try {
          fs.utimesSync(indexPath, now, now);
          setHistory(prev => [...prev, { role: 'user', content: query }, { role: 'assistant', content: '🔄 Restarting server...' }]);
        } catch (err) {
          setHistory(prev => [...prev, { role: 'user', content: query }, { role: 'assistant', content: '❌ Failed to restart server: ' + err.message }]);
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
        setHistory([{ role: 'assistant', content: '✨ Starting a new chat in Gemini...' }]);
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

      if (command === 'reasoning' || command === 'model') {
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
        setHistory(prev => [...prev, { role: 'user', content: query }, { role: 'assistant', content: msg }]);
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
      const validAgentCommands = ['plan', 'auto', 'context', 'undo', 'workspace', 'memory', 'compact', 'clear', 'agent-dir', 'config', 'mode', 'model', 'reasoning', 'localllm', 'github'];
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
        } else if (msg.type === 'tool_call') {
          setStatus(`Running ${msg.payload.name}...`);
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
          agentLoop.isProcessing = false;
          setIsProcessing(false);
          setHistory(prev => [
            ...prev, 
            { role: 'assistant', content: '❌ **CONNECTION ERROR**: Gemini client is not connected!\n\n💡 To fix this:\n1. Close all gemini.google.com tabs and open a fresh one.\n2. If that doesn\'t work, reload the Chrome extension in chrome://extensions and refresh the tab.' }
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
        setGithubView(prev => (prev === 'pr_explorer' ? 'activity' : 'pr_explorer'));
        
        // If we are opening the explorer and don't have PRs, fetch them.
        if (githubView !== 'pr_explorer' && prList.length === 0) {
          try {
            if (agentLoop?.githubHandler?.fetchAllOpenPRs) {
              agentLoop.githubHandler.fetchAllOpenPRs()
                .then(prs => setPrList(prs))
                .catch(err => {
                   // Gracefully handle promise rejection without crashing
                });
            }
          } catch (err) {
             // Gracefully handle synchronous errors without crashing
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
               agentLoop.githubHandler.poller.fetchAllComments(pr)
                 .then(comments => { setPrComments(comments); setExplorerMode('comments'); setSelectedPrCommentIdx(0); })
                 .catch(err => {});
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
            const cp = require('child_process');
            cp.exec(`"${agentLoop.editor || 'code'}" "${item.payload.filePath}" || open "${item.payload.filePath}" || xdg-open "${item.payload.filePath}"`);
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

    // Escape returns to Input
    if (key.escape) {
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
      }
      if (key.downArrow) {
        setSelectedToolIdx(Math.min(focusableItems.length - 1, clampedIdx + 1));
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
        { role: 'system', content: `**Command Output:**\n\`\`\`\n${output.trim()}\n\`\`\``, timestamp: Date.now() }
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
          const path = require('path');
          const fs = require('fs');
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
    <Box flexDirection="column" height="100%">
      {/* Persistent Header */}
      <Box flexDirection="column" marginBottom={1}>
        <Box borderStyle="round" borderColor="blue" paddingX={2} width="100%" justifyContent="space-between">
          <Text bold color="white">🤖 Gemini Agent CLI (Ink Mode)</Text>
          <Text color="gray">
            {activeTab === 'agent' ? (
              <Text>[<Text color="white">🤖 Agent</Text>]  [<Text color="dim">Ctrl+O</Text> 📋 GitHub{hasNewGitHubEvent ? ' 🔴' : ''}]</Text>
            ) : (
              <Text>[<Text color="dim">Ctrl+O</Text> 🤖 Agent]  [<Text color="white">📋 GitHub</Text>]</Text>
            )}
          </Text>
        </Box>
        <Box paddingX={1} flexDirection="column">
          <Text color="gray">Workspace: <Text color="white">{agentLoop.workspace}</Text></Text>
          <Text color="gray">Port:      <Text color="white">{wsServer.port || 7777}</Text></Text>
          <Text color="gray">Status:    {wsServer.clients?.size > 0 ? <Text color="green">✅ Connected to Extension</Text> : <Text color="yellow">⏳ Waiting for Chrome Extension...</Text>}</Text>
          {(!wsServer.clients || wsServer.clients.size === 0) && (
            <Text color="dim">           💡 Tip: Go to chrome://extensions and refresh the Gemini Agent extension</Text>
          )}
        </Box>
      </Box>

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
                  {prList.length === 0 && <Text dimColor>Loading PRs...</Text>}
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
                    {prComments.length === 0 && <Text dimColor>Loading comments...</Text>}
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
                      
                      const { GitHubEventHandler } = await import('../github/GitHubEventHandler.js');
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
            <>
              <Box flexDirection="row" marginBottom={1} justifyContent="space-between">
                <Text>Status: {agentLoop.githubHandler?.getStatus()?.prsWatched || 0} PRs Watched | CI Watch: {agentLoop.githubHandler?.config?.enableCIWatch ? '✅ ON' : '⛔ OFF'}</Text>
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
            </>
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
          // 1. Parse history into Turns
          const turns = [];
          let currentTurn = null;
          let turnId = 0;

          history.forEach((msg, i) => {
            if (msg.role === 'user') {
              if (currentTurn) turns.push(currentTurn);
              currentTurn = {
                id: turnId++,
                userMsg: msg,
                steps: [],
                startTime: msg.timestamp || Date.now(),
                endTime: msg.timestamp || Date.now(),
              };
            } else if (currentTurn) {
              msg._globalIdx = i;
              currentTurn.steps.push(msg);
              currentTurn.endTime = msg.timestamp || currentTurn.endTime;
            } else {
              currentTurn = {
                id: turnId++,
                userMsg: null,
                steps: [{ ...msg, _globalIdx: i }],
                startTime: msg.timestamp || Date.now(),
                endTime: msg.timestamp || Date.now(),
              };
            }
          });
          if (currentTurn) turns.push(currentTurn);

          // 2. Render only the last 3 turns to prevent overflow
          const visibleTurns = turns.slice(-3);

          return visibleTurns.map((turn, tIdx) => {
            const isLastTurn = tIdx === visibleTurns.length - 1;
            const duration = ((turn.endTime - turn.startTime) / 1000).toFixed(1);

            return (
              <Box key={turn.id} flexDirection="column" marginBottom={1}>
                {/* User Message */}
                {turn.userMsg && (
                  <Box flexDirection="column" marginBottom={1}>
                    <Text bold color="green">🙋 {turn.userMsg.content}</Text>
                  </Box>
                )}

                {/* Agent Actions Block */}
                {turn.steps.length > 0 && (
                  <Box flexDirection="column" borderStyle="single" borderColor={isLastTurn && isProcessing ? "magenta" : "gray"} paddingX={1}>
                    
                    {/* Header */}
                    <Box marginBottom={1}>
                      <Text color="gray">
                        {isLastTurn && isProcessing ? (
                           <Text><Text color="magenta"><Spinner type="dots" /></Text> {status}</Text>
                        ) : (
                           <Text>✓ Worked for {duration}s</Text>
                        )}
                      </Text>
                    </Box>
                    {/* Steps (Accordions) */}
                    {turn.steps.map((msg, sIdx) => {
                      // Find if this message is the currently focused item
                      const isFocused = focus === FOCUS_CHAT && focusableItems[clampedSelectedToolIdx]?.msg === msg;
                      const isExpanded = expandedLogIds.has(msg.timestamp || msg._globalIdx);
                      const focusPrefix = isFocused ? <Text color="cyan">❯ </Text> : <Text>  </Text>;

                      if (msg.role === 'assistant' || msg.role === 'agent') {
                        const thinkMatch = msg.content.match(/<think>([\s\S]*?)<\/think>/);
                        let cleanContent = msg.content.replace(/<think>[\s\S]*?<\/think>/, '').trim();
                        const imgMatch = cleanContent.match(/🖼️ Image attached: (.*?\.png|.*?\.jpg|.*?\.jpeg|.*?\.webp)/);

                        return (
                          <Box key={sIdx} flexDirection="column" marginBottom={1}>
                            {thinkMatch && (
                              <Box flexDirection="column">
                                <Text color={isFocused ? 'cyan' : 'gray'}>
                                  {focusPrefix}🤔 Thought (Press Enter to {isExpanded ? 'collapse' : 'expand'})
                                </Text>
                                {isExpanded && (
                                  <Box paddingLeft={4} borderStyle="round" borderColor={isFocused ? 'cyan' : 'gray'}>
                                    <Text dimColor>
                                      {thinkMatch[1].trim().split('\n').slice(0, 15).join('\n')}
                                      {thinkMatch[1].trim().split('\n').length > 15 ? '\n... [Thought Truncated for UI]' : ''}
                                    </Text>
                                  </Box>
                                )}
                              </Box>
                            )}

                            {cleanContent && (
                              <Box paddingLeft={2} marginTop={thinkMatch ? 1 : 0}>
                                {imgMatch ? (
                                  <Box borderStyle="single" borderColor="cyan" paddingX={1}>
                                    <Text>🖼️ Attached: {imgMatch[1]}</Text>
                                  </Box>
                                ) : (
                                  <Text>{marked.parse(cleanContent.replace(/\*\*(.*?)\*\*/g, '\x1b[1m$1\x1b[22m').replace(/^###\s+(.*$)/gm, '\x1b[1;32m$1\x1b[0m')).trim()}</Text>
                                )}
                              </Box>
                            )}
                          </Box>
                        );
                      }

                      if (msg.type === 'tool_call') {
                        return (
                          <Box key={sIdx} flexDirection="column" marginBottom={1}>
                            <Text color={isFocused ? 'cyan' : 'blue'}>
                              {focusPrefix}▶ Executed {msg.toolName} {isExpanded ? '' : JSON.stringify(msg.args || {}).substring(0, 40) + '...'}
                            </Text>
                            {isExpanded && (
                              <Box paddingLeft={4} borderStyle="round" borderColor={isFocused ? 'cyan' : 'gray'}>
                                <Text dimColor>{JSON.stringify(msg.args || {}, null, 2)}</Text>
                              </Box>
                            )}
                          </Box>
                        );
                      }

                      if (msg.type === 'tool_result') {
                        const resultStr = typeof msg.result === 'string' ? msg.result : JSON.stringify(msg.result, null, 2);
                        const lines = resultStr.split('\n');
                        const truncatedStr = lines.length > 20 
                          ? lines.slice(0, 20).join('\n') + '\n\n... [Result Truncated for UI]' 
                          : resultStr;
                        return (
                          <Box key={sIdx} flexDirection="column" marginBottom={1}>
                            <Text color={isFocused ? 'cyan' : 'green'}>
                              {focusPrefix}↙ Result {isExpanded ? '' : (resultStr.substring(0, 40).replace(/\n/g, ' ') + '...')}
                            </Text>
                            {isExpanded && (
                              <Box paddingLeft={4} borderStyle="round" borderColor={isFocused ? 'cyan' : 'gray'}>
                                <Text dimColor>{truncatedStr}</Text>
                              </Box>
                            )}
                          </Box>
                        );
                      }

                      if (msg.role === 'system') {
                        return (
                          <Box key={sIdx} flexDirection="column" marginBottom={1}>
                            <Box paddingLeft={2}>
                              <Text>{marked.parse((msg.content || '').replace(/\*\*(.*?)\*\*/g, '\x1b[1m$1\x1b[22m').replace(/^###\s+(.*$)/gm, '\x1b[1;32m$1\x1b[0m')).trim()}</Text>
                            </Box>
                          </Box>
                        );
                      }

                      return null;
                    })}

                    {/* Artifacts Summary Box */}
                    {isLastTurn && !isProcessing && (artifacts.task || artifacts.walkthrough) && (
                      <Box flexDirection="column" borderStyle="round" borderColor="yellow" padding={1} marginTop={1}>
                        <Text bold color="yellow">📋 Workspace Artifacts Summary</Text>
                        
                        {artifacts.task && (
                          <Box flexDirection="column" marginTop={1}>
                            <Text bold underline color="cyan">task.md</Text>
                            <Text>{marked.parse(artifacts.task.replace(/\*\*(.*?)\*\*/g, '\x1b[1m$1\x1b[22m').replace(/^###\s+(.*$)/gm, '\x1b[1;32m$1\x1b[0m')).trim()}</Text>
                          </Box>
                        )}
                        
                        {artifacts.walkthrough && (
                          <Box flexDirection="column" marginTop={1}>
                            <Text bold underline color="cyan">walkthrough.md</Text>
                            <Text>{marked.parse(artifacts.walkthrough.replace(/\*\*(.*?)\*\*/g, '\x1b[1m$1\x1b[22m').replace(/^###\s+(.*$)/gm, '\x1b[1;32m$1\x1b[0m')).trim()}</Text>
                          </Box>
                        )}
                      </Box>
                    )}
                  </Box>
                )}
              </Box>
            );
          });
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
        <Box borderStyle="single" borderColor="yellow" padding={1} flexDirection="column">
          <Text bold color="yellow">⚠️ Diff Approval Required: {diffRequest.filePath}</Text>
          <Text>Approve this change? (y/n)</Text>
        </Box>
      )}

      {/* Status Spinner */}
      {isProcessing && !diffRequest && (
        <Box marginBottom={1}>
          <Text color="cyan">
            <Spinner type="dots" /> {status}
          </Text>
        </Box>
      )}

      {/* Main Input */}
      {!diffRequest && !terminalOpen && !activeMenu && (
        <Box>
          <Text bold color={focus === FOCUS_INPUT ? 'white' : 'gray'}>🤖 &gt; </Text>
          {focus === FOCUS_INPUT ? (
            <TextInput focus={focus === FOCUS_INPUT} value={input} onChange={setInput} onSubmit={handleSubmit} />
          ) : (
            <Text dimColor>{input || 'Press Tab to focus input...'}</Text>
          )}
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
              setHistory(prev => [...prev, { role: 'user', content: `(I answered): ${item.value}` }]);
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
              { label: 'Allow Command', value: 'accept' },
              { label: 'Reject Command', value: 'reject' }
            ]}
            onSelect={(item) => {
              setActiveMenu(null);
              agentLoop.answerCommandApproval(item.value === 'accept');
              setHistory(prev => [...prev, { role: 'user', content: `(I ${item.value === 'accept' ? 'allowed' : 'rejected'} the command: ${activeMenu.payload.command})` }]);
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
              { label: `⚡ Flash (Fast, minimal reasoning — use with 2.5 Flash)${agentLoop.modelConfig?.modelTier === 'flash' ? '  ← (Current)' : ''}`, value: 'flash' },
              { label: `🧠 Flash Thinking (Moderate reasoning — use with 2.5 Flash Thinking)${agentLoop.modelConfig?.modelTier === 'flash-thinking' ? '  ← (Current)' : ''}`, value: 'flash-thinking' },
              { label: `🔬 Pro (Deep principal-engineer reasoning — use with 2.5 Pro)${agentLoop.modelConfig?.modelTier === 'pro' ? '  ← (Current)' : ''}`, value: 'pro' }
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
      {activeTab === 'agent' && (
        <Box marginTop={1} paddingX={1} flexDirection="column" width="100%">
          <Box flexDirection="row" justifyContent="space-between" width="100%">
            <Text dimColor>[Ctrl+T] Terminal | [Tab] Navigate Logs | [ESC] Focus Input | Context: {history.length}/50</Text>
            <Text color="yellow">{tasks.filter(t => t.status === 'running').length > 0 ? `${tasks.filter(t => t.status === 'running').length} background tasks` : ''}</Text>
          </Box>
          <Box flexDirection="row" justifyContent="space-between" width="100%">
            <Text dimColor>Mode: <Text bold>{agentLoop.topology?.toUpperCase() || 'SINGLE'}</Text> | Model: <Text bold>{agentLoop.modelConfig?.modelTier?.toUpperCase() || 'PRO'}</Text></Text>
            <Text dimColor>Tokens: <Text color={tokenColor}>~{syncTokenEstimate.toLocaleString()} / {tokenLimit.toLocaleString()} ({tokenPct}%)</Text></Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}
