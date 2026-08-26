/**
 * Agent Loop
 *
 * The core orchestration engine. Handles the full cycle:
 *   User message → Build prompt → Send to Gemini → Parse response →
 *   Execute tool calls → Inject results → Loop until complete → Respond
 */

import { randomUUID } from 'crypto';
import { SessionStore } from './storage/SessionStore.js';
import { ContextManager } from './context/ContextManager.js';

// Regex to extract tool calls from Gemini's response (handles json code blocks)
const TOOL_CALL_REGEX = /```(?:json|tool_call)?\n\s*(?:json\s*|tool_call\s*)?([{\[][\s\S]*?[}\]])\s*\n```/gi;

export class AgentLoop {
  constructor({ workspace, mcpServer, promptBuilder, diffEngine, riskClassifier, editor, configHome, continueSession = false, agentSourceDir }) {
    this.workspace = workspace;
    this.mcpServer = mcpServer;
    this.promptBuilder = promptBuilder;
    this.diffEngine = diffEngine;
    this.riskClassifier = riskClassifier;
    this.editor = editor;
    this.configHome = configHome;
    this.agentSourceDir = agentSourceDir;

    // Storage & Context
    this.sessionStore = new SessionStore(workspace);
    this.contextManager = new ContextManager(workspace);

    if (!continueSession) {
      this.sessionStore.clear(); // Start fresh if --continue not passed
    }

    // State
    this.mode = 'plan'; // 'plan' | 'auto'
    this.conversationHistory = this.sessionStore.loadHistory();
    this.pendingGeminiResponse = null;
    this.queuedUserMessage = null;
    this.callbacks = null;
    this.isProcessing = false;

    // Workspace summary (generated dynamically by context manager)
    this.workspaceSummary = '';
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

    // Check Context Size Warning
    if (this.contextManager.needsCompaction(this.conversationHistory)) {
      this.callbacks.sendToPanel({
        id: randomUUID(),
        type: 'status',
        payload: { message: '⚠️ Context size high. Consider running /compact to save tokens.' },
        timestamp: Date.now(),
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

      if (!this.workspaceSummary) {
        this.workspaceSummary = this.contextManager.getWorkspaceSummary();
      }

      // Build the full prompt
      const prompt = this.promptBuilder.buildPrompt({
        userMessage: content,
        conversationHistory: this.conversationHistory,
        workspaceSummary: this.workspaceSummary,
        mode: this.mode,
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
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Handle a response from Gemini (via content script).
   */
  async handleGeminiResponse(messageId, payload) {
    const { content } = payload;

    if (!this.callbacks) {
      console.warn('⚠️ Received Gemini response but no callbacks registered');
      return;
    }

    if (this.isCompacting) {
      this.isCompacting = false;
      const summary = content.trim();

      const compactedTurn = {
        role: 'system',
        type: 'compaction_summary',
        content: `[Context Summary]\n${summary}`,
        timestamp: Date.now(),
      };

      this.conversationHistory = [compactedTurn, ...this.compactionKeep];
      this.sessionStore.saveHistory(this.conversationHistory);
      this.compactionKeep = null;
      this.promptBuilder.resetPromptState(); // New chat = re-send system prompt
      this.isProcessing = false;

      // Tell extension to start a new chat in the browser
      this.callbacks.sendToPanel({
        id: randomUUID(),
        type: 'new_chat',
        payload: {},
        timestamp: Date.now(),
      });

      this.callbacks.sendToPanel({
        id: randomUUID(),
        type: 'status',
        payload: { message: '✅ History compacted.' },
        timestamp: Date.now(),
      });
      return;
    }

    // Parse and strip tool calls from the response
    const { toolCalls, cleanContent } = this._extractToolCalls(content);

    // Show the response text (without tool call blocks) in the side panel
    if (cleanContent.trim()) {
      this.callbacks.sendToPanel({
        id: randomUUID(),
        type: 'agent_response',
        payload: { content: cleanContent.trim() },
        timestamp: Date.now(),
      });

      const agentTurn = {
        role: 'agent',
        content: cleanContent.trim(),
        timestamp: Date.now(),
      };
      this.conversationHistory.push(agentTurn);
      this.sessionStore.appendTurn(agentTurn);
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
        this.workspaceSummary = '';
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

      default:
        return { message: `Unknown command: /${command}. Available: /plan, /auto, /clear, /context, /compact, /undo, /workspace, /agent-dir` };
    }
  }

  // ── Private Methods ──────────────────────────────────────────────

  async _sendToGemini(prompt, callbacks) {
    // Create a promise that will be resolved when we get the Gemini response
    this.pendingGeminiResponse = true;

    callbacks.injectPrompt({
      prompt,
      expectResponse: true,
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
      const result = await this.mcpServer.executeTool(call.name, call.args, {
        editor: this.editor,
      });

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

    // Use String.prototype.replace to both extract valid tool calls and strip them from the output
    cleanContent = content.replace(TOOL_CALL_REGEX, (fullMatch, jsonGroup) => {
      try {
        const parsed = JSON.parse(jsonGroup.trim());
        if (parsed.name && parsed.args) {
          calls.push(parsed);
          return ''; // Valid tool call, strip it from the message
        }
      } catch (err) {
        console.warn('⚠️ Failed to parse potential tool call:', err.message);
      }
      return fullMatch; // Keep non-tool-calls in the message
    });

    // Fallback: If Gemini forgets the markdown backticks, look for raw JSON objects matching tool schema
    const rawJsonRegex = /\{\s*"name"\s*:\s*"[^"]+"\s*,\s*"args"\s*:\s*\{[\s\S]*?\}\s*\}/g;
    cleanContent = cleanContent.replace(rawJsonRegex, (match) => {
      try {
        const parsed = JSON.parse(match);
        if (parsed.name && parsed.args) {
          calls.push(parsed);
          return ''; // Strip valid unformatted tool call
        }
      } catch (err) {
        // Not valid JSON, ignore
      }
      return match;
    });

    return { toolCalls: calls, cleanContent: cleanContent.trim() };
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

    // Keep the last 5 turns, compact the rest
    const toCompact = this.conversationHistory.slice(0, -5);
    const toKeep = this.conversationHistory.slice(-5);

    this.isCompacting = true;
    this.compactionKeep = toKeep;

    const compactionPrompt = this.promptBuilder.buildCompactionPrompt(toCompact, focus);
    await this._sendToGemini(compactionPrompt, this.callbacks);

    return { message: '⏳ Compacting history with Gemini...' };
  }
}
