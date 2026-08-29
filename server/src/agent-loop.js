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
import { z } from 'zod';
import { SessionStore } from './storage/SessionStore.js';
import { ContextManager } from './context/ContextManager.js';
import { MemoryManager } from './context/MemoryManager.js';


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
      reasoningEffort: 'medium',
      useLocalLlm: false
    };
    
    this._loadConfig();
    this.conversationHistory = this.sessionStore.loadHistory();
    this.pendingGeminiResponse = null;
    this.queuedUserMessage = null;
    this.callbacks = null;
    this.isProcessing = false;
    this.pendingSubagents = new Map(); // Maps requestId -> { resolve, reject }

    // Workspace summary (generated dynamically by context manager)
    // Workspace summary removed to save context window.
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
    if (!this.isProcessing) {
      console.warn('[Agent Loop] Received Gemini response but agent is no longer processing (likely stopped).');
      return;
    }

    const { content, requestId, isSubagent, complete } = payload;

    if (!this.callbacks) {
      console.warn('⚠️ Received Gemini response but no callbacks registered');
      return;
    }

    if (isSubagent) {
      this.handleSubagentResponse(requestId, content);
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
      }
      return;
    }

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
    }
  }

  /**
   * Handle a response from a subagent (e.g. ChatGPT/Claude).
   */
  handleSubagentResponse(requestId, content) {
    if (this.pendingSubagents.has(requestId)) {
      const { resolve } = this.pendingSubagents.get(requestId);
      this.pendingSubagents.delete(requestId);
      resolve({ success: true, result: content });
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
    } catch (err) {
      if (this.callbacks) {
        this.callbacks.sendToPanel({
          id: randomUUID(),
          type: 'error',
          payload: { message: `Diff error: ${err.message}` },
          timestamp: Date.now(),
        });
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

      case 'reasoning': {
        const levels = ['low', 'medium', 'high'];
        if (args?.[0] && levels.includes(args[0].toLowerCase())) {
          this.modelConfig.reasoningEffort = args[0].toLowerCase();
          this._saveConfig();
          return { message: `🧠 Reasoning effort set to: **${this.modelConfig.reasoningEffort.toUpperCase()}**` };
        }
        return { message: `🧠 Current reasoning effort: **${this.modelConfig.reasoningEffort?.toUpperCase() || 'MEDIUM'}**\nUsage: \`/reasoning <low|medium|high>\`` };
      }
      
      case 'localllm': {
        if (args?.[0] && ['on', 'off'].includes(args[0].toLowerCase())) {
          this.modelConfig.useLocalLlm = args[0].toLowerCase() === 'on';
          this._saveConfig();
          return { message: `💻 Local LLM Engine: **${this.modelConfig.useLocalLlm ? 'ENABLED' : 'DISABLED'}**` };
        }
        return { message: `💻 Local LLM Engine is currently: **${this.modelConfig.useLocalLlm ? 'ENABLED' : 'DISABLED'}**\nUsage: \`/localllm <on|off>\`` };
      }

      default:
        return { message: `Unknown command: /${command}. Available: /plan, /auto, /clear, /context, /compact, /undo, /workspace, /agent-dir` };
    }
  }

  // ── Private Methods ──────────────────────────────────────────────

  answerQuestion(answer) {
    if (this.pendingQuestionResolve) {
      this.pendingQuestionResolve({ success: true, result: `User answered: ${answer}` });
      this.pendingQuestionResolve = null;
    }
  }

  answerCommandApproval(approved) {
    if (this.pendingCommandResolve) {
      this.pendingCommandResolve({ approved });
      this.pendingCommandResolve = null;
    }
  }

  _loadConfig() {
    const configPath = path.join(this.workspace, '.gemini', 'config.json');
    if (fs.existsSync(configPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (data.topology) this.topology = data.topology;
        if (data.modelConfig) this.modelConfig = { ...this.modelConfig, ...data.modelConfig };
      } catch (err) {
        console.warn('⚠️ Failed to load .gemini/config.json:', err.message);
      }
    }
  }

  _saveConfig() {
    const geminiDir = path.join(this.workspace, '.gemini');
    if (!fs.existsSync(geminiDir)) {
      fs.mkdirSync(geminiDir, { recursive: true });
    }
    const configPath = path.join(geminiDir, 'config.json');
    try {
      fs.writeFileSync(configPath, JSON.stringify({
        topology: this.topology,
        modelConfig: this.modelConfig
      }, null, 2));
    } catch (err) {
      console.warn('⚠️ Failed to save config:', err.message);
    }
  }

  async _sendToGemini(prompt, callbacks) {
    // Create a promise that will be resolved when we get the Gemini response
    this.pendingGeminiResponse = true;

    callbacks.injectPrompt({
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
    const toolResults = [];

    for (const call of toolCalls) {
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
          if ((call.name === 'create_file' || call.name === 'edit_file') && call.args.path.endsWith('.md')) {
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
      } else if (call.name === 'run_command' && needsApproval) {
        // Pause and request user approval for risky commands
        const approval = await new Promise((resolve) => {
          this.pendingCommandResolve = resolve;
          this.callbacks.sendToPanel({
            id: randomUUID(),
            type: 'request_command_approval',
            payload: { 
              command: call.args.command,
              cwd: call.args.cwd || this.workspace,
              riskLevel: risk.level,
              riskReason: risk.reason
            },
            timestamp: Date.now(),
          });
        });
        
        if (approval.approved) {
          result = await this.mcpServer.executeTool(call.name, call.args, {
            editor: this.editor,
            taskManager: this.taskManager,
            workspaceIndexer: this.workspaceIndexer,
          });
        } else {
          result = { success: false, error: 'User rejected command execution.' };
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
      } else if (call.name === 'ask_reviewer' || call.name === 'ask_reasoner') {
        const role = call.name.split('_')[1];
        const targetModel = this.modelConfig[role] || 'claude'; // default to claude for subagents if not set
        
        // Auto-wrap the prompt with role-specific instructions
        const wrapper = this.promptBuilder.buildSubagentWrapper(role);
        const wrappedPrompt = wrapper + call.args.prompt;
        
        result = await this._executeSubagent(targetModel, wrappedPrompt);
      } else if (call.name === 'ask_local_subagent') {
        this.callbacks.sendToPanel({
          id: randomUUID(),
          type: 'status',
          payload: { message: `Running Local Model...` },
          timestamp: Date.now(),
        });
        
        try {
          if (!this.modelConfig.useLocalLlm) {
            throw new Error("Local LLMs are currently DISABLED. Use `/localllm on` to enable them.");
          }
          
          if (!this.localLLM) {
            this.callbacks.sendToPanel({ id: randomUUID(), type: 'status', payload: { message: 'Initializing Local LLM Engine...' }, timestamp: Date.now() });
            const { LocalLLM } = await import('./local-llm.js');
            this.localLLM = new LocalLLM();
          }

          const model = call.args.model || 'qwen';
          const answer = await this.localLLM.generate(call.args.prompt, model, (progress) => {
            this.callbacks.sendToPanel({
              id: randomUUID(),
              type: 'status',
              payload: { message: progress },
              timestamp: Date.now(),
            });
          });
          result = { success: true, result: answer };
        } catch (err) {
          result = { success: false, error: err.message };
        }
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
      const callTurn = {
        role: 'system',
        type: 'tool_call',
        toolName: call.name,
        args: call.args,
        timestamp: Date.now(),
      };
      this.conversationHistory.push(callTurn);
      this.sessionStore.appendTurn(callTurn);
      
      const rawResult = result.result || result.error;
      const resultStr = typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult);
      const truncatedResult = resultStr.length > 1000 
        ? resultStr.substring(0, 1000) + '\n... [truncated]' 
        : resultStr;

      const resultTurn = {
        role: 'system',
        type: 'tool_result',
        toolName: call.name,
        result: truncatedResult,
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
          // Request approval
          this.callbacks.requestDiffApproval({
            diffId: diffResult.diffId,
            filePath: diffResult.filePath,
            patch: diffResult.patch,
            hunks: diffResult.hunks,
            riskLevel: risk.level,
            riskReason: risk.reason,
          });
        }
      }

      toolResults.push({
        name: call.name,
        result: result.success ? result.result : result.error,
      });
    }

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

      this.callbacks.injectPrompt({
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
          resolve({ success: false, error: `${targetModel} timeout after 5 minutes.` });
        }
      }, 300000);
    });
  }

  async _getContextInfo() {
    const historyTokenEstimate = this.contextManager 
      ? import('./context/TokenCounter.js').then(m => m.TokenCounter.estimateHistoryTokens(this.conversationHistory)) 
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

      // Deterministic lightweight truncation:
      // Instead of an LLM summarization, we just strip the heavy tool execution outputs
      // from the older context, preserving only the tool names and user/assistant messages.
      let compactedSummary = toCompact.map(turn => {
        if (turn.role === 'system' && turn.content) {
          if (turn.content.includes('**Command Output:**')) {
            return '[System: Command executed. Output truncated for context compaction.]';
          }
          if (turn.content.includes('**File Contents:**') || turn.content.includes('**Search Results:**')) {
             return '[System: File/Search data truncated for context compaction.]';
          }
          if (turn.content.length > 500) {
            return `[System: Output truncated. Original length: ${turn.content.length}]`;
          }
        }
        return `[${turn.role.toUpperCase()}]: ${turn.content}`;
      }).join('\n\n');

      const compactedTurn = {
        role: 'system',
        type: 'compaction_summary',
        content: `[Context Summary of older turns]\n${compactedSummary}`,
        timestamp: Date.now(),
      };

      // Mutate the history safely
      this.conversationHistory = [compactedTurn, ...toKeep];
      this.sessionStore.saveHistory(this.conversationHistory);
      this.promptBuilder.resetPromptState();

      this.callbacks.sendToPanel({
        id: randomUUID(),
        type: 'status',
        payload: { message: '✅ History successfully auto-compacted (Lightweight Truncation).' },
        timestamp: Date.now(),
      });
      
      return { message: '✅ History compacted.' };
    } finally {
      this.isCompacting = false;
    }
  }
}
