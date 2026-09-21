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
 * How many times to ask the model to fix its own tool-call JSON.
 *
 * Every other retry path here is capped — provider errors above, the
 * unsubmitted-prompt resend and tool redeclaration at one shot each. This one
 * was not, so a model stuck on a formatting habit re-asked forever, a full
 * browser turn each round, and only the user could stop it.
 */
const MAX_PARSE_RETRIES = 2;

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
import { auditHandover, describeFindings, countChecklist, hasHandoverBlock } from './handover-audit.js';
import { compactHistory } from './compaction.js';
import { runSubAgentSession } from './subagent-session.js';
import { MUTATING_TOOLS, SHELL_TOOLS } from './tool-catalog.js';
import { resolveEffort, effortFromConfig } from './effort.js';
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
import { requiresApproval, isBlockedOutright } from './tool-policy.js';
import { LOOP_TOOLS, dispatchLoopTool } from './loop-tools.js';
import { resolveDiff } from './diff-approval.js';


// Backstop for a prompt the extension never answers. Longer than the content
// script's own 5-minute cap so its `timedOut` report wins whenever it is alive.
const EXTENSION_RESPONSE_TIMEOUT = 7 * 60 * 1000;

/**
 * Evidence that an unparseable block was *meant* to be a tool call.
 *
 * The contract renders every call as an object with a `name`, so the key is the
 * one thing a mangled attempt still carries. It gates nothing that parses — a
 * block that is valid JSON is judged on whether it actually has a `name` — only
 * the decision to spend a repair round on a block that does not.
 *
 * There used to be a second `TOOL_CALL_REGEX` here, shadowed by the local one
 * inside `_extractToolCalls` and read by nothing. It had already drifted: it
 * lacked the `[ \t]*` that lets an indented fence match, so anyone fixing the
 * "regex at the top of the file" would have changed no behaviour at all.
 */
const LOOKS_LIKE_TOOL_CALL = /"\s*name\s*"\s*:/;


