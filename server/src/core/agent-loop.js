/**
 * Agent Loop
 *
 * The core orchestration engine. Handles the full cycle:
 *   User message → Build prompt → Send to Gemini → Parse response →
 *   Execute tool calls → Inject results → Loop until complete → Respond
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import * as paths from './paths.js';
import { z } from 'zod';
import { SessionStore } from '../storage/session-store.js';
import { ContextManager } from '../context/context-manager.js';
import { MemoryManager } from '../context/memory-manager.js';


// Regex to extract tool calls from Gemini's response (handles json code blocks)
const TOOL_CALL_REGEX = /```(?:json|tool_call)?\n\s*(?:json\s*|tool_call\s*)?([{\[][\s\S]*?[}\]])\s*\n```/gi;

export class AgentLoop {
  constructor({ workspace, mcpServer, promptBuilder, diffEngine, riskClassifier, editor, configHome, continueSession = false, agentSourceDir, taskManager, workspaceIndexer }) {
    this.workspace = workspace;
    this.mcpServer = mcpServer;
    this.promptBuilder = promptBuilder;
    this.diffEngine = diffEngine;
    this.riskClassifier = riskClassifier;
    this.editor = editor;
    this.configHome = configHome;
    this.agentSourceDir = agentSourceDir;
    this.taskManager = taskManager;
    this.workspaceIndexer = workspaceIndexer;


    // Storage & Context
    this.sessionStore = new SessionStore(workspace);
    this.memoryManager = new MemoryManager(workspace);
    this.contextManager = new ContextManager(workspace, this.memoryManager);

    if (!continueSession) {
      this.sessionStore.clear(); // Start fresh if --continue not passed
    }

    // State defaults
    this.mode = 'plan'; // 'plan' | 'auto'
    this.topology = 'single'; // 'single' | 'duo' | 'swarm'
    this.modelConfig = {
      main: 'gemini',
      reviewer: 'claude',
      reasoner: 'chatgpt',
      reasoningEffort: 'high',
      modelTier: 'pro'
    };
    
    this.commandRules = {
      enabled: true,
      allow: [],
      block: []
    };
    
    this._loadConfig();
    this.conversationHistory = this.sessionStore.loadHistory();
    this.pendingGeminiResponse = null;
    this.queuedUserMessage = null;
    this.callbacks = null;
    this.isProcessing = false;
    this.extensionQueue = [];
    this.isExtensionBusy = false;
    this.pendingSubagents = new Map(); // Maps requestId -> { resolve, reject }
    this.githubHandler = null; // Set externally after initialization

    // Workspace summary (generated dynamically by context manager)
    // Workspace summary removed to save context window.
  }

  /**
   * Set a persistent background callbacks object so headless/GitHub tasks
   * can always use the extension bridge (injectPrompt) even when no user
   * message is being processed. Called once after the WebSocket server starts.
   */
  setBackgroundCallbacks(callbacks) {
    // Only update if callbacks isn't already set by a live user session
    if (!this.callbacks) {
      this.callbacks = callbacks;
    }
    // Always store as the background fallback
    this._backgroundCallbacks = callbacks;
  }

  /**
   * Handle a user message from the side panel.
   */
  async handleUserMessage(content, callbacks) {
    if (this.isProcessing) {
      callbacks.sendToPanel({
        id: randomUUID(),
        type: 'status',
        payload: { message: '⏳ Agent is busy processing. Please wait...' },
        timestamp: Date.now(),
      });
      return;
    }

    this.callbacks = callbacks;
    this.isProcessing = true;

    // Check Context Size Warning and Auto-Compact
    if (!this.isCompacting && this.contextManager.needsCompaction(this.conversationHistory)) {
      this.callbacks.sendToPanel({
        id: randomUUID(),
        type: 'status',
        payload: { message: '⏳ Context limit reached. Auto-compacting older history in background...' },
        timestamp: Date.now(),
      });
      // Fire and forget, runs in the background
      this._compactHistory().catch(err => {
        console.warn('Auto-compaction failed:', err);
      });
    }

    try {
      // Add user message to history
      const turn = {
        role: 'user',
        content,
        timestamp: Date.now(),
      };
      this.conversationHistory.push(turn);
      this.sessionStore.appendTurn(turn);

      // Workspace summary injection removed

      this.currentObjective = content;

      // Build the full prompt
      const prompt = this.promptBuilder.buildPrompt({
        userMessage: content,
        conversationHistory: this.conversationHistory,
        mode: this.mode,
        topology: this.topology,
        modelConfig: this.modelConfig,
        objective: this.currentObjective,
      });

      // Send to Gemini via Chrome Extension
      await this._sendToGemini(prompt, callbacks);

    } catch (err) {
      console.error(err.stack);
      callbacks.sendToPanel({
        id: randomUUID(),
        type: 'error',
        payload: { message: `Agent error: ${err.stack}` },
        timestamp: Date.now(),
      });
      this.isProcessing = false;
    }
  }

  /**
   * Handle a response from Gemini (via content script).
   */
  async handleGeminiResponse(messageId, payload) {
    const { content, requestId, isSubagent, complete } = payload;

    // Allow subagent responses through even when main agent isn't processing —
    // background GitHub tasks use _executeSubagent without setting isProcessing.
    if (!this.isProcessing && !isSubagent) {
      console.warn('[Agent Loop] Received Gemini response but agent is no longer processing (likely stopped).');
      return;
    }

    if (!this.callbacks && this._backgroundCallbacks) {
      this.callbacks = this._backgroundCallbacks;
    }
    if (!this.callbacks) {
      console.warn('⚠️ Received Gemini response but no callbacks registered');
      return;
    }

    if (isSubagent) {
      if (complete) {
        this.handleSubagentResponse(requestId, content, payload.subagentUrl);
        this.isExtensionBusy = false;
        this._processExtensionQueue();
      }
      return;
    }

    if (!complete) {
      if (payload.timedOut) {
        console.warn('⚠️ Gemini response timed out');
        this.callbacks.sendToPanel({
          id: randomUUID(),
          type: 'agent_response',
          payload: { content: payload.content || '❌ Agent timed out waiting for Gemini response.' },
          timestamp: Date.now(),
        });
        this.isProcessing = false;
        this.isExtensionBusy = false;
        this._processExtensionQueue();
      }
      return;
    }

    // Request complete
    this.isExtensionBusy = false;
    this._processExtensionQueue();

    // (Auto-compaction is now handled silently via background subagents, so the old isCompacting logic is removed from here)

    let toolCalls = [];
    let cleanContent = content;

    try {
      const extracted = this._extractToolCalls(content);
      toolCalls = extracted.toolCalls;
      cleanContent = extracted.cleanContent;
    } catch (err) {
      console.warn('⚠️ JSON Parse Error. Self-correcting...', err.message);
      
      this.callbacks.sendToPanel({
        id: randomUUID(),
        type: 'status',
        payload: { message: '⚠️ Invalid JSON detected. Self-correcting...' },
        timestamp: Date.now(),
      });

      const errorPrompt = `ERROR PARSING TOOL CALLS:\n${err.message}\n\nPlease fix the JSON formatting of your tool calls and output them again. Ensure you close all tags properly and escape newlines in strings.`;
      
      const agentTurn = {
        role: 'agent',
        content: content,
        timestamp: Date.now(),
      };
      
      const systemErrorTurn = {
        role: 'system',
        content: errorPrompt,
        timestamp: Date.now(),
      };
      
      this.conversationHistory.push(agentTurn, systemErrorTurn);
      this.sessionStore.appendTurn(agentTurn);
      this.sessionStore.appendTurn(systemErrorTurn);
      
      this._sendToGemini('Please correct the previous JSON formatting error.', this.callbacks);
      return;
    }

    // Show the response text (without tool call blocks) in the side panel
    if (cleanContent.trim()) {
      const agentTurn = {
        role: 'agent',
        content: cleanContent.trim(),
        timestamp: Date.now(),
      };
      this.conversationHistory.push(agentTurn);
      this.sessionStore.appendTurn(agentTurn);

      this.callbacks.sendToPanel({
        id: randomUUID(),
        type: 'agent_response',
        payload: { content: cleanContent.trim() },
        timestamp: Date.now(),
      });
    }

    // Execute tool calls
    if (toolCalls.length > 0) {
      await this._executeToolCalls(toolCalls);
    } else {
      // No tool calls — agent is done
      this.isProcessing = false;
      // Restore background callbacks so GitHub tasks still work
      if (this._backgroundCallbacks) {
        this.callbacks = this._backgroundCallbacks;
      }
    }
  }

  /**
   * Handle a response from a subagent (e.g. ChatGPT/Claude).
   */
  handleSubagentResponse(requestId, content, url) {
    if (this.pendingSubagents.has(requestId)) {
      const { resolve } = this.pendingSubagents.get(requestId);
      this.pendingSubagents.delete(requestId);
      resolve({ success: true, result: content, url });
    } else {
      console.warn(`⚠️ Received subagent response for unknown requestId: ${requestId}`);
    }
  }

  /**
   * Handle a diff approval/rejection from the side panel.
   */
  handleDiffResponse(messageId, payload) {
    const { diffId, action, hunkId } = payload;

    try {
      let result;
      if (hunkId) {
        result = this.diffEngine.respondToHunk(diffId, hunkId, action === 'accept');
      } else if (action === 'accept') {
        result = this.diffEngine.acceptDiff(diffId);
      } else {
        result = this.diffEngine.rejectDiff(diffId);
      }

      if (this.callbacks) {
        this.callbacks.sendToPanel({
          id: randomUUID(),
          type: 'diff_result',
          payload: result,
          timestamp: Date.now(),
        });
      }

      // Unblock _executeToolCalls, which is awaiting the user's decision.
      if (this.pendingDiffResolve) {
        this.pendingDiffResolve({ action, result });
        this.pendingDiffResolve = null;
      }
    } catch (err) {
      if (this.callbacks) {
        this.callbacks.sendToPanel({
          id: randomUUID(),
          type: 'error',
          payload: { message: `Diff error: ${err.message}` },
          timestamp: Date.now(),
        });
      }

      if (this.pendingDiffResolve) {
        this.pendingDiffResolve({ action: 'reject', error: err.message });
        this.pendingDiffResolve = null;
      }
    }
  }

  /**
   * Handle slash commands.
   */
  async handleSlashCommand(command, args) {
    switch (command) {
      case 'plan':
        this.mode = 'plan';
        return { message: '🔒 Switched to Plan Mode. All edits require approval.' };

      case 'auto':
        this.mode = 'auto';
        return { message: '⚡ Switched to Auto Mode. Safe edits will be auto-applied.' };

      case 'memory':
        if (args?.[0]) {
          const action = args[0].toLowerCase();
          if (action === 'on') {
            this.memoryManager.memoryEnabled = true;
            return { message: '🧠 Long-Term Memory is now ON.' };
          } else if (action === 'off') {
            this.memoryManager.memoryEnabled = false;
            return { message: '🧠 Long-Term Memory is now OFF.' };
          }
        }
        const state = this.memoryManager.toggleMemory();
        return { message: `🧠 Long-Term Memory is now ${state ? 'ON' : 'OFF'}.` };

      case 'mode':
        if (args?.[0]) {
          const newTopology = args[0].toLowerCase();
          if (['single', 'duo', 'swarm'].includes(newTopology)) {
            this.topology = newTopology;
            this._saveConfig();
            this.promptBuilder.resetPromptState();
            return { message: `🌐 Switched to Agent Topology: ${newTopology.toUpperCase()}` };
          }
          return { message: `❌ Invalid mode. Use: single, duo, or swarm.` };
        }
        return { message: `Current Agent Topology: ${this.topology}` };

      case 'config':
        if (args?.length === 2) {
          const role = args[0].toLowerCase();
          const model = args[1].toLowerCase();
          if (['main', 'reviewer', 'reasoner'].includes(role) && ['gemini', 'chatgpt', 'claude'].includes(model)) {
            this.modelConfig[role] = model;
            this._saveConfig();
            this.promptBuilder.resetPromptState();
            return { message: `✅ Assigned ${model} to ${role} role.` };
          }
          return { message: `❌ Invalid args. Usage: /config <role> <model>\nRoles: main, reviewer, reasoner\nModels: gemini, chatgpt, claude` };
        }
        
        // No args given -> format the current config string cleanly
        const configStr = Object.entries(this.modelConfig)
          .map(([r, m]) => `  ${r.charAt(0).toUpperCase() + r.slice(1)} Agent: ${m}`)
          .join('\n');
        return { message: `Current Agent Topology: ${this.topology.toUpperCase()}\nCurrent Model Config:\n${configStr}` };

      case 'clear':
        this.conversationHistory = [];
        this.sessionStore.clear();
        this.promptBuilder.resetPromptState();
        return { message: '🧹 Conversation history cleared.' };

      case 'context':
        return await this._getContextInfo();

      case 'compact': {
        const focus = args?.join(' ') || '';
        return await this._compactHistory(focus);
      }

      case 'undo': {
        const result = this.diffEngine.undo();
        return result;
      }

      case 'agent-dir': {
        const newWorkspace = this.agentSourceDir || this.workspace;
        this.workspace = newWorkspace;
        
        if (this.mcpServer) this.mcpServer.workspace = newWorkspace;
        if (this.promptBuilder) this.promptBuilder.workspace = newWorkspace;
        if (this.diffEngine) this.diffEngine.workspace = newWorkspace;
        if (this.contextManager) {
          this.contextManager.workspacePath = newWorkspace;
          this.contextManager.summarizer.workspacePath = newWorkspace;
        }
        // this.workspaceSummary removed
        return { message: `📂 Workspace changed to agent source: ${this.workspace}` };
      }

      case 'workspace':
        if (args?.[0]) {
          const newWorkspace = args[0];
          this.workspace = newWorkspace;
          
          // Update all child components with the new workspace path
          if (this.mcpServer) this.mcpServer.workspace = newWorkspace;
          if (this.promptBuilder) this.promptBuilder.workspace = newWorkspace;
          if (this.diffEngine) this.diffEngine.workspace = newWorkspace;
          
          // Note: SessionStore and ContextManager currently base off workspace in constructor,
          // so we should update them too.
          if (this.contextManager) {
            this.contextManager.workspacePath = newWorkspace;
            this.contextManager.summarizer.workspacePath = newWorkspace;
          }
          // We don't change SessionStore to avoid saving current history into another project's session.
          // In a full implementation, we might reload the history from the new project.
          
           this.workspaceSummary = ''; // Clear stale summary so it regenerates

          return { message: `📂 Workspace changed to: ${this.workspace}` };
        }
        return { message: `📂 Current workspace: ${this.workspace}` };

      case 'model': {
        const tiers = {
          'flash': { modelTier: 'flash', reasoningEffort: 'low', label: '⚡ Flash (Fast)', browserHint: 'Gemini Flash' },
          'flash-thinking': { modelTier: 'flash-thinking', reasoningEffort: 'medium', label: '🧠 Flash Thinking', browserHint: 'Gemini Flash (Thinking)' },
          'pro': { modelTier: 'pro', reasoningEffort: 'high', label: '🔬 Pro (Deep Reasoning)', browserHint: 'Gemini Pro' },
        };
        const tierKey = args?.[0]?.toLowerCase();
        if (tierKey && tiers[tierKey]) {
          const tier = tiers[tierKey];
          this.modelConfig.modelTier = tier.modelTier;
          this.modelConfig.reasoningEffort = tier.reasoningEffort;
          this._saveConfig();
          this.promptBuilder.resetPromptState();
          return { message: `${tier.label}\n\n📌 Prompt profile switched to **${tier.modelTier.toUpperCase()}**.\n💡 Make sure your Gemini browser tab is set to **${tier.browserHint}** for best results.` };
        }
        const current = this.modelConfig.modelTier || 'pro';
        return { message: `🤖 Current model tier: **${current.toUpperCase()}**\n\nAvailable tiers:\n  ⚡ \`/model flash\` — Ultra-fast, minimal reasoning (use with Flash)\n  🧠 \`/model flash-thinking\` — Moderate reasoning (use with Flash Thinking)\n  🔬 \`/model pro\` — Full principal-engineer protocol (use with Pro)` };
      }

      case 'allowlist': {
        if (args?.[0] === 'clear') {
          this.commandRules.allow = [];
          this.commandRules.block = [];
          this._saveConfig();
          return { message: '✅ Command allowlist and blocklist cleared.' };
        } else if (args?.[0] === 'remove' && args[1]) {
          const cmdToRemove = args.slice(1).join(' ');
          this.commandRules.allow = this.commandRules.allow.filter(c => c !== cmdToRemove);
          this.commandRules.block = this.commandRules.block.filter(c => c !== cmdToRemove);
          this._saveConfig();
          return { message: `✅ Removed \`${cmdToRemove}\` from rules.` };
        } else if (args?.[0] === 'enable') {
          this.commandRules.enabled = true;
          this._saveConfig();
          return { message: '✅ Command allowlist is now **enabled**.' };
        } else if (args?.[0] === 'disable') {
          this.commandRules.enabled = false;
          this._saveConfig();
          return { message: '⛔ Command allowlist is now **disabled**. All commands will prompt for approval.' };
        }
        let msg = `🛡️ **Command Rules** (Status: ${this.commandRules.enabled !== false ? '✅ Enabled' : '⛔ Disabled'})\n\n`;
        msg += '**Allowed Commands:**\n';
        msg += this.commandRules.allow.length > 0 ? this.commandRules.allow.map(cmd => `  - \`${cmd}\``).join('\n') : '  *(None)*';
        msg += '\n\n**Blocked Commands:**\n';
        msg += this.commandRules.block.length > 0 ? this.commandRules.block.map(cmd => `  - \`${cmd}\``).join('\n') : '  *(None)*';
        msg += '\n\n**Commands:**\n  `/allowlist enable` or `/allowlist disable`\n  `/allowlist remove <command>`\n  `/allowlist clear`';
        return { message: msg };
      }

      case 'github': {
        if (!this.githubHandler) {
          return { message: '⚠️ GitHub Agent not initialized. Set GITHUB_TOKEN env var and restart.' };
        }

        const subCommand = args?.[0]?.toLowerCase();

        switch (subCommand) {
          case 'plans': {
            const plans = this.githubHandler.listPlans();
            if (plans.length === 0) {
              return { message: '📋 No plan files generated yet. Waiting for PR comments...' };
            }
            const planList = plans.map(p =>
              `  📄 ${p.fileName} (modified: ${p.lastModified.toLocaleString()})`
            ).join('\n');
            return { message: `📋 Generated Plans (${plans.length}):\n${planList}` };
          }

          case 'refresh': {
            this.githubHandler.refresh().catch(err => {
              console.error(`[GitHub] Refresh error: ${err.message}`);
            });
            return { message: '🔄 Forcing immediate GitHub poll...' };
          }

          case 'ci-watch': {
            const toggle = args?.[1]?.toLowerCase();
            if (toggle === 'on') {
              this.githubHandler.setCIWatch(true);
              return { message: '✅ CI failure watching enabled.' };
            } else if (toggle === 'off') {
              this.githubHandler.setCIWatch(false);
              return { message: '⛔ CI failure watching disabled. Only comments will be tracked.' };
            }
            const ciStatus = this.githubHandler.config.enableCIWatch;
            return { message: `🔧 CI Watch is currently: **${ciStatus ? 'ON' : 'OFF'}**\nUsage: \`/github ci-watch <on|off>\`` };
          }

          case 'clear-state': {
            const stateFile = paths.githubStatePath(this.workspace);
            if (fs.existsSync(stateFile)) {
              fs.unlinkSync(stateFile);
            }
            if (this.githubHandler && this.githubHandler.poller) {
               this.githubHandler.poller.state = { commentWatermarks: {}, seenCIRuns: {} };
               this.githubHandler.refresh();
            }
            return { message: '🗑️ GitHub Poller state cleared! Rescanning...' };
          }

          case 'remove-token': {
            delete process.env.GITHUB_TOKEN;
            this.modelConfig.githubToken = '';
            this._saveConfig();
            if (this.githubHandler) {
              this.githubHandler.stop();
              this.githubHandler = null;
            }
            return { message: '🗑️ GitHub Token removed. Integration disabled.' };
          }

          case 'stats': {
            if (!this.githubHandler) {
              return { message: 'GitHub integration is currently disabled. Please setup your token first.' };
            }
            // Show status
            const status = this.githubHandler.getStatus();
            const statusLines = [
              `📊 GitHub Agent Status:`,
              `  PRs Watched: ${status.prsWatched}`,
              `  Total Polls: ${status.totalPolls}`,
              `  Comments Processed: ${status.totalCommentsProcessed}`,
              `  CI Failures Processed: ${status.totalCIFailuresProcessed}`,
              `  Plans Generated: ${status.totalPlansGenerated}`,
              `  CI Watch: ${status.ciWatchEnabled ? '✅ ON' : '⛔ OFF'}`,
              `  Poll Interval: ${status.pollInterval}`,
              `  Last Poll: ${status.lastPollTime || 'Never'}`,
              `  Plan Directory: ${status.planDir}`,
              ``,
              `  Commands: /github plans | /github refresh | /github ci-watch <on|off> | /github clear-state | /github remove-token | /github stats`,
            ];
            return { message: statusLines.join('\n') };
          }
          default: {
            if (!subCommand) {
              return { message: 'Usage: /github <plans|refresh|ci-watch|clear-state|remove-token|stats>' };
            }
            return { message: `❌ Unknown github command: '${subCommand}'\nUsage: /github <plans|refresh|ci-watch|clear-state|remove-token|stats>` };
          }
        }
      }

      default:
        return { message: `Unknown command: /${command}. Available: /plan, /auto, /clear, /context, /compact, /undo, /workspace, /agent-dir, /model, /allowlist, /github` };
    }
  }

  // ── Private Methods ──────────────────────────────────────────────

  answerQuestion(answer) {
    if (this.pendingQuestionResolve) {
      this.pendingQuestionResolve({ success: true, result: `User answered: ${answer}` });
      this.pendingQuestionResolve = null;
    }
  }

  answerCommandApproval(action, command) {
    if (this.pendingCommandResolve) {
      if (action === 'allow_always') {
        this.commandRules.allow.push(command);
        this._saveConfig();
        this.pendingCommandResolve({ approved: true });
      } else if (action === 'reject_always') {
        this.commandRules.block.push(command);
        this._saveConfig();
        this.pendingCommandResolve({ approved: false });
      } else {
        this.pendingCommandResolve({ approved: action === 'allow_once' || action === 'accept' });
      }
      this.pendingCommandResolve = null;
    }
  }

  _loadConfig() {
    const configPath = paths.configPath(this.workspace);
    if (fs.existsSync(configPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (data.topology) this.topology = data.topology;
        if (data.modelConfig) this.modelConfig = { ...this.modelConfig, ...data.modelConfig };
        if (data.commandRules) this.commandRules = { ...this.commandRules, ...data.commandRules };
        if (Array.isArray(data.contextFolders)) this.contextFolders = data.contextFolders;
      } catch (err) {
        console.warn(`⚠️ Failed to load ${paths.AGENT_DIR}/config.json:`, err.message);
      }
    }
  }

  _saveConfig() {
    const configPath = paths.ensureParent(paths.configPath(this.workspace));
    try {
      fs.writeFileSync(configPath, JSON.stringify({
        topology: this.topology,
        modelConfig: this.modelConfig,
        commandRules: this.commandRules,
        contextFolders: this.contextFolders
      }, null, 2));
    } catch (err) {
      console.warn('⚠️ Failed to save config:', err.message);
    }
  }


  _enqueueExtensionRequest(payload) {
    this.extensionQueue.push(payload);
    this._processExtensionQueue();
  }

  _processExtensionQueue() {
    if (this.isExtensionBusy || this.extensionQueue.length === 0) return;
    this.isExtensionBusy = true;
    const payload = this.extensionQueue.shift();
    if (this.callbacks && this.callbacks.injectPrompt) {
      this.callbacks.injectPrompt(payload);
    }
  }

  async _sendToGemini(prompt, callbacks) {
    // Create a promise that will be resolved when we get the Gemini response
    this.pendingGeminiResponse = true;

    this._enqueueExtensionRequest({
      prompt,
      expectResponse: true,
      targetModel: this.modelConfig.main || 'gemini',
    });

    // Notify side panel that we're waiting for Gemini
    callbacks.sendToPanel({
      id: randomUUID(),
      type: 'status',
      payload: { message: '🤔 Thinking...', status: 'waiting_for_gemini' },
      timestamp: Date.now(),
    });
  }

  async _executeToolCalls(toolCalls) {
    const toolResults = new Array(toolCalls.length);
    const executionPromises = [];

    for (let i = 0; i < toolCalls.length; i++) {
      const call = toolCalls[i];
      const isParallel = ['ask_researcher', 'ask_reviewer', 'ask_reasoner', 'ask_subagent'].includes(call.name);

      const executePromise = (async () => {
        // Notify side panel about tool call
        this.callbacks.sendToPanel({
        id: randomUUID(),
        type: 'tool_call',
        payload: {
          name: call.name,
          args: call.args,
        },
        timestamp: Date.now(),
      });

      // Check risk classification for auto mode
      const risk = this.riskClassifier.classify(call.name, call.args);
      let needsApproval = false;
      
      if (this.mode === 'plan') {
        if (call.name === 'edit_file' || call.name === 'create_file' || call.name === 'run_command') {
          needsApproval = true;
          // Exception: Creating/Editing Markdown files (like plans) is harmless and shouldn't block
          if ((call.name === 'create_file' || call.name === 'edit_file') && call.args.path && call.args.path.endsWith('.md')) {
            needsApproval = false;
          }
          // Exception: Safe, read-only commands should not block
          if (call.name === 'run_command' && risk.level === 'safe') {
            needsApproval = false;
          }
        }
      } else {
        needsApproval = risk.level === 'risky';
      }

      // Execute the tool
      let result;
      
      if (call.name === 'run_command' && risk.level === 'critical') {
        result = { success: false, error: `❌ Command blocked by Security Constraints: ${risk.reason}` };
      } else if (call.name === 'run_command') {
        const commandToRun = call.args.command;
        let isApproved = false;

        const rulesEnabled = this.commandRules.enabled !== false;

        if (rulesEnabled && this.commandRules.block.includes(commandToRun)) {
          result = { success: false, error: `❌ Command blocked by user blocklist. Do NOT try this command again. If it is essential, ask the user to remove it from the deny list, or try an alternative approach.` };
          isApproved = false;
        } else if (rulesEnabled && this.commandRules.allow.includes(commandToRun)) {
          isApproved = true;
        } else if (needsApproval) {
          // Pause and request user approval for risky commands
          const approval = await new Promise((resolve) => {
            this.pendingCommandResolve = resolve;
            this.callbacks.sendToPanel({
              id: randomUUID(),
              type: 'request_command_approval',
              payload: { 
                command: commandToRun,
                cwd: call.args.cwd || this.workspace,
                riskLevel: risk.level,
                riskReason: risk.reason
              },
              timestamp: Date.now(),
            });
          });
          isApproved = approval.approved;
        } else {
          // Safe commands in auto mode
          isApproved = true;
        }
        
        if (isApproved) {
          result = await this.mcpServer.executeTool(call.name, call.args, {
            editor: this.editor,
            taskManager: this.taskManager,
            workspaceIndexer: this.workspaceIndexer,
          });
        } else {
          result = result || { success: false, error: 'User rejected command execution.' };
        }
      } else if (call.name === 'ask_question') {
        result = await new Promise((resolve) => {
          this.pendingQuestionResolve = resolve;
          this.callbacks.sendToPanel({
            id: randomUUID(),
            type: 'ask_question',
            payload: { question: call.args.question, options: call.args.options },
            timestamp: Date.now(),
          });
        });
      } else if (call.name === 'ask_reviewer' || call.name === 'ask_reasoner' || call.name === 'ask_researcher' || call.name === 'ask_subagent') {
        const role = call.name.split('_')[1];
        const targetModel = this.modelConfig[role] || 'gemini'; // default to gemini for subagents if not set
        
        result = await this._runSubAgentSession(role, call.args.prompt || call.args.query, targetModel);
      } else if (call.name === 'manage_memory') {
        if (call.args.action === 'add') {
          const success = this.memoryManager.addMemory(call.args.fact);
          result = { result: success ? `Added memory: ${call.args.fact}` : `Failed to add memory or memory is disabled.` };
        } else if (call.args.action === 'remove') {
          const success = this.memoryManager.removeMemory(call.args.index);
          result = { result: success ? `Removed memory at index ${call.args.index}` : `Failed to remove memory (invalid index or disabled).` };
        } else {
          result = { error: 'Invalid action. Use "add" or "remove".' };
        }
      } else {
        result = await this.mcpServer.executeTool(call.name, call.args, {
          editor: this.editor,
          taskManager: this.taskManager,
          workspaceIndexer: this.workspaceIndexer,
        });
      }

      // Add to conversation history
      const truncatedResult = typeof result.result === 'string' && result.result.length > 50000
        ? result.result.substring(0, 50000) + '\n\n...[Output Truncated]...'
        : result.result || result.error;

      toolResults[i] = {
        call_id: call.id || randomUUID(),
        name: call.name,
        result: truncatedResult,
      };

      const callTurn = {
        role: 'system',
        type: 'tool_call',
        toolName: call.name,
        args: call.args,
        timestamp: Date.now(),
      };
      this.conversationHistory.push(callTurn);
      this.sessionStore.appendTurn(callTurn);

      const resultTurn = {
        role: 'system',
        type: 'tool_result',
        toolName: call.name,
        result: truncatedResult,
        success: result.success,
        timestamp: Date.now(),
      };
      this.conversationHistory.push(resultTurn);
      this.sessionStore.appendTurn(resultTurn);

      // Send tool result to side panel
      this.callbacks.sendToPanel({
        id: randomUUID(),
        type: 'tool_result',
        payload: {
          name: call.name,
          success: result.success,
          result: result.result,
          error: result.error,
        },
        timestamp: Date.now(),
      });

      // If it's an edit/create tool, handle diff approval
      if (result.success && (call.name === 'edit_file' || call.name === 'create_file')) {
        const diffResult = result.result;

        if (!needsApproval) {
          // Auto-apply safe edits
          const applyResult = this.diffEngine.acceptDiff(diffResult.diffId);
          this.callbacks.sendToPanel({
            id: randomUUID(),
            type: 'diff_auto_applied',
            payload: {
              diffId: diffResult.diffId,
              filePath: diffResult.filePath,
              message: `✅ Auto-applied: ${diffResult.filePath}`,
            },
            timestamp: Date.now(),
          });
        } else {
          // Request approval and WAIT. Without this the loop used to hand Gemini a
          // "waiting for approval" result and immediately continue, so the model
          // replied as if the edit were already under review while the prompt was
          // still on screen — and the user's answer went to chat, not the diff.
          const decision = typeof this.callbacks?.requestDiffApproval !== 'function'
            ? { action: 'reject' } // no UI wired: never block forever
            : await new Promise((resolve) => {
            this.pendingDiffResolve = resolve;
            this.callbacks.requestDiffApproval({
              diffId: diffResult.diffId,
              filePath: diffResult.filePath,
              patch: diffResult.patch,
              hunks: diffResult.hunks,
              riskLevel: risk.level,
              riskReason: risk.reason,
            });
          });

          const outcome = decision.action === 'accept'
            ? { success: true, result: `✅ User APPROVED the edit. ${diffResult.filePath} has been written to disk.` }
            : { success: false, error: `User REJECTED the edit to ${diffResult.filePath}. Do not retry the same edit — ask what they want changed.` };

          // Replace the "pending approval" payload so the model is told what
          // actually happened, and is not fed the whole patch back.
          toolResults[i] = { name: call.name, result: outcome.result || outcome.error };
        }
      }
      })();

      if (isParallel) {
        executionPromises.push(executePromise);
      } else {
        await executePromise;
      }
    }
    await Promise.all(executionPromises);

    // Send tool results back to Gemini for continuation
    const resultPrompts = toolResults.map(tr =>
      this.promptBuilder.buildToolResultPrompt(tr.name, tr.result)
    );

    this._sendToGemini(resultPrompts.join('\n\n'), this.callbacks);
  }

  _extractToolCalls(content) {
    const calls = [];
    let cleanContent = content;
    const toolSchema = z.object({
      name: z.string().min(1),
      args: z.record(z.any()).default({})
    });

    // First try the standard markdown regex for speed and to remove backticks cleanly
    const TOOL_CALL_REGEX = /```(?:json|tool_call)?\n\s*(?:json\s*|tool_call\s*)?([{\[][\s\S]*?[}\]])\s*\n```/gi;
    cleanContent = cleanContent.replace(TOOL_CALL_REGEX, (fullMatch, jsonGroup) => {
      let parsed;
      try {
        const cleaned = this._cleanJsonString(jsonGroup.trim());
        parsed = JSON.parse(cleaned);
      } catch (err) {
        throw new Error(`Failed to parse JSON block: ${err.message}\nRaw block: ${jsonGroup}`);
      }

      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (item.name) {
          const validated = toolSchema.safeParse(item);
          if (!validated.success) {
            throw new Error(`Schema validation failed: ${validated.error.message}\nItem: ${JSON.stringify(item)}`);
          }
          calls.push(validated.data);
        }
      }
      return '';
    });

    // Fallback: Robust brace-matching to find any JSON object hidden in the text
    // This handles missing backticks, weird UI wrappers, or malformed markdown
    let startIndex = 0;
    while ((startIndex = cleanContent.indexOf('{', startIndex)) !== -1) {
      let openBraces = 0;
      let endIndex = -1;
      let inString = false;
      let escapeNext = false;
      
      for (let i = startIndex; i < cleanContent.length; i++) {
        const char = cleanContent[i];
        if (escapeNext) { escapeNext = false; continue; }
        if (char === '\\') { escapeNext = true; continue; }
        if (char === '"') { inString = !inString; continue; }
        if (!inString) {
          if (char === '{') openBraces++;
          if (char === '}') openBraces--;
          if (openBraces === 0) { endIndex = i; break; }
        }
      }
      
      if (endIndex !== -1) {
        const jsonStr = cleanContent.substring(startIndex, endIndex + 1);
        try {
          const cleaned = this._cleanJsonString(jsonStr);
          const parsed = JSON.parse(cleaned);
          if (parsed.name && parsed.args) {
            calls.push(parsed);
            cleanContent = cleanContent.substring(0, startIndex) + cleanContent.substring(endIndex + 1);
            continue; // startIndex is now at the character after the removed JSON
          }
        } catch (e) {}
      }
      startIndex++;
    }

    // Clean up any dangling "JSON" or "tool_call" text that Gemini might have left behind
    cleanContent = cleanContent.replace(/(?:^|\n)(?:JSON|tool_call)\s*(?:\n|$)/gi, '\n');

    return { toolCalls: calls, cleanContent: cleanContent.trim() };
  }

  _cleanJsonString(str) {
    // LLMs often emit raw newlines inside JSON string literals which breaks JSON.parse
    return str.replace(/"(.*?)"/gs, (match) => match.replace(/\n/g, '\\n'));
  }

  async _executeSubagent(targetModel, prompt) {
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      this.pendingSubagents.set(requestId, { resolve, reject });

      this.callbacks.sendToPanel({
        id: randomUUID(),
        type: 'status',
        payload: { message: `🤖 [${targetModel}] Thinking...`, status: `waiting_for_${targetModel}` },
        timestamp: Date.now(),
      });

      this._enqueueExtensionRequest({
        prompt,
        expectResponse: true,
        targetModel,
        requestId,
        isSubagent: true,
      });
      
      // Safety timeout (5 minutes)
      setTimeout(() => {
        if (this.pendingSubagents.has(requestId)) {
          this.pendingSubagents.delete(requestId);
          this.isExtensionBusy = false;
          this._processExtensionQueue();
          resolve({ success: false, error: `${targetModel} timeout after 5 minutes.` });
        }
      }, 300000);
    });
  }

  async _runSubAgentSession(role, prompt, targetModel) {
    const wrapper = this.promptBuilder.buildSubagentWrapper(role);
    const baseSystem = `${wrapper}\nYou also have access to read-only tools to explore the codebase if needed.
Workspace root path: ${this.workspace}

## TOOLS AVAILABLE:
- grep_search({ "pattern": "string", "isRegex": false, "includes": ["*.js"] })
- read_file({ "path": "path/to/file", "startLine": 1, "endLine": 50 })
- list_directory({ "path": "." })
- search_files({ "query": "filename" })
- return_result({ "result": "your final markdown output" })

## TOOL CALL FORMAT (exact format required):
\`\`\`json
{"name": "tool_name", "args": {"key": "value"}}
\`\`\`
RULES: Make up to 5 tool calls before calling return_result with your final answer.`;

    const localHistory = [
      { role: 'system', content: baseSystem },
      { role: 'user', content: prompt }
    ];

    let lastCleanContent = '';

    for (let turn = 0; turn < 6; turn++) {
      const serializedPrompt = localHistory.map(t => {
        if (t.role === 'system') return `[System Context/Tool Results]\n${t.content}`;
        if (t.role === 'user') return `[User Task]\n${t.content}`;
        if (t.role === 'agent') return `[Your Previous Output]\n${t.content}`;
        return t.content;
      }).join('\n\n');
      const response = await this._executeSubagent(targetModel, serializedPrompt);
      if (!response.success) return { success: false, error: response.error };

      if (response.url) {
        this.callbacks.sendToPanel({
          id: randomUUID(),
          type: 'status',
          payload: { message: `🔗 [${role}] Subagent background tab: ${response.url}` },
          timestamp: Date.now(),
        });
      }

      const content = response.result || response.content;
      localHistory.push({ role: 'agent', content });

      let toolCalls = [];
      let cleanContent = content;
      try {
        const extracted = this._extractToolCalls(content);
        toolCalls = extracted.toolCalls;
        cleanContent = extracted.cleanContent;
      } catch (err) {
        localHistory.push({ role: 'system', content: `JSON Parse Error: ${err.message}` });
        continue;
      }

      if (cleanContent.trim()) lastCleanContent = cleanContent.trim();
      
      if (toolCalls.length === 0) break; // Finished

      const toolResults = [];
      let returned = false;
      for (const call of toolCalls) {
        if (call.name === 'return_result') {
          return { success: true, result: call.args.result };
        }
        
        let result;
        if (!['grep_search', 'read_file', 'list_directory', 'search_files'].includes(call.name)) {
          result = { success: false, error: `Tool ${call.name} not permitted for subagents.` };
        } else {
          result = await this.mcpServer.executeTool(call.name, call.args, {
            editor: this.editor, taskManager: this.taskManager, workspaceIndexer: this.workspaceIndexer,
          });
        }
        toolResults.push({ name: call.name, result: result.result || result.error });
      }
      localHistory.push({ role: 'system', content: `Tool Results:\n${JSON.stringify(toolResults, null, 2)}` });
    }
    
    return { success: false, error: "Subagent failed to use the return_result tool. Raw output: " + (lastCleanContent || "No output provided.") };
  }

  async runHeadlessTask(prompt, systemInstruction = null) {
    const localHistory = [];

    const baseSystem = `You are a headless background agent running inside the user's code workspace.
You have access to a local MCP tool server. You MUST use tools to explore the codebase before drawing conclusions.

## TOOLS AVAILABLE (use these exact names and argument keys):

- grep_search({ "pattern": "string", "isRegex": false, "includes": ["*.js"] })
  → Search for text/patterns across all files. Use "pattern" NOT "query".

- read_file({ "path": "relative/or/absolute/path", "startLine": 1, "endLine": 50 })
  → Read a file, optionally a line range.

- list_directory({ "path": "." })
  → List directory contents.

- search_files({ "query": "filename or path fragment" })
  → Find files by name.

- ask_subagent({ "prompt": "string" })
  → Spawn a parallel background agent to research a sub-topic for you.

## TOOL CALL FORMAT (exact format required):
<tool_call>
{"name": "grep_search", "args": {"pattern": "your search term"}}
</tool_call>

## RULES:
1. Make UP TO 5 tool calls to understand the codebase before writing your plan.
2. After gathering context, produce ONE consolidated final plan in markdown.
3. Do NOT produce partial plans between tool calls — wait until the end.
4. Do NOT repeat tool calls you already made.
5. You can spawn multiple subagents at once by making multiple tool calls.
6. When done, output ONLY the final plan. Do not include any tool call blocks in the final turn.`;

    const finalSystem = systemInstruction ? `${baseSystem}\n\n## ADDITIONAL DIRECTIVE:\n${systemInstruction}` : baseSystem;

    localHistory.push({ role: 'system', content: finalSystem });
    localHistory.push({ role: 'user', content: prompt });

    let lastCleanContent = '';
    let turnCount = 0;

    for (let turn = 0; turn < 10; turn++) {
      turnCount = turn + 1;
      const serializedPrompt = localHistory.map(t => `${t.role.toUpperCase()}:\n${t.content}`).join('\n\n') + '\n\nAGENT:\n';

      const response = await this._executeSubagent('gemini', serializedPrompt);
      if (!response.success) {
        return { success: false, error: response.error };
      }

      const content = response.result || response.content;
      localHistory.push({ role: 'agent', content });

      let toolCalls = [];
      let cleanContent = content;

      try {
        const extracted = this._extractToolCalls(content);
        toolCalls = extracted.toolCalls;
        cleanContent = extracted.cleanContent;
      } catch (err) {
        localHistory.push({ role: 'system', content: `JSON Parse Error: ${err.message}. Fix your tool call format.` });
        continue;
      }

      // Track the last non-empty clean content as the candidate final plan
      if (cleanContent.trim()) {
        lastCleanContent = cleanContent.trim();
      }

      if (toolCalls.length === 0) {
        // No more tool calls — this is the final plan turn
        break;
      }

      const toolPromises = toolCalls.map(async (call) => {
        let result;
        
        if (call.name === 'ask_subagent') {
          // Provide workspace context and strictly enforce Gemini model for subagent swarming
          const subPrompt = call.args.prompt;
          const contextMsg = `[System: You are running in workspace root: ${this.workspace}. Use tools to explore.]`;
          const sessionResult = await this._runSubAgentSession('subagent', `${contextMsg}\n\nUser Prompt: ${subPrompt}`, 'gemini');
          result = sessionResult;
        } else {
          const risk = this.riskClassifier.classify(call.name, call.args);

          if (call.name === 'run_command' && risk.level !== 'safe') {
            result = { success: false, error: `Command blocked in background agent for security: ${risk.reason}` };
          } else {
            try {
              result = await this.mcpServer.executeTool(call.name, call.args, {
                editor: this.editor,
                taskManager: this.taskManager,
                workspaceIndexer: this.workspaceIndexer,
              });
            } catch (e) {
              result = { success: false, error: e.message };
            }
          }
        }
        
        return { call_id: call.id || randomUUID(), name: call.name, result };
      });

      const toolResults = await Promise.all(toolPromises);
      localHistory.push({ role: 'tool', content: JSON.stringify(toolResults, null, 2) });
    }

    // Return only the final consolidated plan (last clean output)
    const finalOutput = lastCleanContent || '(No plan generated)';
    return { success: true, result: `## 🧠 AI Context Analysis\n\n${finalOutput}`, turns: turnCount };
  }

  async _getContextInfo() {
    const historyTokenEstimate = this.contextManager 
      ? import('../context/token-counter.js').then(m => m.TokenCounter.estimateHistoryTokens(this.conversationHistory)) 
      : 0; // Token counting is now offloaded, but we can do a rough fallback:
    
    // For synchronous stats, we'll just require TokenCounter directly since it's ES module, 
    // wait I didn't import TokenCounter at the top. I'll just use the old fallback for synchronous display.
    const syncTokenEstimate = this.conversationHistory.reduce((sum, turn) => {
      const text = turn.content || JSON.stringify(turn.result || turn.args || '');
      return sum + Math.ceil(text.length / 4);
    }, 0);

    const chalk = (await import('chalk')).default;
    
    const tokenLimit = 50000;
    const tokenPct = Math.round((syncTokenEstimate / tokenLimit) * 100);
    const tokenColor = tokenPct > 80 ? chalk.red : tokenPct > 50 ? chalk.yellow : chalk.green;
    
    const message = [
      chalk.dim('╭─ ') + chalk.bold('Context Overview') + chalk.dim(' ─────────────────────────────────────╮'),
      chalk.dim('│') + ' Mode:            ' + (this.mode === 'plan' ? chalk.cyan('Plan Mode 🔒') : chalk.magenta('Auto Mode ⚡')) + ' '.repeat(this.mode === 'plan' ? 16 : 16) + chalk.dim('│'),
      chalk.dim('│') + ' Workspace:       ' + chalk.blue(this.workspace.substring(0, 30) + (this.workspace.length > 30 ? '...' : ' '.repeat(30 - this.workspace.length))) + chalk.dim('│'),
      chalk.dim('│') + ' Turns:           ' + chalk.white(this.conversationHistory.length.toString().padEnd(30)) + chalk.dim('│'),
      chalk.dim('│') + ' Est. Tokens:     ' + tokenColor(`~${syncTokenEstimate.toLocaleString()} / ${tokenLimit.toLocaleString()}`).padEnd(30) + chalk.dim('│'),
      chalk.dim('│') + ' Pending Diffs:   ' + chalk.white(this.diffEngine.getPendingDiffs().length.toString().padEnd(30)) + chalk.dim('│'),
      chalk.dim('│') + ' Applied Diffs:   ' + chalk.white(this.diffEngine.appliedDiffs.length.toString().padEnd(30)) + chalk.dim('│'),
      chalk.dim('╰────────────────────────────────────────────────────────╯')
    ].join('\n');

    return { message };
  }

  async _compactHistory(focus) {
    if (this.conversationHistory.length <= 5) {
      return { message: 'Conversation is too short to compact.' };
    }

    this.isCompacting = true;

    try {
      // Keep the last 5 turns exactly as they are
      const toCompact = this.conversationHistory.slice(0, -5);
      const toKeep = this.conversationHistory.slice(-5);

      // Deterministic lightweight truncation (fallback)
      let compactedSummary = toCompact.map(turn => {
        if (turn.role === 'system' && turn.content) {
          if (turn.content.includes('**Command Output:**')) return '[System: Command executed. Output truncated for context compaction.]';
          if (turn.content.includes('**File Contents:**') || turn.content.includes('**Search Results:**')) return '[System: File/Search data truncated for context compaction.]';
          if (turn.content.length > 500) return `[System: Output truncated. Original length: ${turn.content.length}]`;
        }
        return `[${turn.role.toUpperCase()}]: ${turn.content}`;
      }).join('\n\n');

      this.callbacks.sendToPanel({
        id: randomUUID(),
        type: 'status',
        payload: { message: '🧠 Compacting massive context window via Gemini LLM...' },
        timestamp: Date.now(),
      });

      const summaryPrompt = `You are a context compactor for an AI coding agent.
Your job is to read the following conversation history and summarize it into a tight, dense block of text.
CRITICAL RULES:
1. Preserve ALL file paths that were explored.
2. Preserve ALL technical conclusions, bugs found, or decisions made.
3. Preserve the exact current state of the user's task.
4. Do NOT output markdown formatting like \`\`\`json, just pure dense text.

HISTORY TO SUMMARIZE:
${compactedSummary}`;

      const llmResponse = await this._executeSubagent('gemini', summaryPrompt);
      let finalSummaryText = compactedSummary;
      
      if (llmResponse.success && llmResponse.result) {
        finalSummaryText = llmResponse.result;
      } else if (llmResponse.success && llmResponse.content) {
        finalSummaryText = llmResponse.content;
      }

      const compactedTurn = {
        role: 'system',
        type: 'compaction_summary',
        content: `[Context Summary of older turns]\n${finalSummaryText}`,
        timestamp: Date.now(),
      };

      // Mutate the history safely
      this.conversationHistory = [compactedTurn, ...toKeep];
      this.sessionStore.saveHistory(this.conversationHistory);
      this.promptBuilder.resetPromptState();

      this.callbacks.sendToPanel({
        id: randomUUID(),
        type: 'status',
        payload: { message: llmResponse.success ? '✅ History successfully auto-compacted (Gemini Summary).' : '✅ History auto-compacted (Lightweight Fallback).' },
        timestamp: Date.now(),
      });
      
      return { message: '✅ History compacted.' };
    } finally {
      this.isCompacting = false;
    }
  }
}
