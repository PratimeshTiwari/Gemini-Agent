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
import { describeInstructionSources } from './instruction-sources.js';
import { logCommand } from './command-log.js';

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

/**
 * How many tool rounds one user turn may take, succeeding or not.
 *
 * `MAX_FAILED_ROUNDS` bounds the loop that is going wrong. Nothing bounded the
 * loop that is going *right*: a model that keeps returning a valid tool call
 * runs until it stops choosing to, and a scripted one returning `read_file`
 * forever managed **750 rounds in 40 seconds**. Against a real browser that is
 * the user's Gemini quota and a burnt chat tab before they can reach escape.
 *
 * The comment on the failing bound reasons that "progress resets it, so a long
 * run that keeps succeeding never trips" — treating unboundedness as the
 * feature. But a turn that succeeds seven hundred times has not made progress,
 * it has made seven hundred round trips, and each one is a prompt typed into a
 * browser.
 *
 * Thirty is well past any real task — the deepest genuine turns here run to
 * about a dozen — and far short of a runaway. It is a stop, not a verdict: the
 * turn ends and says where it got to, and you can tell it to carry on.
 */
const MAX_ROUNDS_PER_TURN = 30;

/** The first useful line of a failed tool result, for the give-up message. */
function oneLineError(result) {
  if (typeof result === 'string') return result.split('\n')[0].slice(0, 160);
  const text = result?.stderr || result?.error || result?.stdout || '';
  const line = String(text).split('\n').find((l) => l.trim()) || 'no output';
  return line.slice(0, 160);
}
import * as paths from './paths.js';
import { threadFromUrl } from './chat-thread.js';
import { resolveEffort, effortFromConfig } from './effort.js';
import { normalizeQuestionSet } from './question.js';
import { planModelSwitch } from './model-match.js';
import { archiveTurns } from './session-recall.js';
import { handleSlashCommand as runSlashCommand } from './slash-commands.js';
import { stripImageData } from './prompt-builder.js';
import { validateWorkspace } from './workspaces.js';
import { z } from 'zod';
import { SessionStore } from '../storage/session-store.js';
import { ContextManager } from '../context/context-manager.js';
import { MemoryManager } from '../context/memory-manager.js';
import { ExtensionLock, mainLane, subLane } from '../bridge/extension-lock.js';
import { runBatchTask } from './turn-runner.js';


// Backstop for a prompt the extension never answers. Longer than the content
// script's own 5-minute cap so its `timedOut` report wins whenever it is alive.
const EXTENSION_RESPONSE_TIMEOUT = 7 * 60 * 1000;

// Regex to extract tool calls from Gemini's response (handles json code blocks)
const TOOL_CALL_REGEX = /```(?:json|tool_call)?\n\s*(?:json\s*|tool_call\s*)?([{\[][\s\S]*?[}\]])\s*\n```/gi;

/**
 * What a headless background turn is told it can call.
 *
 * Deliberately a *subset* — five read-only tools and `ask_subagent` — and in a
 * different shape from the interactive prompt, because a GitHub PR turn is
 * gathering context for a plan rather than editing anything. It also carries a
 * correction the full definitions do not ("use `pattern` NOT `query`"), earned
 * from watching this path get it wrong.
 *
 * So it is not generated from `core/tool-catalog.js`, and generating it would
 * change what this agent is told. What it *is* checked against is membership:
 * `tool-catalog.test.js` asserts every name below exists and is dispatchable,
 * which is the half that went wrong elsewhere — the system prompt asked for
 * `write_to_file` by name for weeks and no such tool has ever existed.
 *
 * Module scope rather than a local const so that test can read it at all.
 */