// Moved to core/artifact-guard.js — re-exported so the many call sites and
// `plan-mode-writes.test.js` keep importing it from here.
export { isAgentArtifact } from './artifact-guard.js';


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

    /**
     * Resuming at launch is the same act as resuming from the picker.
     *
     * For a long time it was a different, smaller one. This branch called the
     * *storage* method and stopped — so `--resume` and `--continue` restored
     * `history.jsonl` and nothing else: `chatThread` stayed null, no
     * `open_thread` reached the browser, and `pendingRecap` was never set. The
     * transcript came back, the tab opened a brand-new conversation, and the
     * model was told nothing about either. That is precisely the failure
     * `chat-thread.js` was written to prevent — a model answering confidently
     * about work it never did — arrived at through the one door that skipped it.
     *
     * `resumeSessionById` already does all four halves, and its own comment
     * warns why: *"Two copies of 'restore a conversation' is how one of them
     * ends up forgetting."* It was lifted out for the panel and the CLI picker;
     * the launch flags were the copy left behind. They cannot simply call it
     * here, because there is no WebSocket server yet and nothing to send
     * `open_thread` to — hence the flag, drained when an extension identifies.
     */
    if (resumeSessionId) {
      // Named explicitly, so it becomes the current conversation.
      this.sessionStore.resumeSession(resumeSessionId);
      this._resumeOnConnect = true;
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
    } else {
      // `--continue`. Nothing is filed and nothing is cleared, so the history
      // is already the right one — but the browser still has to be pointed back
      // at the thread it was on, which is the half that was missing.
      this._resumeOnConnect = true;
    }

    // State defaults
    this.mode = 'plan'; // 'plan' | 'auto'
    this.modelConfig = {
      main: 'gemini',
      /*
        * On. A subagent is a second tab of the same model with an empty
        * context, which is the only thing this architecture can fan out to.
        *
        * This was `reviewer: <model>`, whose presence stood for the topology —
        * a knob describing a two-model world that no longer exists. One toggle
        * now, and nothing derived from it that could disagree with it.
        */
      subagents: true,
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

    /**
     * Which browser conversation this history belongs to.
     *
     * Read here rather than left undefined until the first reply, because
     * `_recordThread` only learns the thread *from* a reply — and on a resumed
     * session the whole question is what the tab should be pointed at before
     * one is asked for. `session-meta.json` has held it all along; nothing read
     * it at startup.
     *
     * Only when resuming. A fresh session that adopted the filed session's
     * thread would reopen a conversation the user just chose to leave.
     */
    this.chatThread = this._resumeOnConnect
      ? (this.sessionStore.getThread?.() || null)
      : null;
    this.pendingGeminiResponse = null;
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
      /**
       * What this turn has actually done, for the model to read back.
       *
       * The handover block asks it to report what it ran and whose callers it
       * checked, and nothing ever compared the answer to anything — so a model
       * out of budget could satisfy the checklist with prose, which is cheaper
       * than a tool call and indistinguishable on screen. This is the cheap
       * half of the cure: derived, never declared, and in front of the model
       * *before* it writes the claim rather than after.
       */
      this._turnEvidence = new Map();
      // The handover rides the round that first changes something — see
      // `_dueHandover`. One per user turn, not one per round.
      this._handoverSent = false;
      this._resentUnsubmittedOnce = false;
      // Auto-heal budget, per user turn.
      this._failedRounds = 0;
      this._roundsThisTurn = 0;
      this._providerRetries = 0;

      // Build the full prompt
      const prompt = this.promptBuilder.buildPrompt({
        userMessage: content,
        mode: this.mode,
        subagents: this.subagentsEnabled,
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
      // Reset on a parse rather than per user turn: a model that formats one
      // call correctly has not "used up" anything, and the failure this caps
      // is a *run* of malformed replies, not a tally across the session.
      this._parseRetries = 0;

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
      this._parseRetries = (this._parseRetries || 0) + 1;
      logError(this.workspace, {
        flow: 'agent', op: 'parse_tool_calls',
        message: `Malformed tool call: ${err.message}`,
        detail: content?.slice(0, 1500),
        // The attempt number is what turns "this happens" into "this happens
        // and the model never recovers", which are different problems.
        meta: { attempt: this._parseRetries },
      });

      /**
       * Give up asking, and hand the reply over instead.
       *
       * The raw text almost always contains the answer in prose — the model
       * knew what to do and could not wrap it in JSON. Re-asking a third time
       * costs another full browser turn to get the same malformed reply, and
       * the turn is already lost; showing the text is the only thing left that
       * can still be useful to the person waiting.
       */
      if (this._parseRetries > MAX_PARSE_RETRIES) {
        this._parseRetries = 0;
        this.isProcessing = false;
        this._releaseExtension();
        const answer = (cleanContent || content || '').trim();
        this.callbacks.sendToPanel({
          id: randomUUID(),
          type: 'agent_response',
          payload: {
            message: '⚠️ **The model could not format a tool call** after '
              + `${MAX_PARSE_RETRIES + 1} attempts. Its reply is below, unchanged — `
              + 'it usually contains the answer in prose.\n\n'
              + (answer || '_It returned nothing readable._'),
          },
          timestamp: Date.now(),
        });
        return;
      }
      // A tool call the model could not format is the clearest signal its grip
      // on the instructions has slipped. Bring the reminder forward.
      this.promptBuilder.noteDrift();
      
      this.callbacks.sendToPanel({
        id: randomUUID(),
        type: 'status',
        payload: {
          message: `⚠️ Invalid JSON detected. Self-correcting (${this._parseRetries}/${MAX_PARSE_RETRIES})…`,
        },
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
          subagents: this.subagentsEnabled,
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
          subagents: this.subagentsEnabled,
          modelConfig: this.modelConfig,
          objective: this.currentObjective,
        }), this.callbacks);
        return;
      }
    }

    /**
     * A conclusion written before its own evidence is not shown.
     *
     * A tool call is a question. A handover block is "I am done". A reply
     * carrying both has concluded before the results exist, and the prose is
     * therefore about what the model expected to find rather than what it
     * found. Reported with screenshots: a `## Review` listing five **Verified
     * Files** — two of which did not exist, one in a directory deleted wholesale
     * in `e375aed` — landing above the `<tool_results>` that were meant to
     * support it, with an invented architecture attached.
     *
     * **The model had already been told.** Every tool-result turn ends with
     * *"Reply once, with exactly one of: the next tool call, or your final
     * answer to the user"*, and that is the turn this happened on. The prompt
     * rule in `tool-call-format-full.md` closes the same gap on turn 0 and is
     * the weaker half of this: an instruction can be ignored, and was. The loop
     * declining to print the conclusion cannot be.
     *
     * Detected on the handover block alone, not on length or tone. Ordinary
     * narration beside a tool call — "Let me look at the parser." — is correct
     * and common, and a heuristic that ate it would cost far more than this
     * buys. The block is the model's own unambiguous marker for a closing
     * report, which is why `_dueHandover` asks for one at the end of a turn.
     *
     * Withheld rather than rewritten: the text is logged whole, and the model
     * is told next turn to answer from the results. What reaches the user is
     * either evidence-backed or nothing.
     */
    const premature = toolCalls.length > 0 && hasHandoverBlock(cleanContent);
    if (premature) {
      this._withheldConclusion = true;
      logError(this.workspace, {
        flow: 'agent',
        op: 'premature_conclusion',
        message: `Withheld a handover block sent alongside ${toolCalls.length} `
          + `tool call${toolCalls.length === 1 ? '' : 's'}; it was written before the results`,
        detail: cleanContent.trim().slice(0, 1000),
      });
      this._notify('⏸ Held a conclusion that arrived with its own tool calls — re-asking after the results.');
    }

    // Show the response text (without tool call blocks) in the side panel
    if (cleanContent.trim() && !premature) {
      /**
       * The rung this reply was produced at.
       *
       * Nothing recorded it, and that made a whole class of question
       * unanswerable. "Does `deep`'s assumption ledger ever get written?" is
       * the cheap way to tell an instruction that works from one the model
       * ignores — and it needs to know which turns ran at `deep`. Measured
       * across 412 stored replies: zero ledgers, zero approach enumerations,
       * zero reviewer calls, against a working control of 8 handover blocks.
       * Suggestive of nothing, because the rung was not on the record.
       *
       * One field, written where the reply is. `/logs` and the archive both
       * carry it forward, so a week of ordinary use answers the question that
       * is currently being argued from prompt sizes.
       */
      const agentTurn = {
        role: 'agent',
        content: cleanContent.trim(),
        effort: this.modelConfig?.effort || null,
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
      // The turn is over, so its handover block can be checked against what it
      // actually did. Only here: mid-turn there is still work to come, and a
      // claim made in passing is not the closing report.
      this._auditHandover(cleanContent);
      // No tool calls — agent is done
      this.isProcessing = false;
      // Restore background callbacks so GitHub tasks still work
      if (this._backgroundCallbacks) {
        this.callbacks = this._backgroundCallbacks;
      }
    }
  }

  /**
   * Handle a response from a subagent — its own Gemini tab, its own lane.
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
      subagents: this.subagentsEnabled,
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

    const previous = this.chatThread;
    this.chatThread = thread;
    this.sessionStore?.setThread?.(thread);

    /**
     * A different conversation is a model that never saw the system prompt.
     *
     * `hasSeenSystemPrompt` is the *builder's* belief, and the model's memory
     * is the thread — the whole premise of `chat-thread.js`. Nothing connected
     * the two, so when the tab moved to another conversation (the user opening
     * a new chat, `ensureModelTab` opening one because the old tab was gone, a
     * reload landing on `/app` with no id) the builder carried on sending the
     * short turn: a bracketed context line and a list of tool *names*.
     *
     * The model then has names with no definitions and says so — "the tools
     * listed in your prompt are not actually connected to my execution
     * environment" — which costs a turn, and only recovers if
     * `looksLikeCapabilityDenial` happens to match that day's phrasing.
     * Prevention first; the detector is the backstop.
     *
     * Only when there *was* a previous thread. The first id of a session is
     * turn 0's own conversation, which already carried the full prompt, and
     * resetting there would send it twice.
     */
    if (previous?.id) this.promptBuilder?.resetPromptState?.();
  }

  /**
   * Compare the closing handover block to the turn's own record.
   *
   * Reports, never rewrites — the model's text has already reached the user
   * unchanged, and editing an agent's self-report to make it accurate leaves
   * nothing on screen that is the agent's own voice.
   *
   * One dim row, and an `op: 'handover_unsupported'` record so `/logs rates`
   * can answer **how often**. That number is the point: whether the review list
   * works is currently an opinion, and `channel-health.js` already exists to
   * turn this kind of opinion into a percentage. Read it before writing any
   * more prompt text.
   *
   * Never throws. It runs on the path that has just finished a turn, and a
   * failure to audit must not be a failure to answer.
   */
  _auditHandover(reply) {
    try {
      let checklist = null;
      try {
        const file = paths.artifactPath(this.workspace, 'task.md');
        if (fs.existsSync(file)) checklist = countChecklist(fs.readFileSync(file, 'utf-8'));
      } catch { /* an unreadable artifact proves nothing either way */ }

      /*
       * The workspace is what makes a path claim checkable, and only the loop
       * knows it — `handover-audit.js` stays pure so a test can hand it a set.
       *
       * Resolved against the workspace and refused if it escapes: the model
       * supplies these strings, and `../../../etc/passwd` is a path that very
       * much exists. A claim that points outside the workspace is not one this
       * can honestly confirm, so it counts as unverified rather than true.
       */
      const exists = (rel) => {
        try {
          const abs = path.resolve(this.workspace, rel);
          const root = path.resolve(this.workspace);
          if (abs !== root && !abs.startsWith(root + path.sep)) return false;
          return fs.existsSync(abs);
        } catch { return false; }
      };

      const { findings } = auditHandover(reply, {
        evidence: this._turnEvidence, checklist, exists,
      });
      if (!findings.length) return;

      logError(this.workspace, {
        flow: 'agent',
        op: 'handover_unsupported',
        message: findings.map((f) => `${f.claim}: ${f.because}`).join('; '),
        detail: findings.map((f) => `${f.claim}: ${f.said}`).join('\n').slice(0, 500),
      });

      const row = describeFindings(findings);
      if (!row) return;
      const note = { role: 'system', content: row, timestamp: Date.now() };
      this.conversationHistory.push(note);
      this.callbacks?.sendToPanel?.({
        id: randomUUID(),
        type: 'status',
        payload: { message: row },
        timestamp: Date.now(),
      });
    } catch { /* never let the audit break the turn it is auditing */ }
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
        // `topology` used to be stored beside `modelConfig` and could
        // contradict it. Folded into the one thing left to decide.
        // `topology` and `reviewer` are both gone. Duo meant "a second tab
        // reviews", which is now one of three roles on one tool, so a stored
        // duo folds to subagents-on and single to nothing — single never meant
        // "no subagents", it meant "no reviewer", and `ask_researcher` and
        // `ask_subagent` were offered either way.
        if (data.topology === 'duo' || data.modelConfig?.reviewer) {
          this.modelConfig.subagents = true;
        }
        if (typeof data.modelConfig?.subagents === 'boolean') {
          this.modelConfig.subagents = data.modelConfig.subagents;
        }
        delete this.modelConfig.reviewer;
        /**
         * Fold a config written when ChatGPT was a model.
         *
         * `_saveConfig` preserves keys it does not own — that was a bug fix,
         * and it means a stored `main: 'chatgpt'` survives every save and
         * sends the agent at a site with no bridge. Read from `data` (what is
         * on disk) rather than the merged object, or the default would shadow
         * the legacy key — the mistake `config-merge.test.js` covers for
         * effort.
         */
        if (data.modelConfig?.main && data.modelConfig.main !== 'gemini') {
          this.modelConfig.main = 'gemini';
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
      // `topology` is not written: it was derived, and
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
  /**
   * What has run this turn, as `name×n` pairs in call order.
   *
   * Tool names rather than categories like "3 reads". The handover block asks
   * about specific acts — did you run it, did you check the callers — and a
   * category mapping is one more place for the answer to drift from the
   * question. `find_references×0` is not listed; absence is the claim.
   */
  get turnEvidence() {
    const tally = this._turnEvidence;
    if (!tally?.size) return '';
    return [...tally].map(([name, n]) => (n === 1 ? name : `${name}×${n}`)).join(', ');
  }

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
  noteModelOptions(models, switchedTo, requested = null) {
    if (!Array.isArray(models)) return;
    this.modelOptions = models;

    /*
     * `switchedTo` is what the picker *reads* after the click, not what was
     * asked for — so this can say whether it landed instead of assuming.
     *
     * It used to echo the request, which is why the CLI followed every switch
     * with "check the Gemini tab's picker before you send anything — the picker
     * is the only proof it landed". The proof was already coming back and was
     * being discarded, so the user was asked to do a job the system had the
     * answer to.
     */
    if (requested) {
      const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
      // `✓` and `!` rather than emoji, which is what every other row in this
      // transcript uses for the same two meanings.
      this._notify(same(switchedTo, requested)
        ? `✓ Browser model is now ${switchedTo}.`
        : `! Browser model is still ${switchedTo || 'unknown'} — asked for ${requested}.`
          + `\n  Change it by hand in the Gemini tab (ctrl+b opens it). `
          + 'The prompt here already changed.');
      return;
    }

    if (switchedTo) {
      this._notify(`✓ Browser model switched to ${switchedTo}.`);
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
   * Ask the browser for a fresh conversation, and wait to hear that it worked.
   *
   * The old `/new` broadcast `new_chat` straight from the UI hook, which is
   * why only the terminal could do it. Routed through the loop, both
   * front-ends reach the same thing.
   *
   * It resolves rather than rejects, and resolves `false` on a timeout, because
   * both callers have to keep going either way — `/new` has already cleared the
   * transcript, and `_compactHistory` has already summarised. What the answer
   * changes is what they say and where they send the next prompt, which is
   * exactly the decision a rejection would take away.
   *
   * @returns {Promise<boolean>} whether a tab was told to start one
   */
  startNewChat({ timeoutMs = 5000 } = {}) {
    const previous = this.chatThread;
    this.chatThread = null;
    // The thread we are leaving. `_recordThread` only ever overwrites, so
    // without this the conversation that was just handed over has no address —
    // and a handover you cannot look back from is a reset with a nicer name.
    if (previous?.id) this.previousThread = previous;

    /*
     * And the disk follows, now, rather than when the next reply lands.
     *
     * `setThread(null)` is a no-op by design, `_recordThread` only fires on a
     * reply, and a brand-new chat has no id until its first exchange — so
     * between here and that reply, memory said "no thread" while
     * `session-meta.json` still named the one we just abandoned. Both resume
     * paths read the disk. A process that ended in that window came back and
     * reopened the conversation the user had just walked away from, and because
     * the ids matched, `planResume` answered `continue` and suppressed the recap
     * as well.
     *
     * Before the handover is attempted, not after: if this dies mid-way the
     * safe answer is "we do not know where we are", not a stale id.
     */
    this.sessionStore?.clearThread?.(previous);

    // A second request supersedes the first, which is then answered `false`
    // rather than left pending. A promise nobody ever settles is the hang this
    // whole ack exists to remove, and adding one here would be a poor joke.
    this._pendingNewChat?.done(false);

    return new Promise((resolve) => {
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this._pendingNewChat?.done === done) this._pendingNewChat = null;
        resolve(ok);
      };
      // Deliberately NOT unref'd. This timer is the only thing that settles the
      // promise when the browser never answers, so letting the process treat it
      // as optional means the wait never ends — the hang the ack exists to
      // remove, reintroduced by the ack. Caught by the test below.
      const timer = setTimeout(() => done(false), timeoutMs);
      this._pendingNewChat = { done };
      this._toExtension('new_chat');
    });
  }

  /** The extension answering `new_chat`. An unmatched ack is ignored, not thrown. */
  handleChatStarted(payload) {
    this._pendingNewChat?.done(Boolean(payload?.ok));
  }

  requestModelOptions() {
    this._toExtension('discover_models');
  }

  /** Bring the model's own tab to the front. ctrl+b. */
  focusModelTab() {
    this._toExtension('focus_tab', { targetModel: this.mainModel });
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

  /**
   * The handover review, once, on the round that has earned it.
   *
   * It used to ride the opening prompt — 1,879 characters of "check your work
   * before you say you are finished", delivered before the turn had done
   * anything, and then thousands of tokens behind the model by the time it
   * mattered. Same failure the tool anchor exists for, and the same cure: put
   * the instruction where it applies rather than saying it louder up front.
   *
   * **Gated on evidence, not on the rung alone.** A turn that answered a
   * question has nothing to review, and asking it to file a handover produces
   * the empty ceremony already seen in use — `Checklist: 0/0 done (Resetting
   * state)`, `Ran: N/A`, `Callers checked: 0`. So it goes out on the first
   * round where the turn has actually changed something.
   *
   * Once per turn: repeating it on every later round is the large repeated
   * payload this project's whole prompt strategy exists to avoid.
   */
  _dueHandover() {
    if (this._handoverSent) return '';
    // The same set plan mode gates on: a turn that started a background
    // process has changed something, whatever it does next.
    const changed = [...MUTATING_TOOLS].some((t) => (this._turnEvidence?.get(t) || 0) > 0);
    if (!changed) return '';

    const block = this.promptBuilder.buildHandoverBlock?.(this.modelConfig?.effort) || '';
    if (block) this._handoverSent = true;
    return block;
  }

  /** The model the main conversation runs on. Subagents name their own. */
  get mainModel() {
    return this.modelConfig.main || 'gemini';
  }

  /**
   * Whether this session can fan work out to parallel tabs of itself.
   *
   * Derived rather than stored. As a knob of its own it could disagree with
   * the thing it describes: duo with no reviewer configured advertised
   * `ask_reviewer` to the model with nowhere to send it, and single with a
   * reviewer configured left a second tab wired up and never used.
   *
   * It used to also require `reviewer !== mainModel`, because the extension
   * addressed tabs by URL pattern and two same-model requests raced for one
   * tab. Tab identity landed in the bridge — a subagent turn opens its *own*
   * tab on a `sub:<requestId>` lane and closes it after — so that clause was
   * guarding something that had already been fixed. With ChatGPT removed it
   * would also mean no reviewer at all.
   *
   * What a second Gemini tab buys is **not** different weights. It is a reader
   * with no memory of the conversation that produced the work, which is the
   * half that matters for the failure this exists to catch: a model that reads
   * enough to cite and then reasons from the citation. A cold reader has
   * nothing to reason from but the file, so it opens the file.
   */
  get subagentsEnabled() {
    // Absent means on. A config written before the toggle existed had three
    // subagent tools available, so reading it as "off" would silently take a
    // capability away from every existing workspace.
    return this.modelConfig.subagents !== false;
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

  /**
   * Reopen a past conversation — the state here, and the memory in the browser.
   *
   * Two halves, and only the first is obvious. `history.jsonl` is the *human's*
   * record; the model's memory is the chat thread in the tab, and Gemini keeps
   * that thread's identity in the URL. So restoring the transcript alone hands
   * the model a conversation it has never seen and asks it to carry on — the
   * exact failure `chat-thread.js` exists to prevent.
   *
   * Pointing the tab back at `/app/<id>` gives it the real history, including
   * everything a summary would have dropped. The recap is the fallback for a
   * session that never reached a thread, and `thread_opened` moves us onto that
   * fallback if the browser could not get there.
   *
   * Lifted out of the panel's `resume_session` handler so the CLI's `/history`
   * runs the same code. Two copies of "restore a conversation" is how one of
   * them ends up forgetting to file what is on screen.
   *
   * @returns {{ok: boolean, message: string, turns?: object[]}}
   */
  resumeSessionById(id) {
    const store = this.sessionStore;
    const record = (store?.listSessions?.() || []).find((r) => r.id === id);

    // File what is on screen now, or resuming destroys it — the mistake that
    // made `--sessions` useless in the first place.
    store?.rollover?.();
    const turns = store?.resumeSession?.(id);
    if (!turns) return { ok: false, message: `No session ${id}.` };

    this.conversationHistory = turns;
    this.promptBuilder?.resetPromptState?.();
    this.chatThread = record?.thread || null;

    if (record?.thread?.id) {
      this._toExtension('open_thread', { thread: record.thread });
      if (this.promptBuilder) this.promptBuilder.pendingRecap = null;
      return { ok: true, turns, message: 'Resumed — pointing the tab back at that conversation.' };
    }

    if (this.promptBuilder) this.promptBuilder.pendingRecap = turns;
    return {
      ok: true,
      turns,
      message: 'Resumed. That conversation never reached a browser thread, '
        + 'so the next message carries a recap instead.',
    };
  }

  /**
   * The launch-time half of `resumeSessionById`, run when a browser shows up.
   *
   * `--resume` and `--continue` are decided in the constructor, where there is
   * no WebSocket server and therefore nowhere to send `open_thread`. So the
   * constructor records the intent and this drains it from the one event that
   * means a browser is listening: a client identifying as an extension.
   *
   * It must be **exactly one of** two outcomes, never neither — which is what
   * the launch path did. Either the tab goes back to `/app/<id>`, where the
   * model has the real history including everything a summary would drop, or
   * the next prompt carries `<resumed_conversation>`. A failure to navigate is
   * caught by `thread_opened`, which falls back to the recap.
   *
   * Idempotent: the flag is cleared on the first drain, because the extension
   * reconnects freely and reopening the thread mid-session would throw away
   * whatever the tab had moved on to.
   *
   * @returns {'thread'|'recap'|null} what it armed, for the caller to log
   */
  resumeThreadOnConnect() {
    if (!this._resumeOnConnect) return null;

    // Held, not cleared, when there is no way to speak yet: `_toExtension`
    // writes to whichever callbacks exist and silently drops the message when
    // neither does, which is how `_notify` used to lose the same class of
    // message. The next identify tries again.
    if (!this.callbacks && !this._backgroundCallbacks) return null;

    this._resumeOnConnect = false;

    // Nothing to resume into. Saying "resumed" about an empty transcript would
    // point the tab at an old conversation for no reason.
    if (!this.conversationHistory?.length) return null;

    if (this.chatThread?.id) {
      this._toExtension('open_thread', { thread: this.chatThread });
      return 'thread';
    }

    if (this.promptBuilder) this.promptBuilder.pendingRecap = this.conversationHistory;
    return 'recap';
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
      const isParallel = call.name === 'ask_subagent';

      // Counted where they are dispatched, not where they succeed: "I ran the
      // tests and they failed" is a true claim, and a tally that only counted
      // successes would call it unsupported.
      if (!this._turnEvidence) this._turnEvidence = new Map();
      this._turnEvidence.set(call.name, (this._turnEvidence.get(call.name) || 0) + 1);

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
      // Who may run what is `core/tool-policy.js`, not this function. It was
      // decided inline here, in the middle of dispatch, which is how
      // `run_background` came to skip plan mode's approval entirely.
      const needsApproval = requiresApproval(call, { mode: this.mode, risk, workspace: this.workspace });

      // Execute the tool
      let result;
      
      if (isBlockedOutright(call, risk)) {
        result = { success: false, error: `❌ Command blocked by Security Constraints: ${risk.reason}` };
        // Blocked commands are the most worth recording, not the least: what the
        // agent *tried* to do is the interesting half of an audit log.
        logCommand(this.workspace, {
          command: call.args.command, cwd: call.args.cwd || this.workspace,
          outcome: 'blocked', reason: risk.reason, risk: risk.level,
        });
      } else if (SHELL_TOOLS.has(call.name)) {
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
      } else if (LOOP_TOOLS.has(call.name)) {
        // The three the loop answers itself — `core/loop-tools.js`. Which three
        // is the catalog's `dispatch: 'loop'`, not a list repeated here.
        result = await dispatchLoopTool(this, call);
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
        // A subagent that answered in prose rather than calling `return_result`.
        // The answer is used either way; this keeps the record of which ones
        // arrived that way, so the row can eventually say so.
        ...(result.unstructured ? { unstructured: true } : {}),
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

      // The edit is still only a diff at this point — `core/diff-approval.js`
      // is what decides, applies and corrects all three records of it.
      if (result.success && (call.name === 'edit_file' || call.name === 'create_file')) {
        toolResults[i] = await resolveDiff(this, {
          call, diffResult: result.result, needsApproval, risk, resultTurn,
        });
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
    /*
     * If a conclusion was withheld, say so where the evidence now is. Without
     * this the model has no idea its answer never landed, and simply repeats it.
     */
    const withheld = this._withheldConclusion
      ? 'Your previous reply concluded while still calling tools, so it was not shown to the '
        + 'user. Answer now from the results below, and cite only what they contain.'
      : '';
    this._withheldConclusion = false;

    this._sendToGemini(
      this.promptBuilder.buildToolResultBatch(
        toolResults, this.turnEvidence, this._dueHandover(), withheld,
      ),
      this.callbacks,
    );
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
    //
    // The language tag is **captured**, not discarded, and that is the whole
    // fix for 2026-09-20. An *untagged* fence matches here — Gemini writes one
    // whenever it shows the user a block that is not code, and labels it
    // "Plaintext" in its own UI — so the only thing standing between prose and
    // `JSON.parse` was that the body starts with `[` or `{` and ends with `]`
    // or `}`. Asked to design a reminder, the model answered with:
    //
    //     [SYSTEM REMINDER: You are in PRO effort tier. …]
    //
    //     User Request: {user_input}
    //
    // which satisfies both ends, threw `Unexpected token 'S'`, and — because
    // the throw is inside this callback — **discarded the entire reply**,
    // correct prose and all. The loop then told the model to "fix the JSON
    // formatting of your tool calls", about a tool call it had never made.
    // Models comply with false premises: it invented one, and the turn became
    // an investigation of a question that had already been answered.
    const TOOL_CALL_REGEX = /```(json|tool_call)?[ \t]*\n\s*(?:json\s*|tool_call\s*)?([{\[][\s\S]*?[}\]])\s*\n[ \t]*```/gi;
    cleanContent = cleanContent.replace(TOOL_CALL_REGEX, (fullMatch, tag, jsonGroup) => {
      let parsed;
      try {
        const cleaned = this._cleanJsonString(jsonGroup.trim());
        parsed = JSON.parse(cleaned);
      } catch (err) {
        /*
         * An untagged fence is prose until it says otherwise.
         *
         * ```json is a claim — the model named the format and got it wrong, so
         * a repair round is the right answer and the old behaviour stands. A
         * bare fence claims nothing, so the only evidence that a call was
         * *meant* is the one key the contract requires. Without it, leaving the
         * block where the model put it costs nothing; parsing it costs the
         * turn.
         */
        if (!tag && !LOOKS_LIKE_TOOL_CALL.test(jsonGroup)) return fullMatch;
        throw new Error(`Failed to parse JSON block: ${err.message}\nRaw block: ${jsonGroup}`);
      }

      const items = Array.isArray(parsed) ? parsed : [parsed];
      let taken = 0;
      for (const item of items) {
        if (item && item.name) {
          const validated = toolSchema.safeParse(item);
          if (!validated.success) {
            throw new Error(`Schema validation failed: ${validated.error.message}\nItem: ${JSON.stringify(item)}`);
          }
          calls.push(validated.data);
          taken++;
        }
      }
      /*
       * A block that held no call is the user's to read.
       *
       * This returned `''` unconditionally, so a model answering "your config
       * should be:" followed by valid JSON had the answer deleted out of its
       * own reply — parsed, found to contain no `name`, and dropped anyway.
       * Only a block that actually became a call has earned its removal.
       */
      return taken > 0 ? '' : fullMatch;
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

  /** @see core/subagent-session.js — one subagent turn, in its own tab. */
  async _runSubAgentSession(role, prompt, targetModel) {
    return runSubAgentSession(this, role, prompt, targetModel);
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

  /** @see core/compaction.js — summarise the older turns and hand the thread over. */
  async _compactHistory(focus) {
    return compactHistory(this, focus);
  }

}
