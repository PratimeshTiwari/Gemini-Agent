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
import { looksLikeMultipleDrafts, looksLikeCapabilityDenial, looksLikeProviderError } from './drift-detector.js';
import { logError } from './error-log.js';

/**
 * How many times to re-ask when the *provider* errors rather than the model.
 * These are transient by nature, so a couple of attempts clears almost all of
 * them; more than that and something is actually wrong with the tab.
 */
const MAX_PROVIDER_RETRIES = 2;

/**
 * How many consecutive rounds may end with a failing tool call before the loop
 * stops and asks. Four is enough for "run it, read the error, fix it, run it
 * again" and short enough that a genuinely stuck command does not burn a
 * session.
 */
const MAX_FAILED_ROUNDS = 4;

/** The first useful line of a failed tool result, for the give-up message. */
function oneLineError(result) {
  if (typeof result === 'string') return result.split('\n')[0].slice(0, 160);
  const text = result?.stderr || result?.error || result?.stdout || '';
  const line = String(text).split('\n').find((l) => l.trim()) || 'no output';
  return line.slice(0, 160);
}
import * as paths from './paths.js';
import { resolveWorkspaceInput, validateWorkspace, rememberWorkspace } from './workspaces.js';
import { z } from 'zod';
import { SessionStore } from '../storage/session-store.js';
import { ContextManager } from '../context/context-manager.js';
import { MemoryManager } from '../context/memory-manager.js';


// Backstop for a prompt the extension never answers. Longer than the content
// script's own 5-minute cap so its `timedOut` report wins whenever it is alive.
const EXTENSION_RESPONSE_TIMEOUT = 7 * 60 * 1000;

// Regex to extract tool calls from Gemini's response (handles json code blocks)
const TOOL_CALL_REGEX = /```(?:json|tool_call)?\n\s*(?:json\s*|tool_call\s*)?([{\[][\s\S]*?[}\]])\s*\n```/gi;

