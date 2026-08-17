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
const TOOL_CALL_REGEX = /```(?:json|tool_call)?\n([\s\S]*?)\n```/g;

export class AgentLoop {
  constructor({ workspace, mcpServer, promptBuilder, diffEngine, riskClassifier, editor, configHome }) {
    this.workspace = workspace;
    this.mcpServer = mcpServer;
    this.promptBuilder = promptBuilder;
    this.diffEngine = diffEngine;
    this.riskClassifier = riskClassifier;
    this.editor = editor;
    this.configHome = configHome;

    // Storage & Context
    this.sessionStore = new SessionStore(workspace);
    this.contextManager = new ContextManager(workspace);

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

    // Check Auto-compaction
    if (this.contextManager.needsCompaction(this.conversationHistory)) {
      this.callbacks.sendToPanel({
        id: randomUUID(),
        type: 'status',
        payload: { message: '⚠️ Context size high. Auto-compacting...' },
        timestamp: Date.now(),
      });
      this.queuedUserMessage = content;
      await this._compactHistory('Auto compaction triggered to save tokens.');
      return;
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

      if (this.queuedUserMessage) {
        const msg = this.queuedUserMessage;
        this.queuedUserMessage = null;
        // Proceed with the original user request
        this.handleUserMessage(msg, this.callbacks);
      }

      return;
    }

    // Parse tool calls from the response
    const toolCalls = this._parseToolCalls(content);
    const cleanContent = this._stripToolCalls(content);

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
        return { message: '🧹 Conversation history cleared.' };

      case 'context':
        return this._getContextInfo();

      case 'compact': {
        const focus = args?.join(' ') || '';
        return await this._compactHistory(focus);
      }

      case 'undo': {
        const result = this.diffEngine.undo();
        return result;
      }

      case 'workspace':
        if (args?.[0]) {
          this.workspace = args[0];
          return { message: `📂 Workspace changed to: ${this.workspace}` };
        }
        return { message: `📂 Current workspace: ${this.workspace}` };

      default:
        return { message: `Unknown command: /${command}. Available: /plan, /auto, /clear, /context, /compact, /undo, /workspace` };
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
      
      const resultTurn = {
        role: 'system',
        type: 'tool_result',
        toolName: call.name,
        result: result.result || result.error,
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

  _parseToolCalls(content) {
    const calls = [];
    let match;

    TOOL_CALL_REGEX.lastIndex = 0;
    while ((match = TOOL_CALL_REGEX.exec(content)) !== null) {
      try {
        let jsonStr = match[1].trim();
        
        // Google's code-block DOM element sometimes includes the language label 
        // in its textContent. We strip it out if it accidentally gets included.
        if (jsonStr.toLowerCase().startsWith('json')) {
          jsonStr = jsonStr.substring(4).trim();
        }

        const parsed = JSON.parse(jsonStr);
        if (parsed.name && parsed.args) {
          calls.push(parsed);
        }
      } catch (err) {
        console.warn('⚠️ Failed to parse tool call:', match[1]);
      }
    }

    return calls;
  }

  _stripToolCalls(content) {
    return content.replace(TOOL_CALL_REGEX, '').trim();
  }

  _getContextInfo() {
    const historyTokenEstimate = this.contextManager 
      ? import('./context/TokenCounter.js').then(m => m.TokenCounter.estimateHistoryTokens(this.conversationHistory)) 
      : 0; // Token counting is now offloaded, but we can do a rough fallback:
    
    // For synchronous stats, we'll just require TokenCounter directly since it's ES module, 
    // wait I didn't import TokenCounter at the top. I'll just use the old fallback for synchronous display.
    const syncTokenEstimate = this.conversationHistory.reduce((sum, turn) => {
      const text = turn.content || JSON.stringify(turn.result || turn.args || '');
      return sum + Math.ceil(text.length / 4);
    }, 0);

    return {
      mode: this.mode,
      conversationTurns: this.conversationHistory.length,
      estimatedTokens: syncTokenEstimate,
      pendingDiffs: this.diffEngine.getPendingDiffs().length,
      appliedDiffs: this.diffEngine.appliedDiffs.length,
      workspace: this.workspace,
    };
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