export const HEADLESS_SYSTEM_PROMPT = `You are a headless background agent running inside the user's code workspace.
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

export class AgentLoop {
  constructor({ workspace, mcpServer, promptBuilder, diffEngine, riskClassifier, editor, configHome, continueSession = false, resumeSessionId = null, agentSourceDir, taskManager }) {
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

    if (resumeSessionId) {
      // Named explicitly, so it becomes the current conversation.
      this.sessionStore.resumeSession(resumeSessionId);
    } else if (!continueSession) {
      // File the old one before starting fresh. It used to be wiped outright,
      // which is why `--sessions` had nothing to list and `--resume` had
      // nothing to find: every conversation was destroyed by the start of the
      // next one.
      //
      // The id is kept so the UI can say it *once*, on the run where it is
      // useful. A conversation that is filed silently is one nobody knows to
      // ask for — the storage, the flags and the picker were all built and
      // nothing ever mentioned that a session had been put somewhere.
      const filedId = this.sessionStore.rollover();
      this.sessionStore.clear();
      if (filedId) {
        const record = this.sessionStore.listSessions().find((r) => r.id === filedId);
        this.filedSession = record || { id: filedId };
      }
    }

    // State defaults
    this.mode = 'plan'; // 'plan' | 'auto'
    this.modelConfig = {
      main: 'gemini',
      // No reviewer is what makes the topology single. It used to be its own
      // setting, so "duo" could be on with nowhere to route a review to, and
      // "single" could be on while a reviewer sat configured and unused.
      reviewer: null,
      effort: 'standard' // one of core/effort.js's five rungs
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
    // One in-flight prompt per model, not one for the whole bridge — see
    // bridge/extension-lock.js.
    this.extensionLock = new ExtensionLock({
      send: (payload) => this.callbacks?.injectPrompt?.(payload),
      onStall: (lane, model) => this._onExtensionStall(lane, model),
      timeoutMs: EXTENSION_RESPONSE_TIMEOUT,
    });
    this.pendingSubagents = new Map(); // requestId -> { resolve, reject, targetModel }

    // Characters the browser thread is actually holding.
    //
    // The estimate used to be built from `conversationHistory`, which is only
    // the *user and agent messages we kept a copy of*. What the tab holds is
    // everything ever typed into it — the system prompt, 1,575 tokens of tool
    // definitions, AGENT.md, memory, skills, every tool result fed back — and
    // none of that was counted, so a session reading "~200 tokens" had sent
    // twenty thousand. Counted where it crosses the bridge, which is the only
    // place that cannot be wrong about it.
    this.contextChars = 0;
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
    // `contextTokens`, not `conversationHistory`. This read the history array
    // for as long as it existed; `Number([…])` is NaN, `NaN > x` is false, and
    // so auto-compaction never once ran. The count is what the browser tab is
    // actually carrying — the system prompt and every tool result included —
    // which is what `needsCompaction`'s own doc asks for.
    if (!this.isCompacting && this.contextManager.needsCompaction(this.contextTokens, this.contextLimit)) {
      this.callbacks.sendToPanel({
        id: randomUUID(),
        type: 'status',
        payload: { message: '⏳ Context limit reached. Auto-compacting older history in background...' },
        timestamp: Date.now(),
      });
      // Runs alongside the turn, but its report is not thrown away.
      //
      // This was fire-and-forget, and `_compactHistory` *returns* the account
      // of what it did — how many turns went, whether the model summarised them
      // or the local fallback did, and the before/after size. Discarding it left
      // auto-compaction entirely silent: the notice above is a transient status
      // that the thinking-message cycle overwrites before it paints, so the
      // user's history would be rewritten underneath them with no trace at all.
      // Which is the same silence as it never running, and is why nobody
      // noticed that it never ran.
      this._compactHistory()
        .then((result) => {
          if (!result?.message) return;
          const note = {
            role: 'assistant',
            content: `🗜️ **Context was auto-compacted.**\n\n${result.message}`,
            timestamp: Date.now(),
          };
          this.conversationHistory.push(note);
          this.sessionStore.appendTurn(note);
        })
        .catch(err => {
          logError(this.workspace, {
            flow: 'agent', op: 'auto_compact',
            message: `Auto-compaction failed: ${err.message}`, detail: err.stack,
          });
          this._notify(`⚠️ Auto-compaction failed: ${err.message}`);
        });
    }

    try {
      // The image goes to the bridge, never into the record. `/image` inlines
      // the whole file as a base64 data URL so the content script can rebuild
      // it as a real File and paste it — but stored verbatim that put ~1.4x the
      // file's bytes into conversationHistory, into history.jsonl *twice*
      // (local and home), into every compaction prompt, and into currentObjective,
      // which is what a provider-error retry re-sends. One screenshot poisoned
      // the rest of the session.
      const remembered = stripImageData(content);
      const turn = {
        role: 'user',
        content: remembered,
        timestamp: Date.now(),
      };
      this.conversationHistory.push(turn);
      this.sessionStore.appendTurn(turn);

      // Retries re-send this. The attachment is already in the browser's own
      // conversation by then, so re-pasting it would duplicate the upload.
      this.currentObjective = remembered;
      // One tool-amnesia retry per user turn; see handleGeminiResponse.
      this._deniedToolsOnce = false;
      this._resentUnsubmittedOnce = false;
      // Auto-heal budget, per user turn.
      this._failedRounds = 0;
      this._roundsThisTurn = 0;
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
      logError(this.workspace, {
        flow: 'agent', op: 'handle_user_message',
        message: err.message, detail: err.stack,
      });
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

    // Before anything else, and before the stale-response guard below: which
    // conversation answered is worth knowing even when the reply itself is no
    // longer wanted. Subagent tabs are disposable, so only the main lane's
    // thread is the session's.
    if (!isSubagent) this._recordThread(payload.tabUrl);

    // Allow subagent responses through even when main agent isn't processing —
    // background GitHub tasks use _executeSubagent without setting isProcessing.
    if (!this.isProcessing && !isSubagent) {
      logError(this.workspace, {
        flow: 'agent', op: 'stale_response',
        message: 'Response arrived after the turn had stopped',
      });
      this._releaseExtension();
      return;
    }

    if (!this.callbacks && this._backgroundCallbacks) {
      this.callbacks = this._backgroundCallbacks;
    }
    if (!this.callbacks) {
      logError(this.workspace, {
        flow: 'agent', op: 'no_callbacks',
        message: 'Response arrived with no callbacks registered',
      });
      return;
    }

    if (isSubagent) {
      if (complete) {
        // The subagent's own lane, which is its own tab. Released by request
        // id rather than by model: the user's turn is in a different tab on
        // the same site, and freeing the model would free that too.
        this.handleSubagentResponse(requestId, content, payload.subagentUrl);
        this._releaseExtension(subLane(requestId));
      }
      return;
    }

    if (!complete) {
      if (payload.timedOut) {
        /**
         * The one timeout it is *safe* to retry: the prompt was never sent.
         *
         * The content script can tell the difference, and the difference is
         * the whole question. If it saw Gemini generating, the model has an
         * answer we failed to read — resending would ask it twice and the
         * second answer would arrive into a conversation that already
         * contains the first. If it never saw generation start and scraped
         * nothing, the submit itself did not happen: the model has no idea
         * this turn exists, so sending it is not a repeat, it is the first
         * attempt actually landing.
         *
         * Once, and only for the user's own turn. If the submit fails twice
         * the composer or the send button has changed, and the diagnosis
         * `describeScrapeFailure` writes is more use than a third try.
         */
        if (payload.neverSubmitted && !this._resentUnsubmittedOnce && this._lastMainPrompt) {
          this._resentUnsubmittedOnce = true;
          logError(this.workspace, {
            flow: 'agent', op: 'resend_unsubmitted',
            message: 'The prompt never reached the composer; sending it again',
            detail: String(payload.content || '').slice(0, 300),
          });
          this.callbacks.sendToPanel({
            id: randomUUID(),
            type: 'status',
            payload: { message: '↻ The prompt never reached the tab — sending it again...' },
            timestamp: Date.now(),
          });
          // Straight back onto the lane, not through `_sendToGemini`: the
          // characters were counted when it was first built, and the tab
          // never received them, so counting them twice would overstate the
          // browser thread by a whole prompt.
          this._releaseExtension();
          this.pendingGeminiResponse = true;
          this._enqueueExtensionRequest({
            prompt: this._lastMainPrompt,
            expectResponse: true,
            targetModel: this.modelConfig.main || 'gemini',
          });
          return;
        }

        logError(this.workspace, {
          flow: 'agent', op: 'response_timeout',
          message: 'The browser tab stopped streaming before the reply finished',
        });
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
    this.contextChars += (content || '').length;
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
        // Logged because the other two detectors are and this one was not, so
        // there was no evidence it had ever fired — which is exactly the state
        // in which you cannot tell a detector that works from one that does
        // nothing. `/logs agent` answers it now.
        logError(this.workspace, {
          flow: 'agent', op: 'multiple_drafts',
          message: cleanContent.trim().slice(0, 200),
        });
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
        this.promptBuilder.requestToolRedeclaration(); // definitions only, not a whole turn-0 prompt

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
      this._sendTaskList();
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
      logError(this.workspace, {
        flow: 'agent', op: 'unknown_subagent',
        message: `Subagent reply for an unknown requestId: ${requestId}`,
      });
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
    this._resentUnsubmittedOnce = false;
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
   * Slash commands live in ./slash-commands.js. Kept as a method because
   * every caller in the UI reaches for it here, and moving the call sites
   * would be a second change riding on a move.
   */
  async handleSlashCommand(command, args) {
    return runSlashCommand(this, command, args);
  }

  // ── Private Methods ──────────────────────────────────────────────

  /**
   * @param {string|Array<{question: string, answer: string}>} answer - a bare
   *   answer, or one entry per question when the model asked a batch.
   */
  /**
   * Push the checklist to the side panel.
   *
   * The terminal reads `.agent/artifacts/task.md` off disk on a timer. The
   * panel cannot — it is a browser page — so the one surface that *can* read
   * the file has to hand it over. Without this the panel is the only place the
   * agent's own plan is invisible, which is the half of the feature the user
   * is actually meant to watch.
   *
   * Sent at turn boundaries rather than on a timer: ticking happens inside a
   * turn, and the file is small, so the end of a turn is both when it has
   * changed and when nothing else is competing for the socket.
   *
   * Silent when there is no list. An empty row is worse than no row — it reads
   * as "the agent has no plan" when it means "the agent did not write one".
   */
  /**
   * Remember which browser conversation answered.
   *
   * The model's memory is the chat thread, not `history.jsonl` — so this is
   * what makes "can this session be resumed?" answerable at all. Recorded on
   * every reply because a *new* chat has no id until its first exchange: the
   * id appears partway through, and the last one seen is the one that holds
   * the conversation.
   */
  _recordThread(url) {
    const thread = threadFromUrl(url);
    if (!thread?.id) return;
    if (this.chatThread?.id === thread.id) return;
    this.chatThread = thread;
    this.sessionStore?.setThread?.(thread);
  }

  _sendTaskList() {
    let body = '';
    try {
      const file = paths.artifactPath(this.workspace, 'task.md');
      if (fs.existsSync(file)) body = fs.readFileSync(file, 'utf-8').trim();
    } catch {
      return; // an unreadable artifact must not disturb a finished turn
    }
    if (!body) return;

    const items = body.split('\n')
      .map((l) => l.match(/^\s*[-*]\s*\[([ xX])\]\s*(.*)$/))
      .filter(Boolean)
      .map((m) => ({ done: m[1].toLowerCase() === 'x', text: m[2].trim() }));
    if (items.length === 0) return;

    this.callbacks?.sendToPanel?.({
      id: randomUUID(),
      type: 'task_list',
      payload: {
        items,
        done: items.filter((i) => i.done).length,
        total: items.length,
        path: paths.artifactPath(this.workspace, 'task.md'),
      },
      timestamp: Date.now(),
    });
  }

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
        if (data.modelConfig) {
          // modelTier / reasoningLevel / reasoningEffort collapse into one rung.
          // Folded on read rather than written back, so an older build sharing
          // the same config keeps working off the keys it understands.
          // Folded from what is *on disk*, not from the merge: the default
          // modelConfig already carries `effort: 'standard'`, and merging first
          // let that default shadow the legacy keys it was supposed to read —
          // so every pre-/effort config resolved to standard whatever it said.
          const merged = { ...this.modelConfig, ...data.modelConfig };
          merged.effort = effortFromConfig(data.modelConfig);
          delete merged.modelTier;
          delete merged.reasoningLevel;
          delete merged.reasoningEffort;
          this.modelConfig = merged;
        }
        if (data.commandRules) this.commandRules = { ...this.commandRules, ...data.commandRules };
        // Read by the banner and, since it had no writer, settable only by
        // editing this file by hand. `/name` writes it now.
        if (typeof data.agentName === 'string') this.agentName = data.agentName;
        if (Array.isArray(data.skillFolders)) this.skillFolders = data.skillFolders;
        // `topology` used to be stored beside `modelConfig` and could contradict
        // it. Folded into the one thing it was ever describing: is there a
        // second model to review with?
        if (data.topology === 'single') {
          this.modelConfig.reviewer = null;
        } else if (data.topology === 'duo' && !this.modelConfig.reviewer) {
          this.modelConfig.reviewer = this.mainModel === 'gemini' ? 'chatgpt' : 'gemini';
        }
        // The memory toggle used to live only in the MemoryManager instance, so
        // /memory off lasted until you quit. PromptBuilder reads the same key
        // off disk when it decides whether to recall anything.
        if (typeof data.memoryEnabled === 'boolean' && this.memoryManager) {
          this.memoryManager.memoryEnabled = data.memoryEnabled;
        }
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
      // `topology` is not written: it is derived from modelConfig.reviewer, and
      // a derived value in a config file is one someone will edit and be
      // ignored for editing.
      const { topology: _dropped, ...rest } = existing;

      /**
       * `agentName` is written only when this loop actually has one.
       *
       * Writing it unconditionally destroyed it: a caller that saves without
       * having loaded — and the partial fakes in the tests are exactly that —
       * has `undefined` here, which would replace a name set by hand with
       * nothing. That is the fault this whole merge exists to prevent, so it
       * has to hold for the key that prompted the merge in the first place.
       *
       * Empty string is the *clear* signal, since `undefined` already means
       * "no opinion": `/name default` sets it, and the key is dropped.
       */
      if (this.agentName === '') delete rest.agentName;
      const named = this.agentName ? { agentName: this.agentName } : {};

      fs.writeFileSync(configPath, JSON.stringify({
        ...rest,
        modelConfig: this.modelConfig,
        commandRules: this.commandRules,
        skillFolders: this.skillFolders,
        memoryEnabled: this.memoryManager ? this.memoryManager.memoryEnabled : true,
        ...named,
      }, null, 2));
    } catch (err) {
      logError(this.workspace, {
        flow: 'agent', op: 'save_config',
        message: `Failed to save config: ${err.message}`, detail: err.stack,
      });
    }
  }


  /**
   * Roughly how many tokens the browser thread is carrying.
   *
   * Everything typed into the tab and everything scraped back, not just the
   * turns we kept — see `contextChars`. Four characters per token is the same
   * approximation `TokenCounter` uses; the point of this number is "am I near
   * the wall", and a better tokenizer would not change that answer.
   */
  get contextTokens() {
    return Math.round(this.contextChars / 4);
  }

  /**
   * The budget the active rung is working to.
   *
   * Derived, not stored. `ContextManager.maxTokens` was a field set once from
   * the *default* rung, with a comment claiming it was replaced per turn —
   * nothing replaced it, so the compaction threshold ignored `/effort` entirely
   * and the flash rung's 24k budget was never in force. Deriving it is the same
   * call phase 6 made about `topology`: a value that has to track another is
   * read, not kept.
   */
  get contextLimit() {
    return resolveEffort(this.modelConfig?.effort).contextBudget;
  }

  /**
   * What the browser's mode picker is offering, as last reported.
   *
   * Null until the extension has looked. That distinction matters: "no list yet"
   * and "a list with nothing suitable in it" call for different things to be
   * said, and `planModelSwitch` tells them apart.
   */
  noteModelOptions(models, switchedTo) {
    if (!Array.isArray(models)) return;
    this.modelOptions = models;
    if (switchedTo) {
      this._notify(`🔀 Browser mode switched to ${switchedTo}.`);
      return;
    }

    // A rung asked for a switch before the list existed. Finish it now rather
    // than making the user run `/effort` twice to get what they asked for the
    // first time — which is indistinguishable from it not working.
    const wanted = this._pendingEffortSwitch;
    this._pendingEffortSwitch = null;
    if (!wanted) return;

    const plan = planModelSwitch(wanted, models);
    if (plan.action === 'switch') this.switchModelTo(plan.model.label);
  }

  /**
   * Ask the browser what it is offering. Cheap, and safe to repeat.
   *
   * Not through `injectPrompt`, which wraps everything as `inject_prompt` and
   * takes the extension lane — this is a question about the page, not a turn.
   * `sendToPanel` broadcasts verbatim, and takes the background callbacks
   * because a slash command runs outside a turn, where `this.callbacks` is null.
   */
  _toExtension(type, payload = {}) {
    const target = this.callbacks || this._backgroundCallbacks;
    target?.sendToPanel?.({ id: randomUUID(), type, payload, timestamp: Date.now() });
  }

  /**
   * Ask the browser for a fresh conversation.
   *
   * The old `/new` broadcast `new_chat` straight from the UI hook, which is
   * why only the terminal could do it. Routed through the loop, both
   * front-ends reach the same thing.
   */
  startNewChat() {
    this.chatThread = null;
    this._toExtension('new_chat');
  }

  requestModelOptions() {
    this._toExtension('discover_models');
  }

  /**
   * Ask the browser to select one, by the label it reported.
   *
   * `sessionId` names a batch task's own tab. Without it this goes to the main
   * lane — the tab the user is looking at — which is correct for `/effort` and
   * wrong for anything running in the background: a task raising its own
   * effort would change the model the person is talking to.
   */
  switchModelTo(label, sessionId = null) {
    if (label) this._toExtension('switch_model', { label, ...(sessionId ? { sessionId } : {}) });
  }

  /**
   * Start the running total again, after the thread has been replaced.
   *
   * `contextChars` counts everything ever typed into the browser tab, which is
   * why it is the honest measure — but compaction throws that thread away and
   * starts a new one from the summary. Carrying the old total past that would
   * leave the agent believing it was still full and compacting forever.
   *
   * This was **called and never defined**. `_compactHistory` therefore threw
   * `this._resetContextCount is not a function` at the very end — after it had
   * already rewritten `conversationHistory` and saved it — so the history was
   * compacted, the count was not reset, and the report of what happened was
   * never returned. `/compact` failed the same way for any conversation long
   * enough to get past its `length <= 5` early return, which is every
   * conversation worth compacting.
   *
   * It survived because the auto path swallowed the rejection into a log nobody
   * reads, and the auto path could not fire at all — the two bugs hid each
   * other.
   */
  _resetContextCount(chars) {
    this.contextChars = Math.max(0, Number(chars) || 0);
  }

  /** The model the main conversation runs on. Subagents name their own. */
  get mainModel() {
    return this.modelConfig.main || 'gemini';
  }

  /**
   * Solo, or a reviewer on the other model.
   *
   * Derived rather than stored. As a knob of its own it could disagree with
   * the thing it describes: duo with no reviewer configured advertised
   * `ask_reviewer` to the model with nowhere to send it, and single with a
   * reviewer configured left a second tab wired up and never used. A review by
   * the same model is not offered — same blind spots review nothing — so
   * "is there another model?" is the whole question.
   */
  get topology() {
    const reviewer = this.modelConfig.reviewer;
    return reviewer && reviewer !== this.mainModel ? 'duo' : 'single';
  }

  _enqueueExtensionRequest(payload) {
    this.extensionLock.enqueue(payload);
  }

  /**
   * Hand a model's tab back so the next prompt for it can go.
   *
   * Takes the model rather than guessing it: the lock is per lane now, and
   * releasing the wrong one leaves the right one wedged for the rest of the
   * session with later prompts vanishing into it silently.
   */
  _releaseExtension(lane = mainLane(this.mainModel)) {
    this.extensionLock.release(lane);
  }

  /**
   * Give up on everything in flight and drop what was queued behind it.
   * Used when a turn dies rather than completes — an injection error, a user
   * stop, an exception while building the prompt. The queued prompts belong to
   * that dead turn, so replaying them would be wrong.
   */
  abortExtensionWork() {
    this.extensionLock.abortAll();
    this.pendingGeminiResponse = null;
  }

  /**
   * The content script gives up after RESPONSE_MAX_TIMEOUT (5 min) and reports
   * `timedOut`. This is the backstop for when it never gets the message at all
   * — an asleep service worker, a tab with no bridge — where nothing would come
   * back and the CLI would sit on "Thinking..." forever.
   */
  /**
   * A tab went quiet past the timeout.
   *
   * Which tab matters now that lanes are tabs. A stalled **subagent** is one
   * background turn failing: its own tab, its own lane, and the caller is a
   * promise waiting for an answer. Killing `isProcessing` and aborting every
   * lane — which is what this did when there was one lane per model — would
   * take the user's turn down with it, in a different tab, for something they
   * never asked for. So the subagent is failed and only its lane released.
   *
   * A stalled **main** lane is the user's own turn, and that is still the loud
   * case: say so, stop, and drop what was queued behind it.
   */
  _onExtensionStall(lane, model) {
    const tab = model || this.mainModel;
    logError(this.workspace, {
      flow: 'agent', op: 'extension_stall',
      message: `No response from the ${tab} tab; releasing it`, meta: { model: tab, lane },
    });

    if (String(lane).startsWith('sub:')) {
      const requestId = String(lane).slice('sub:'.length);
      const pending = this.pendingSubagents.get(requestId);
      if (pending) {
        this.pendingSubagents.delete(requestId);
        pending.resolve({ success: false, error: `The ${tab} tab stopped responding.` });
      }
      this._releaseExtension(lane);
      return;
    }

    this.isProcessing = false;
    if (this.callbacks) {
      this.callbacks.sendToPanel({
        id: randomUUID(),
        type: 'error',
        payload: {
          message:
            `No response from the ${tab} tab. Check that the extension is loaded `
            + 'and that tab is open, then try again.',
        },
        timestamp: Date.now(),
      });
    }
    this.abortExtensionWork();
  }

  async _sendToGemini(prompt, callbacks) {
    // Create a promise that will be resolved when we get the Gemini response
    this.pendingGeminiResponse = true;
    this.contextChars += prompt.length;

    /**
     * Kept verbatim, because a resend cannot be a rebuild.
     *
     * `buildPrompt` has side effects — it marks the system prompt as seen and
     * resets the refresh counter. If turn 0 never reached the tab, rebuilding
     * would produce the *short* turn, and the model would be handed a bare
     * question with no tools and no framing. The bytes that were meant to go
     * are the bytes to send again.
     */
    this._lastMainPrompt = prompt;

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
        // Blocked commands are the most worth recording, not the least: what the
        // agent *tried* to do is the interesting half of an audit log.
        logCommand(this.workspace, {
          command: call.args.command, cwd: call.args.cwd || this.workspace,
          outcome: 'blocked', reason: risk.reason, risk: risk.level,
        });
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
          // A command that *succeeded* is the one worth auditing — `git push
          // --force` does not fail, so the failure log never sees it.
          logCommand(this.workspace, {
            command: commandToRun, cwd: call.args.cwd || this.workspace,
            outcome: 'ran', risk: risk.level,
            exitCode: result?.result?.exitCode,
          });
        } else {
          result = result || { success: false, error: 'User rejected command execution.' };
          logCommand(this.workspace, {
            command: commandToRun, cwd: call.args.cwd || this.workspace,
            outcome: 'rejected', reason: result?.error, risk: risk.level,
          });
        }
      } else if (call.name === 'ask_question') {
        result = await new Promise((resolve) => {
          this.pendingQuestionResolve = resolve;
          /**
           * Normalised here, once, rather than by each front-end.
           *
           * These args are parsed out of model prose, so nothing in them is
           * guaranteed: options arrive as strings, as `{label, description}`,
           * as a single string instead of an array, or not at all. The
           * terminal has cleaned that up on arrival since `question.js` was
           * written — the side panel could not, because it cannot import
           * server code, so it would have needed its own copy of the rules and
           * they would have drifted.
           *
           * It matters more than tidiness: the loop is parked on
           * `pendingQuestionResolve` until something is chosen, so a surface
           * that renders a malformed payload as an unanswerable picker hangs
           * the turn outright.
           *
           * `normalizeQuestionSet` is idempotent, so the terminal running it
           * again on receipt costs nothing and needed no change.
           */
          const questions = normalizeQuestionSet({
            question: call.args.question,
            options: call.args.options,
            header: call.args.header,
            questions: call.args.questions,
          });
          this.callbacks.sendToPanel({
            id: randomUUID(),
            type: 'ask_question',
            // The single-question fields ride along too: the terminal reads
            // `questions` and anything older reads the flat shape.
            payload: {
              question: questions[0].question,
              options: questions[0].options,
              header: questions[0].header,
              questions,
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
          if (!this.memoryManager.isMemoryEnabled()) {
            // Said plainly, because "failed" made the model retry the same
            // call. Memory being off is a decision, not a transient error.
            result = { result: 'Memory is turned off for this workspace (`/memory on` re-enables it). Nothing was stored.' };
          } else {
            const added = this.memoryManager.addMemory(call.args.fact);
            result = { result: added ? `Remembered: ${call.args.fact}` : 'Already remembered — nothing to do.' };
          }
          this.promptBuilder?.resetPromptState?.();
        } else if (call.args.action === 'remove') {
          const which = call.args.index ?? call.args.position;
          const removed = this.memoryManager.removeMemory(which);
          result = removed
            ? { result: `Forgot #${which}.` }
            : { error: `No memory at #${which}. The numbers are the ones in <memory>; re-read them before removing.` };
          this.promptBuilder?.resetPromptState?.();
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

    // Every round, not only the failing ones. See MAX_ROUNDS_PER_TURN.
    this._roundsThisTurn = (this._roundsThisTurn || 0) + 1;
    if (this._roundsThisTurn >= MAX_ROUNDS_PER_TURN) {
      this._roundsThisTurn = 0;
      logError(this.workspace, {
        flow: 'agent', op: 'round_limit',
        message: `Stopped a turn at ${MAX_ROUNDS_PER_TURN} tool rounds`,
        meta: { lastTools: toolResults.map((r) => r?.name).filter(Boolean) },
      });

      const stopTurn = {
        role: 'assistant',
        isLocal: true,
        content: `🛑 Stopped after ${MAX_ROUNDS_PER_TURN} rounds of tool calls in one turn.\n\n`
          + 'Nothing failed — it simply kept going, and every round is a prompt typed '
          + 'into your browser. The work so far is done and on disk.\n\n'
          + 'Say "continue" to carry on from here, or tell me what to do differently.',
        timestamp: Date.now(),
      };
      this.conversationHistory.push(stopTurn);
      this.sessionStore.appendTurn(stopTurn);

      // Ended the same way the failing-rounds cap ends one: the turn is over,
      // the UI is told, and the browser lane is handed back.
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

    // First try the standard markdown regex for speed and to remove backticks cleanly.
    // `[ \t]*` before the closing fence because a fence is indented whenever it
    // sits inside a list item, which the model does unprompted ("1. Run this:"
    // followed by the block). Without it the clean path misses and the
    // brace-matching fallback below picks the call up instead — it finds the
    // JSON, but it cannot know the backticks around it were part of the same
    // thing, so the bare fence is left behind in the visible reply.
    const TOOL_CALL_REGEX = /```(?:json|tool_call)?[ \t]*\n\s*(?:json\s*|tool_call\s*)?([{\[][\s\S]*?[}\]])\s*\n[ \t]*```/gi;
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

  /**
   * One turn in a background tab.
   *
   * `session` makes the tab outlive the turn: the extension keeps it for that
   * session id, so the next turn finds its own conversation still there and
   * only has to send what is new. Without it every turn gets a fresh tab, which
   * is right for a one-shot subagent and wrong for a ten-turn batch task.
   *
   * `continuing` says the prompt is incremental. The extension refuses it if
   * the session's tab is gone rather than quietly opening a new one — an
   * incremental prompt in an empty conversation gets a confident answer to a
   * question the model never saw.
   */
  async _executeSubagent(targetModel, prompt, { session = null, continuing = false } = {}) {
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      this.pendingSubagents.set(requestId, { resolve, reject, targetModel });

      // Subagents also run for /compact and background GitHub work, neither of
      // which has a user turn's callbacks attached.
      this._notify(`🤖 [${targetModel}] Thinking...`);

      this._enqueueExtensionRequest({
        prompt,
        expectResponse: true,
        targetModel,
        requestId,
        isSubagent: true,
        ...(session ? { sessionId: session, continuing } : {}),
      });
      
      // Safety timeout (5 minutes)
      setTimeout(() => {
        if (this.pendingSubagents.has(requestId)) {
          this.pendingSubagents.delete(requestId);
          this._releaseExtension(subLane(requestId));
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

  /**
   * Run a batch task to completion, with no session and nobody waiting.
   *
   * The loop itself is `core/turn-runner.js` now: this is the wiring that says
   * where the model lives and what tools it may reach. Extracting it was
   * Extracting it was the GitHub restructure's hardest phase — it was a second
   * agent loop inside this one,
   * with its own dispatch, its own retry and no seam to test against.
   *
   * `_executeSubagent('gemini', …)` is still hard-coded rather than reading
   * `modelConfig`. Deliberate for now: every turn of a batch task opens a fresh
   * browser tab, and which model that is has never been exercised for anything
   * but Gemini. Left as it was rather than changed in a refactor.
   */
  /**
   * Settle a pending subagent turn from outside the normal response path.
   *
   * Used when the bridge learns the turn cannot happen at all — a batch
   * session whose tab was closed. The caller gets its answer and the lane is
   * released; without this the promise waits out its five-minute timeout while
   * the lane stays held.
   */
  resolveSubagent(requestId, outcome) {
    const pending = this.pendingSubagents.get(requestId);
    if (!pending) return false;
    this.pendingSubagents.delete(requestId);
    this._releaseExtension(subLane(requestId));
    pending.resolve(outcome);
    return true;
  }

  /**
   * Tell the extension a batch session is finished, so its tab can close.
   *
   * Best effort by design: a tab that is not closed is a stray tab, which is
   * untidy. Failing the task because the tidy-up failed would be worse.
   */
  _sendEndSession(sessionId) {
    try {
      const target = this.callbacks || this._backgroundCallbacks;
      target?.sendToPanel?.({
        id: randomUUID(),
        type: 'end_session',
        payload: { sessionId },
        timestamp: Date.now(),
      });
    } catch {
      /* the bridge is gone; the tab will be closed by the user or by Chrome */
    }
  }

  async runHeadlessTask(prompt, systemInstruction = null) {
    const system = systemInstruction
      ? `${HEADLESS_SYSTEM_PROMPT}\n\n## ADDITIONAL DIRECTIVE:\n${systemInstruction}`
      : HEADLESS_SYSTEM_PROMPT;

    // One tab for the whole task, so each turn sends only what is new. The id
    // is per task rather than per turn, which is the entire difference.
    const session = randomUUID();

    const outcome = await runBatchTask({
      system,
      user: prompt,
      send: (text, { continuing } = {}) =>
        this._executeSubagent('gemini', text, { session, continuing }),
      endSession: () => this.callbacks?.injectPrompt
        ? this._sendEndSession(session)
        : undefined,
      extractToolCalls: (content) => this._extractToolCalls(content),
      executeTool: (name, args) => this.mcpServer.executeTool(name, args, {
        editor: this.editor,
        taskManager: this.taskManager,
      }),
      runSubagent: (sub) => this._runSubAgentSession(
        'subagent',
        `[System: You are running in workspace root: ${this.workspace}. Use tools to explore.]\n\nUser Prompt: ${sub}`,
        'gemini',
      ),
      classifyRisk: (name, args) => this.riskClassifier.classify(name, args),
    });

    if (!outcome.success) return { success: false, error: outcome.error };
    return {
      success: true,
      result: `## 🧠 AI Context Analysis\n\n${outcome.result}`,
      turns: outcome.turns,
    };
  }

  /**
   * What is in the context window right now.
   *
   * Plain markdown, not a hand-drawn box. The box was built by padding strings
   * with `padEnd` — but those strings carried chalk's ANSI escapes and an emoji,
   * so the padding counted escape bytes and code units rather than the columns
   * the terminal actually draws. Every row came out a different width and the
   * right border zig-zagged. Nothing here needs to be aligned to a border that
   * cannot be aligned.
   */
  async _getContextInfo() {
    const used = this.contextTokens;
    const limit = this.contextLimit;
    const pct = Math.min(100, Math.round((used / limit) * 100));

    const turns = this.conversationHistory.length;
    const pending = this.diffEngine.getPendingDiffs().length;
    const applied = this.diffEngine.appliedDiffs.length;

    const rows = [
      ['Mode', this.mode === 'plan' ? 'plan — every edit needs approval' : 'auto — safe edits apply on their own'],
      ['Turns', `${turns}`],
      ['Tokens', `~${used.toLocaleString()} / ${limit.toLocaleString()}  (${pct}%)`
        + '   — everything sent to the tab, not just these turns'],
      ['Diffs', `${pending} pending · ${applied} applied`],
      ['Workspace', this.workspace],
    ];

    /**
     * What is in the window, *and* where it came from.
     *
     * The numbers above answer how much; these answer what. Until the Context
     * tab got them there was no answer anywhere in the product to "which files
     * is it reading?", and the consequence was not hypothetical: this repo's own
     * `AGENT.md` was the unedited stock template, going into every turn-0 prompt
     * as the project's context, with nothing able to say so.
     *
     * The same rows as the tab, from the same function — one report on two
     * surfaces rather than a second implementation that can disagree.
     */
    const sources = describeInstructionSources(this);

    // Bounded, and elided from the *left*.
    //
    // A label here is a path, and one long path would otherwise set the padding
    // for every row and push the states off the right-hand edge — the same
    // fault `describeSettings` had, where a row could outgrow the viewport. A
    // path's tail is the part that identifies it, so that is the half kept.
    const LABEL_MAX = 44;
    const fit = (label) => (label.length <= LABEL_MAX
      ? label
      : `…${label.slice(-(LABEL_MAX - 1))}`);
    const labels = sources.map((r) => fit(r.label));
    const width = Math.min(LABEL_MAX, Math.max(10, ...labels.map((l) => l.length)));

    // One row per source, one line per row. The detail truncates rather than
    // the label: you can lose the end of "looks like the unedited template — it
    // is being sent as your project context" and still know the file is a
    // template, but a truncated path names no file at all. Same order of
    // sacrifice `describeSettings` settled on.
    const LINE_MAX = 96;
    const sourceLines = sources.length
      ? ['', '', '**Feeding the prompt**', '', ...sources.map((r, i) => {
        const head = `  ${r.group.padEnd(9)} ${labels[i].padEnd(width)}  `;
        const detail = r.state === 'loaded' ? r.detail : `${r.state} — ${r.detail}`;
        const room = Math.max(12, LINE_MAX - head.length);
        return head + (detail.length <= room ? detail : `${detail.slice(0, room - 1)}…`);
      })]
      : [];

    return {
      message: `### 📊 Context\n\n`
        + rows.map(([k, v]) => `  ${k.padEnd(10)} ${v}`).join('\n')
        + sourceLines.join('\n')
        + `\n\n_\`/compact\` to summarise it · \`/clear\` to drop it · \`/open <path>\` to read one_`,
    };
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
      // Archive before the rewrite, not after: `saveHistory` overwrites both
      // copies of history.jsonl, so without this the turns being summarised are
      // gone from disk and not merely from the thread. `recall` searches what
      // lands here, which is the whole reason it can answer anything.
      archiveTurns(this.workspace, toCompact);

      this.conversationHistory = [compactedTurn, ...toKeep];
      this.sessionStore.saveHistory(this.conversationHistory);
      this.promptBuilder.resetPromptState();
      // The thread starts again from the summary, so the count does too.
      // Carrying the old total past this would leave the agent believing it was
      // still full and compacting forever.
      this._resetContextCount(
        this.conversationHistory.reduce((n, t) => n + (t.content?.length || 0), 0),
      );

      // Say what actually happened. "✅ History compacted." told the user
      // nothing — not how much went, not whether the model summarised it or the
      // deterministic fallback did, and not where the summary went.
      const approxTokens = (turns) => Math.round(
        turns.reduce((sum, t) => sum + ((t.content?.length || 0) / 4), 0),
      );
      const before = approxTokens([...toCompact, ...toKeep]);
      const after = this.contextTokens;
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