export class AgentLoop {
  constructor({ workspace, mcpServer, promptBuilder, diffEngine, riskClassifier, editor, configHome, continueSession = false, agentSourceDir, taskManager }) {
    this.workspace = workspace;
    this.mcpServer = mcpServer;
    this.promptBuilder = promptBuilder;
    this.diffEngine = diffEngine;
    this.riskClassifier = riskClassifier;
    this.editor = editor;
    this.configHome = configHome;
    this.agentSourceDir = agentSourceDir;
    this.taskManager = taskManager;


    // Storage & Context
    this.sessionStore = new SessionStore(workspace);
    this.memoryManager = new MemoryManager(workspace);
    this.contextManager = new ContextManager(workspace, this.memoryManager);

    if (!continueSession) {
      this.sessionStore.clear(); // Start fresh if --continue not passed
    }

    // State defaults
    this.mode = 'plan'; // 'plan' | 'auto'
    this.topology = 'single'; // 'single' | 'duo' — derived from modelConfig.reviewer
    this.modelConfig = {
      main: 'gemini',
      reviewer: 'chatgpt',
      reasoningEffort: 'high',
      modelTier: 'pro',
      reasoningLevel: 'standard' // 'brief' | 'standard' | 'deep' — pro tier only
    };
    
    this.commandRules = {
      enabled: true,
      allow: [],
      block: []
    };

    // Extra folders whose .md files are injected as repo context each session.
    // Extra directories searched for skills, on top of <ws>/.agent/skills and
    // ~/.agent/skills. Set with `/skills add <dir>`.
    this.skillFolders = [];
    
    this._loadConfig();
    this.conversationHistory = this.sessionStore.loadHistory();
    this.pendingGeminiResponse = null;
    this.queuedUserMessage = null;
    this.callbacks = null;
    this.isProcessing = false;
    this.extensionQueue = [];
    this.isExtensionBusy = false;
    this.extensionWatchdog = null;
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
      // One tool-amnesia retry per user turn; see handleGeminiResponse.
      this._deniedToolsOnce = false;
      // Auto-heal budget, per user turn.
      this._failedRounds = 0;
      this._providerRetries = 0;

      // Build the full prompt
      const prompt = this.promptBuilder.buildPrompt({
        userMessage: content,
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
      this.abortExtensionWork();
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
      this._releaseExtension();
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
        this._releaseExtension();
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
        this._releaseExtension();
      }
      return;
    }

    // Request complete
    this._releaseExtension();

    // (Auto-compaction is now handled silently via background subagents, so the old isCompacting logic is removed from here)

    let toolCalls = [];
    let cleanContent = content;

    try {
      const extracted = this._extractToolCalls(content);
      toolCalls = extracted.toolCalls;
      cleanContent = extracted.cleanContent;

      // The single-response rule no longer rides on every message; it is
      // re-asserted when the model actually breaks it.
      if (looksLikeMultipleDrafts(cleanContent)) {
        this.promptBuilder.noteDrift();
      }
    } catch (err) {
      logError(this.workspace, {
        flow: 'agent', op: 'parse_tool_calls',
        message: `Malformed tool call: ${err.message}`,
        detail: content?.slice(0, 1500),
      });
      // A tool call the model could not format is the clearest signal its grip
      // on the instructions has slipped. Bring the reminder forward.
      this.promptBuilder.noteDrift();
      
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

    // The provider errored rather than the model answering. Re-ask: this is a
    // transient failure of the tab, and the user should not have to notice it.
    if (toolCalls.length === 0 && looksLikeProviderError(cleanContent)) {
      this._providerRetries = (this._providerRetries || 0) + 1;
      logError(this.workspace, {
        flow: 'agent', op: 'provider_error',
        message: cleanContent.trim().slice(0, 200),
        meta: { attempt: this._providerRetries },
      });
      if (this._providerRetries <= MAX_PROVIDER_RETRIES && this.currentObjective) {
        this._notify(`⚠️ Gemini returned an error — retrying (${this._providerRetries}/${MAX_PROVIDER_RETRIES})…`);
        this._sendToGemini(this.promptBuilder.buildPrompt({
          userMessage: this.currentObjective,
          mode: this.mode,
          topology: this.topology,
          modelConfig: this.modelConfig,
          objective: this.currentObjective,
        }), this.callbacks);
        return;
      }
    }

    // The model has forgotten it has tools and refused the task outright. This
    // is the cost of only sending the system prompt every Nth turn: usually it
    // remembers, and when it does not the whole turn is wasted on a confident
    // refusal. Re-send the full prompt and retry the request instead of handing
    // the user a dead end to retype.
    //
    // Once per turn. If it denies its tools again with the definitions right
    // there in front of it, retrying will not help and the reply is the honest
    // thing to show.
    if (toolCalls.length === 0 && looksLikeCapabilityDenial(cleanContent)) {
      if (!this._deniedToolsOnce && this.currentObjective) {
        this._deniedToolsOnce = true;
        logError(this.workspace, {
          flow: 'agent', op: 'tool_amnesia',
          message: 'Model denied having tools; re-sent the definitions',
          detail: cleanContent.slice(0, 400),
        });
        this.promptBuilder.resetPromptState(); // next prompt carries the tool definitions

        this.callbacks.sendToPanel({
          id: randomUUID(),
          type: 'status',
          payload: { message: '🧰 Model forgot its tools — resending the tool definitions...' },
          timestamp: Date.now(),
        });

        const note = {
          role: 'system',
          content: '[System: the model denied having tools; the full tool definitions were re-sent and the request retried.]',
          timestamp: Date.now(),
        };
        this.conversationHistory.push(note);
        this.sessionStore.appendTurn(note);

        this._sendToGemini(this.promptBuilder.buildPrompt({
          userMessage: this.currentObjective,
          mode: this.mode,
          topology: this.topology,
          modelConfig: this.modelConfig,
          objective: this.currentObjective,
        }), this.callbacks);
        return;
      }
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
  /**
   * A watched background task logged something that looks broken.
   *
   * This is the self-healing entry point, and the only path that starts a turn
   * without the user typing. A dev server that dies three minutes after launch
   * is invisible otherwise: the agent has finished its turn, nothing is
   * polling, and the next thing anyone notices is the app not working.
   *
   * Ignored while a turn is already running — the agent is mid-thought, the
   * failing lines are in the task's buffer, and interrupting it to insert an
   * unrelated prompt is how two turns end up interleaved in one browser tab.
   * The watch stays disarmed either way, so this fires once per fault.
   */
  handleTaskAlert(hit) {
    if (this.isProcessing || !this.callbacks) return;

    const prompt = [
      `A background task you started has failed. Task ${hit.taskId}: \`${hit.command}\``,
      '',
      `Matched line (${hit.stream}): ${hit.line}`,
      '',
      'Recent output:',
      hit.context,
      '',
      'Diagnose it and fix it. Read the files involved, make the change, and restart the task '
      + 'if that is what it needs. If the cause is something only the user can resolve, say so '
      + 'plainly and stop rather than guessing.',
    ].join('\n');

    const turn = {
      role: 'user',
      content: `[Watched task ${hit.taskId} failed: ${hit.line}]`,
      timestamp: Date.now(),
    };
    this.conversationHistory.push(turn);
    this.sessionStore.appendTurn(turn);

    this.isProcessing = true;
    this.currentObjective = `Fix the failure in background task ${hit.taskId}`;
    this._deniedToolsOnce = false;
    this._failedRounds = 0;

    this._notify(`🔧 Task ${hit.taskId} failed — investigating…`);
    this._sendToGemini(this.promptBuilder.buildPrompt({
      userMessage: prompt,
      mode: this.mode,
      topology: this.topology,
      modelConfig: this.modelConfig,
      objective: this.currentObjective,
    }), this.callbacks);
  }

  /**
   * Switch which repo inside the group the agent is working on.
   *
   * Only meaningful when the workspace sits under a shared `.agent/` — see
   * paths.resolveState. The scope decides where state, sessions, artifacts and
   * config live, so changing it is closer to opening a different project than
   * to changing a setting: the conversation belongs to the old scope and the
   * new one has its own history.
   *
   * @returns {string} a message for the transcript.
   */
  setScope(scope) {
    const previous = paths.getActiveScope(this.workspace);
    const next = paths.setActiveScope(scope);
    if (previous === (next || '')) {
      return `Already working on: ${next || '(the workspace root)'}`;
    }

    // Everything below is keyed on the resolved .agent directory, which has
    // just moved.
    this.sessionStore = new SessionStore(this.workspace);
    this.conversationHistory = this.sessionStore.loadHistory();
    this.memoryManager = new MemoryManager(this.workspace);
    this.contextManager = new ContextManager(this.workspace, this.memoryManager);
    this._loadConfig();
    this.promptBuilder?.resetPromptState?.();
    this.workspaceSummary = '';

    const target = next ? path.join(this.workspace, next) : this.workspace;
    return `🎯 Now working on **${next || 'the workspace root'}**\n\n`
      + `Code: \`${target}\`\nState: \`${paths.agentDir(this.workspace)}\`\n`
      + `Shared with the other repos: \`${paths.sharedAgentDir(this.workspace)}\`\n\n`
      + `${this.conversationHistory.length} turn${this.conversationHistory.length === 1 ? '' : 's'} of history loaded for this scope.`;
  }

  /**
   * Point the agent at another directory.
   *
   * The workspace is duplicated across half a dozen collaborators, so this is
   * the one place that rewires them — `/workspace` and `/agent-dir` both used
   * to carry their own copy of the list, and they had already drifted apart.
   *
   * SessionStore is deliberately left alone: rebinding it here would write the
   * current conversation into the other project's history file.
   *
   * @param {string} workspace - an absolute path that has already been checked
   *   by {@link validateWorkspace}.
   * @returns {string} a message for the transcript.
   */
  setWorkspace(workspace, note = '') {
    if (workspace === this.workspace) {
      return `📂 Already using: ${workspace}`;
    }

    this.workspace = workspace;
    if (this.mcpServer) this.mcpServer.workspace = workspace;
    if (this.promptBuilder) this.promptBuilder.workspace = workspace;
    if (this.diffEngine) this.diffEngine.workspace = workspace;
    if (this.contextManager) {
      this.contextManager.workspacePath = workspace;
      if (this.contextManager.summarizer) this.contextManager.summarizer.workspacePath = workspace;
    }

    this.workspaceSummary = '';        // stale for the new project
    this.promptBuilder?.resetPromptState?.();
    paths.clearPathCache();            // the state root is resolved per workspace
    rememberWorkspace(workspace);

    return `📂 Workspace changed${note ? ` to ${note}` : ''}: ${workspace}`;
  }

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
          if (['single', 'duo'].includes(newTopology)) {
            this.topology = newTopology;
            this._saveConfig();
            this.promptBuilder.resetPromptState();
            return { message: `🌐 Switched to Agent Topology: ${newTopology.toUpperCase()}` };
          }
          return { message: `❌ Invalid mode. Use: single or duo.` };
        }
        return { message: `Current Agent Topology: ${this.topology}` };

      case 'config':
        if (args?.length === 2) {
          const role = args[0].toLowerCase();
          const model = args[1].toLowerCase();
          if (['main', 'reviewer'].includes(role) && ['gemini', 'chatgpt'].includes(model)) {
            this.modelConfig[role] = model;
            this._saveConfig();
            this.promptBuilder.resetPromptState();
            return { message: `✅ Assigned ${model} to ${role} role.` };
          }
          return { message: `❌ Invalid args. Usage: /config <role> <model>\nRoles: main, reviewer\nModels: gemini, chatgpt` };
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

      // `/context` reports what is in the window. Registering folders of .md
      // files here was a second way to give the model standing instructions;
      // AGENT.md is the only one now, so only the report is left.
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
        const target = this.agentSourceDir || this.workspace;
        const problem = validateWorkspace(target);
        if (problem) return { message: `❌ ${problem}` };
        return { message: this.setWorkspace(target, 'agent source') };
      }

      case 'workspace': {
        // Args are re-joined because a path may contain spaces; the command
        // used to take args[0] and silently truncate "~/My Projects/app".
        const requested = args?.join(' ').trim();
        if (!requested) return { message: `📂 Current workspace: ${this.workspace}` };

        const abs = resolveWorkspaceInput(requested, this.workspace);
        const problem = validateWorkspace(abs);
        if (problem) {
          // Refusing here is the whole point: an unchecked path used to be
          // assigned anyway, and every tool call after it failed separately
          // against a root that was never there.
          return { message: `❌ ${problem}\n\nWorkspace unchanged: ${this.workspace}\nTry \`/set-workspace\` to pick one from a list.` };
        }
        return { message: this.setWorkspace(abs) };
      }

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

      case 'reasoning': {
        const levels = {
          brief: { label: '🏃 Brief', blurb: 'Investigate → Implement → Verify. For small, well-understood edits.' },
          standard: { label: '🪜 Standard', blurb: 'Restate and decompose into a checklist first, then the 4-phase protocol.' },
          deep: { label: '🔭 Deep', blurb: 'Standard, plus approach enumeration, risk analysis and an adversarial self-review.' },
        };
        const wanted = args?.[0]?.toLowerCase();
        if (wanted && levels[wanted]) {
          this.modelConfig.reasoningLevel = wanted;
          this._saveConfig();
          this.promptBuilder.resetPromptState();
          const tierNote = (this.modelConfig.modelTier || 'pro') === 'pro'
            ? ''
            : `\n\n⚠️ You are on the ${(this.modelConfig.modelTier || 'pro').toUpperCase()} tier, where reasoning levels do nothing. Switch with \`/model pro\`.`;
          return { message: `${levels[wanted].label} reasoning\n\n${levels[wanted].blurb}${tierNote}` };
        }
        const now = this.modelConfig.reasoningLevel || 'standard';
        const list = Object.entries(levels)
          .map(([key, v]) => `  ${v.label} \`/reasoning ${key}\`${key === now ? '  ← current' : ''}\n      ${v.blurb}`)
          .join('\n');
        return { message: `🧭 Reasoning level: **${now.toUpperCase()}** (pro tier only)\n\n${list}` };
      }

      case 'allowlist': {
        const action = args?.[0]?.toLowerCase();
        const rest = args?.slice(1).join(' ').trim();
        const rules = this.commandRules;

        // `add` was missing entirely: rules could only ever appear by answering
        // "Allow Always" on a prompt, so there was no way to pre-approve a
        // command you already knew you wanted.
        if ((action === 'add' || action === 'allow') && rest) {
          if (!rules.allow.includes(rest)) rules.allow.push(rest);
          rules.block = rules.block.filter((c) => c !== rest);
          this._saveConfig();
          return { message: `✅ Allowed: \`${rest}\`` };
        }
        if (action === 'block' && rest) {
          if (!rules.block.includes(rest)) rules.block.push(rest);
          rules.allow = rules.allow.filter((c) => c !== rest);
          this._saveConfig();
          return { message: `⛔ Blocked: \`${rest}\`` };
        }
        if (action === 'remove' && rest) {
          const had = rules.allow.includes(rest) || rules.block.includes(rest);
          rules.allow = rules.allow.filter((c) => c !== rest);
          rules.block = rules.block.filter((c) => c !== rest);
          this._saveConfig();
          return { message: had ? `🗑️ Removed: \`${rest}\`` : `Not a rule: \`${rest}\`` };
        }
        if (action === 'clear') {
          const n = rules.allow.length + rules.block.length;
          rules.allow = [];
          rules.block = [];
          this._saveConfig();
          return { message: `🧹 Cleared ${n} rule${n === 1 ? '' : 's'}.` };
        }
        if (action === 'enable' || action === 'disable') {
          rules.enabled = action === 'enable';
          this._saveConfig();
          return {
            message: rules.enabled
              ? '✅ Command rules **enabled** — allowed commands run without asking.'
              : '⛔ Command rules **disabled** — every command asks for approval.',
          };
        }

        // Counts, not contents. A rule can be a whole compound shell command,
        // and printing every one of them turned "what is this command?" into a
        // page of git incantations. The picker is where you read and remove them.
        return {
          message: `### 🛡️ Command rules — ${rules.enabled !== false ? 'enabled' : 'disabled'}\n\n`
            + `${rules.allow.length} allowed · ${rules.block.length} blocked\n\n`
            + '_`/allowlist` on its own opens the picker — view, add, or remove there._',
        };
      }

      case 'github': {
        const subCommand = args?.[0]?.toLowerCase();

        if (subCommand === 'remove-token') {
          delete process.env.GITHUB_TOKEN;
          this.modelConfig.githubToken = '';
          this._saveConfig();
          if (this.githubHandler) {
            this.githubHandler.stop();
            this.githubHandler = null;
          }
          return { message: '🗑️ GitHub token removed. Set GITHUB_TOKEN and restart to reconnect.' };
        }

        if (!this.githubHandler) {
          return { message: '⚠️ GitHub Agent not initialized. Set GITHUB_TOKEN env var and restart.' };
        }

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

  /**
   * @param {string|Array<{question: string, answer: string}>} answer - a bare
   *   answer, or one entry per question when the model asked a batch.
   */
  answerQuestion(answer) {
    if (!this.pendingQuestionResolve) return;

    let result;
    if (Array.isArray(answer)) {
      // Echo the questions back beside the answers: the model asked them
      // several turns of tool output ago and pairing them up itself is exactly
      // the kind of bookkeeping it gets wrong.
      result = answer.length === 1
        ? `User answered: ${answer[0].answer}`
        : ['The user answered all of your questions:', ...answer.map(
            (entry, i) => `${i + 1}. ${entry.question}\n   → ${entry.answer}`,
          )].join('\n');
    } else {
      result = `User answered: ${answer}`;
    }

    this.pendingQuestionResolve({ success: true, result });
    this.pendingQuestionResolve = null;
  }

  /**
   * The user dismissed the question instead of answering it.
   *
   * This has to resolve, not reject and not do nothing: `ask_question` awaits
   * `pendingQuestionResolve`, so leaving it pending hangs the turn with no way
   * back. Telling the model to proceed on a stated assumption is the only
   * answer that keeps the loop moving.
   */
  cancelQuestion() {
    if (this.pendingQuestionResolve) {
      this.pendingQuestionResolve({
        success: true,
        result: 'The user dismissed the question without answering. Do not ask it again. '
          + 'Choose the most reasonable interpretation, state it explicitly as an assumption, and continue.',
      });
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

  /**
   * Load config, shared settings first and the scope's own on top.
   *
   * In a group layout the root's config.json holds what every repo inherits —
   * the model, the topology, the command allowlist — and each repo's own file
   * overrides only what it needs. Outside a group the two are the same file and
   * this is exactly what it always was.
   */
  _loadConfig() {
    const shared = paths.sharedConfigPath(this.workspace);
    const scoped = paths.configPath(this.workspace);
    // Same path when there is no scope; reading it twice would be harmless but
    // pointless.
    const files = shared === scoped ? [scoped] : [shared, scoped];

    for (const file of files) {
      if (!fs.existsSync(file)) continue;
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (data.topology) this.topology = data.topology;
        if (data.modelConfig) this.modelConfig = { ...this.modelConfig, ...data.modelConfig };
        if (data.commandRules) this.commandRules = { ...this.commandRules, ...data.commandRules };
        if (Array.isArray(data.skillFolders)) this.skillFolders = data.skillFolders;
      } catch (err) {
        logError(this.workspace, {
          flow: 'context', op: 'load_config', message: `${file}: ${err.message}`,
        });
      }
    }
  }

  _saveConfig() {
    const configPath = paths.ensureParent(paths.configPath(this.workspace));
    try {
      // Merge over whatever is on disk rather than replacing it. This used to
      // write a fixed set of four keys, which silently destroyed every other
      // one — `agentName` is set by hand and only ever read (by the banner), so
      // the first /model or /reasoning wiped it.
      let existing = {};
      try {
        existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (!existing || typeof existing !== 'object' || Array.isArray(existing)) existing = {};
      } catch {
        /* absent or unparseable: start from nothing rather than refuse to save */
      }
      fs.writeFileSync(configPath, JSON.stringify({
        ...existing,
        topology: this.topology,
        modelConfig: this.modelConfig,
        commandRules: this.commandRules,
        skillFolders: this.skillFolders
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
    this._armExtensionWatchdog();
    if (this.callbacks && this.callbacks.injectPrompt) {
      this.callbacks.injectPrompt(payload);
    }
  }

  /**
   * One browser tab, one in-flight prompt: `isExtensionBusy` is the lock.
   * Every path that ends a turn has to hand it back, or the queue wedges for
   * the rest of the session and later prompts vanish into it silently.
   */
  _releaseExtension() {
    this._clearExtensionWatchdog();
    this.isExtensionBusy = false;
    this._processExtensionQueue();
  }

  /**
   * Give up on the in-flight request and drop anything queued behind it.
   * Used when a turn dies rather than completes — an injection error, a
   * user stop, an exception while building the prompt. The queued prompts
   * belong to that dead turn, so replaying them would be wrong.
   */
  abortExtensionWork() {
    this._clearExtensionWatchdog();
    this.extensionQueue.length = 0;
    this.isExtensionBusy = false;
    this.pendingGeminiResponse = null;
  }

  /**
   * The content script gives up after RESPONSE_MAX_TIMEOUT (5 min) and reports
   * `timedOut`. This is the backstop for when it never gets the message at all
   * — an asleep service worker, a tab with no bridge — where nothing would come
   * back and the CLI would sit on "Thinking..." forever.
   */
  _armExtensionWatchdog() {
    this._clearExtensionWatchdog();
    this.extensionWatchdog = setTimeout(() => {
      this.extensionWatchdog = null;
      if (!this.isExtensionBusy) return;
      console.warn('[Agent Loop] No response from the extension bridge; releasing it.');
      this.isProcessing = false;
      if (this.callbacks) {
        this.callbacks.sendToPanel({
          id: randomUUID(),
          type: 'error',
          payload: {
            message:
              'No response from the browser bridge. Check that the extension is loaded ' +
              'and a gemini.google.com tab is open, then try again.',
          },
          timestamp: Date.now(),
        });
      }
      this.abortExtensionWork();
    }, EXTENSION_RESPONSE_TIMEOUT);
    this.extensionWatchdog.unref?.();
  }

  _clearExtensionWatchdog() {
    if (this.extensionWatchdog) {
      clearTimeout(this.extensionWatchdog);
      this.extensionWatchdog = null;
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
      const isParallel = ['ask_researcher', 'ask_reviewer', 'ask_subagent'].includes(call.name);

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
            onTaskAlert: (hit) => this.handleTaskAlert(hit),
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
            payload: {
              question: call.args.question,
              options: call.args.options,
              header: call.args.header,
              questions: call.args.questions,
            },
            timestamp: Date.now(),
          });
        });
      } else if (call.name === 'ask_reviewer' || call.name === 'ask_researcher' || call.name === 'ask_subagent') {
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
        // Carried through so the result envelope can say plainly that this one
        // failed. A non-zero exit buried in minified JSON is easy for the model
        // to skim past and summarise as if it had worked.
        failed: result.success === false
          || (typeof result.result?.exitCode === 'number' && result.result.exitCode !== 0),
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

          // Tell the model what actually happened. create_file and edit_file
          // both return `status: 'pending_approval'` because that is true at
          // the moment they build the diff — but when the edit is auto-applied
          // (a .md file in plan mode, a safe edit in auto mode) nobody ever
          // asks, and the model faithfully reported "waiting for your approval"
          // about a file that was already on disk. The user then goes looking
          // for a prompt that does not exist.
          toolResults[i] = {
            call_id: call.id || randomUUID(),
            name: call.name,
            result: {
              filePath: diffResult.filePath,
              status: 'applied',
              message: `Applied to ${diffResult.filePath}. No approval was needed — do not tell the user it is pending.`,
            },
          };

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

    // Auto-healing has to be bounded, or a command that cannot succeed — a
    // missing binary, a service that is down, a permission the user has to
    // grant — turns into the model retrying variations of it until the token
    // budget is gone. Consecutive *failing* rounds are the thing to count:
    // progress resets it, so a long run that keeps succeeding never trips.
    const anyFailed = toolResults.some((r) => r?.failed);
    this._failedRounds = anyFailed ? (this._failedRounds || 0) + 1 : 0;

    if (this._failedRounds >= MAX_FAILED_ROUNDS) {
      this._failedRounds = 0;
      for (const r of toolResults.filter((x) => x?.failed)) {
        logError(this.workspace, {
          flow: 'tool', op: r.name,
          message: oneLineError(r.result),
          meta: { gaveUpAfter: MAX_FAILED_ROUNDS },
        });
      }
      const summary = toolResults
        .filter((r) => r?.failed)
        .map((r) => `  • ${r.name}: ${oneLineError(r.result)}`)
        .join('\n');

      const stopTurn = {
        role: 'assistant',
        isLocal: true,
        content: `🛑 Stopped after ${MAX_FAILED_ROUNDS} rounds of failing commands — `
          + 'this needs you rather than another attempt.\n\n'
          + `${summary}\n\n`
          + 'Tell me what to try next, or fix the underlying problem and say "retry".',
        timestamp: Date.now(),
      };
      this.conversationHistory.push(stopTurn);
      this.sessionStore.appendTurn(stopTurn);

      this.isProcessing = false;
      this.callbacks.sendToPanel({
        id: randomUUID(),
        type: 'agent_response',
        payload: { content: stopTurn.content },
        timestamp: Date.now(),
      });
      this._releaseExtension();
      return;
    }

    // Send tool results back to Gemini for continuation. One message, however
    // many results it carries — the refresh cadence counts messages pushed to
    // the tab, and a parallel fan-out is still one push.
    this.promptBuilder.noteMessageSent();
    this._sendToGemini(this.promptBuilder.buildToolResultBatch(toolResults), this.callbacks);
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

      // Subagents also run for /compact and background GitHub work, neither of
      // which has a user turn's callbacks attached.
      this._notify(`🤖 [${targetModel}] Thinking...`);

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
            editor: this.editor, taskManager: this.taskManager,
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
    let providerRetries = 0;

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

      // Gemini's own failure message arrives through the same path as a real
      // reply, with no tool calls and some prose — structurally identical to a
      // finished answer. Left alone it became `lastCleanContent` and was
      // written to disk as the PR plan.
      if (toolCalls.length === 0 && looksLikeProviderError(cleanContent)) {
        providerRetries++;
        if (providerRetries <= MAX_PROVIDER_RETRIES) {
          localHistory.push({
            role: 'system',
            content: '[System: the previous response was a provider error, not an answer. Retrying the same request.]',
          });
          continue;
        }
        return { success: false, error: `Gemini kept returning an error: ${cleanContent.trim()}` };
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
          // Provide workspace context and strictly enforce Gemini for nested subagents
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

  /**
   * Push a status line to the UI, if anyone is listening.
   *
   * `this.callbacks` is only set while a *user turn* is running. Slash commands
   * go straight to `handleSlashCommand`, so `/compact` on a fresh session found
   * it null and threw on `this.callbacks.sendToPanel` — which the UI did not
   * catch either, so the whole thing hung with nothing on screen.
   */
  _notify(message) {
    const target = this.callbacks || this._backgroundCallbacks;
    if (!target?.sendToPanel) return;
    target.sendToPanel({
      id: randomUUID(),
      type: 'status',
      payload: { message },
      timestamp: Date.now(),
    });
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

      this._notify('🧠 Summarising the older turns in a browser tab…');

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

      // Say what actually happened. "✅ History compacted." told the user
      // nothing — not how much went, not whether the model summarised it or the
      // deterministic fallback did, and not where the summary went.
      const approxTokens = (turns) => Math.round(
        turns.reduce((sum, t) => sum + ((t.content?.length || 0) / 4), 0),
      );
      const before = approxTokens([...toCompact, ...toKeep]);
      const after = approxTokens(this.conversationHistory);
      const how = llmResponse.success
        ? 'summarised by the model'
        : 'condensed locally (the model did not answer, so the deterministic fallback ran)';

      return {
        message: `✅ Compacted ${toCompact.length} turn${toCompact.length === 1 ? '' : 's'} into one summary, `
          + `${how}.\n\n`
          + `Kept the last ${toKeep.length} turns as they were. `
          + `Context is roughly ${before.toLocaleString()} → ${after.toLocaleString()} tokens.\n\n`
          + 'The summary is now the first turn of this conversation — it is in the transcript above '
          + 'and saved to `.agent/sessions/history.jsonl`. The browser tab it was written in is '
          + 'scratch space; nothing is left there.',
      };
    } finally {
      this.isCompacting = false;
    }
  }
}
