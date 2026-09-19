/**
 * WebSocket Server
 *
 * Handles Chrome Extension connections and routes messages
 * between the extension (side panel / content script) and the agent loop.
 *
 * Message Protocol:
 * {
 *   "id": "uuid",
 *   "type": "user_message | inject_prompt | gemini_response | tool_call | tool_result |
 *            diff_request | diff_response | status | error | slash_command",
 *   "payload": { ... },
 *   "timestamp": 1234567890
 * }
 */

import { WebSocketServer as WS } from 'ws';
import { randomUUID } from 'crypto';
import { logTrace } from '../core/trace-log.js';
import { prepareWorkspaceSwitch, leaveWhenIdle, RESTART_EXIT_CODE } from '../core/restart.js';
import { canPickFolder, pickFolder } from '../core/folder-picker.js';
import { planResume } from '../core/chat-thread.js';
import { logError } from '../core/error-log.js';

/**
 * Loopback only. Not `localhost`, which resolves through the hosts file and has
 * been pointed elsewhere on machines with unusual DNS setups.
 */
const LOOPBACK = '127.0.0.1';

/**
 * How long a prompt held for an absent extension is still worth delivering.
 *
 * Tied to `EXTENSION_RESPONSE_TIMEOUT` in `core/agent-loop.js`: that is when
 * the lane's watchdog gives up on the turn, and a prompt delivered after it
 * would be typed into Gemini for a turn the loop has already abandoned.
 */
const INJECT_BUFFER_TTL_MS = 7 * 60 * 1000;

/** Enough for a stalled lane per model plus a subagent fan-out, not a backlog. */
const MAX_PENDING_INJECTS = 8;

/**
 * Who may open a socket here.
 *
 * A Chrome extension sends `chrome-extension://<id>`; Firefox sends
 * `moz-extension://`. A connection with *no* Origin is a non-browser client —
 * curl, a test, another process — and is allowed, because the browser is the
 * only thing that can be tricked into connecting on someone else's behalf. A
 * page on a website sends its own origin and is refused.
 */
const EXTENSION_ORIGIN = /^(chrome-extension|moz-extension|safari-web-extension):\/\//i;

export function isAllowedOrigin(origin) {
  if (!origin) return true;              // not a browser page
  return EXTENSION_ORIGIN.test(origin);
}

export class WebSocketServer {
  constructor({ port, agentLoop }) {
    this.port = port;
    this.agentLoop = agentLoop;
    this.wss = null;
    this.clients = new Map(); // id -> { ws, type, connectedAt }
    /**
     * Prompts that had nowhere to go, waiting for the extension to come back.
     *
     * `broadcast` returns whether it reached anyone and every caller ignored
     * it, so a prompt dispatched while the extension was away was written to
     * no sockets and dropped on the floor — the loop then sat on a busy lane
     * until the seven-minute watchdog. That is the other half of "the prompt
     * only sends when I open Chrome": the extension is evicted, the prompt is
     * discarded, and the turn is already lost by the time anyone notices.
     *
     * Held here rather than in `ExtensionLock` because the lock's job is
     * ordering turns, and this is about the transport being absent.
     */
    this.pendingInjects = [];

    // Always provide background callbacks so headless tasks
    // can use the extension bridge even when no user message is being processed.
    this._wireBackgroundCallbacks();
  }

  _wireBackgroundCallbacks() {
    const backgroundCallbacks = {
      sendToPanel: (msg) => this.broadcast('extension', msg),
      injectPrompt: (msg) => this.sendInjectPrompt(msg),
      // Background tasks have no one to ask. Reject rather than hang the loop
      // (the agent now awaits this decision) and rather than write unapproved edits.
      requestDiffApproval: (diff) =>
        this.agentLoop.handleDiffResponse(randomUUID(), { diffId: diff?.diffId, action: 'reject' }),
    };
    this.agentLoop.setBackgroundCallbacks(backgroundCallbacks);
  }

  /**
   * Start listening — on the loopback interface only, for the extension only.
   *
   * `new WS({ port })` binds to `::`, every interface. Verified, not assumed.
   * That put a socket on the office LAN, the café wifi and the hotel network
   * which accepts `user_message` and runs shell commands on this machine, with
   * no authentication of any kind. Two things close that, both free:
   *
   *  - `host: '127.0.0.1'` — nothing off this machine can reach it at all.
   *  - an Origin check — a *web page* in the user's own browser can open
   *    `ws://127.0.0.1:7777` and would arrive over loopback like anything else.
   *    Browsers cannot forge `Origin`, and the extension's is
   *    `chrome-extension://<id>`, so requiring that shuts the page out.
   *
   * What remains: another process running as the same user on this machine can
   * still connect. That needs a shared secret the extension can read, which
   * needs a setup step — noted in CLAUDE.md → What's next rather than guessed at.
   */
  async start() {
    return new Promise((resolve, reject) => {
      this.wss = new WS({
        port: this.port,
        host: LOOPBACK,
        verifyClient: ({ origin, req }, done) => {
          if (isAllowedOrigin(origin)) return done(true);
          logError(this.agentLoop?.workspace, {
            flow: 'bridge',
            op: 'rejected_origin',
            message: `Refused a connection from origin ${origin || '(none)'}`,
          });
          // 403, and say why: a silent drop here reads as "the bridge is down".
          done(false, 403, 'Only the Agent CLI browser extension may connect');
        },
      });

      this.wss.on('connection', (ws, req) => {
        this._handleConnection(ws, req);
      });

      this.wss.on('listening', () => {
        // When the socket opened, so the extension's arrival can be timed
        // against it. See `extensionConnectMs` below.
        this.listeningAt = Date.now();
        resolve();
      });

      this.wss.on('error', (err) => {
        reject(err);
      });
    });
  }

  async stop() {
    if (this.wss) {
      for (const [id, client] of this.clients) {
        client.ws.close(1000, 'Server shutting down');
      }
      this.wss.close();
    }
  }

  _handleConnection(ws, req) {
    const clientId = randomUUID();
    const clientInfo = {
      ws,
      type: 'unknown',
      connectedAt: Date.now(),
    };
    this.clients.set(clientId, clientInfo);

    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());
        await this._handleMessage(clientId, message);
      } catch (err) {
        logError(this.agentLoop?.workspace, {
          flow: 'bridge', op: 'handle_message',
          message: err.message, detail: err.stack, meta: { clientId },
        });
        this._send(ws, {
          id: randomUUID(),
          type: 'error',
          payload: { message: err.message },
          timestamp: Date.now(),
        });
      }
    });

    ws.on('close', (code, reason) => {
      this.clients.delete(clientId);
    });

    ws.on('error', (err) => {
      logError(this.agentLoop?.workspace, {
        flow: 'bridge', op: 'client_error',
        message: err.message, meta: { clientId },
      });
    });

    // Send welcome message
    this._send(ws, {
      id: randomUUID(),
      type: 'status',
      payload: {
        status: 'connected',
        clientId,
        workspace: this.agentLoop.workspace,
        mode: this.agentLoop.mode,
      },
      timestamp: Date.now(),
    });

    /**
     * Hand the panel the conversation it cannot read for itself.
     *
     * Reported as "I reopened the panel and the chat got cleared". It was
     * never cleared — `sessions/history.jsonl` has every turn, written twice
     * on every one. The panel is a browser page with no filesystem, so it
     * starts from an empty DOM and nothing ever offered it the record. Exactly
     * the shape the task list had.
     *
     * The **last** turns, not all of them: this is one message across a socket
     * into a page, and someone reopening a panel wants to see where they were,
     * not six weeks of history. The rest stays on disk for `/sessions`.
     *
     * Tool calls and results are dropped. They are a transcript of machinery,
     * they are the bulk of the bytes, and a restored view of them would be a
     * wall of JSON where a conversation should be.
     */
    this._sendHistory(ws);
  }

  /** The tail of this workspace's conversation, for a panel that just opened. */
  _sendHistory(ws) {
    const MAX_TURNS = 40;
    let turns = [];
    try {
      turns = this.agentLoop?.sessionStore?.loadHistory?.() || [];
    } catch {
      return; // a panel with no history is the ordinary first-run case
    }

    const shown = turns
      .filter((t) => (t.role === 'user' || t.role === 'assistant' || t.role === 'agent')
        && typeof t.content === 'string' && t.content.trim())
      .slice(-MAX_TURNS)
      .map((t) => ({ role: t.role === 'agent' ? 'assistant' : t.role, content: t.content }));
    if (shown.length === 0) return;

    this._send(ws, {
      id: randomUUID(),
      type: 'history',
      payload: { turns: shown, total: turns.length },
      timestamp: Date.now(),
    });
  }

  async _handleMessage(clientId, message) {
    const { id, type, payload } = message;
    const client = this.clients.get(clientId);

    if (!client) return;

    // Identify client type from first message
    if (payload?.clientType && client.type === 'unknown') {
      client.type = payload.clientType;

      // An extension arriving is the only thing that can drain prompts held
      // while it was gone. Done before the timing bookkeeping below so a
      // resumed turn is not waiting on it.
      if (client.type === 'extension') {
        const resumed = this.flushPendingInjects();
        if (resumed > 0) {
          logError(this.agentLoop?.workspace, {
            flow: 'bridge',
            op: 'inject_resumed',
            message: `Extension reconnected; re-sent ${resumed} prompt(s) held while it was away`,
          });
        }
      }

      /**
       * How long the extension took to notice this server, in milliseconds.
       *
       * Recorded because "the connection got slower" was reported from use and
       * could not be checked from inside the product. Measured in headless
       * Chrome the reconnect cadence is exactly 30.0s — `chrome.alarms` clamps
       * to a 30-second floor and the extension's backoff capped at exactly that
       * floor, so the whole ladder was a constant. Whether the fix for that
       * helps in a *real* browser is the number this row exists to answer.
       *
       * First extension only: later reconnects are a different question and
       * overwriting this would lose the startup figure, which is the one people
       * mean.
       */
      if (client.type === 'extension' && this.extensionConnectMs === undefined && this.listeningAt) {
        this.extensionConnectMs = Date.now() - this.listeningAt;
        if (this.agentLoop) this.agentLoop.extensionConnectMs = this.extensionConnectMs;
      }

      if (client.type === 'extension' && this.agentLoop) {
        // Ask what the mode picker is offering, now, so `/effort` has an answer
        // the first time it is used rather than spending that call discovering.
        // A beat, because the content script may still be mounting into the tab.
        setTimeout(() => this.agentLoop.requestModelOptions?.(), 1500);
      }
    }

    switch (type) {
      case 'user_message':
        // User typed a message in the side panel
        await this._handleUserMessage(clientId, id, payload);
        break;

      case 'gemini_response':
        // Content script extracted a Gemini response
        this.agentLoop.handleGeminiResponse(id, payload);
        break;

      case 'gemini_response_stream':
        // Content script sending partial/streaming response — forward to CLI
        if (this.agentLoop.callbacks) {
          this.agentLoop.callbacks.sendToPanel({
            id,
            type: 'response_stream',
            payload,
            timestamp: Date.now(),
          });
        }
        break;

      case 'turn_trace':
        // How long the browser spent on each stage of a *successful* turn. The
        // failure log has never had this, which is why "it got slower" was a
        // feeling rather than a number.
        logTrace(this.agentLoop?.workspace, payload);
        break;

      case 'model_options':
        // What the browser's mode picker is offering. Stored, not acted on:
        // `core/model-match.js` decides which one an effort rung wants, and the
        // names differ by subscription so they cannot be assumed.
        this.agentLoop.noteModelOptions(payload?.models, payload?.switchedTo, payload?.requested);
        break;

      /**
       * The side panel answering something the turn is blocked on.
       *
       * `ask_question` and a risky `run_command` both park the turn on an
       * unresolved promise (`pendingQuestionResolve` / `pendingCommandResolve`)
       * and send the prompt out through `sendToPanel`. The CLI draws those and
       * answers them; the panel had no way to, and no inbound type existed for
       * it either — so driving the agent from the panel hung on the first
       * question or first command approval, permanently, with the panel's send
       * button disabled behind `isWaitingForResponse`.
       *
       * The resolvers were already here and already careful (`cancelQuestion`
       * resolves rather than rejecting, because leaving it pending is the hang).
       * Only the way in was missing.
       */
      /**
       * The side panel choosing a workspace.
       *
       * Same act as `/workspace <path>` in the CLI, and deliberately the same
       * code: validation, the supervisor check and the handover file all live
       * in `core/restart.js` so the two front-ends cannot drift into
       * disagreeing about what a usable workspace is.
       *
       * It restarts rather than switching in place. Every collaborator keyed on
       * the workspace — the session store, memory, config, the command
       * allowlist — is rebuilt by a restart and was *not* rebuilt by the
       * in-place switch this replaced. The panel will see the socket drop and
       * come back, which is the honest signal that it really did change.
       */
      /**
       * The native folder chooser, opened from the side panel.
       *
       * A Chrome extension cannot open one — `<input webkitdirectory>` hands
       * back a *copy of the directory's contents*, never its path, which is the
       * only thing wanted here. But the agent runs on the same machine as the
       * browser, so the server can open the dialog the CLI already uses and
       * hand back what was chosen.
       *
       * The dialog blocks until the person is done, which is fine here: nothing
       * else is waiting on this message, and a picker that timed out mid-browse
       * would be worse than one that waits.
       */
      case 'pick_workspace': {
        if (!canPickFolder()) {
          this.broadcast('extension', {
            id: randomUUID(), type: 'error',
            payload: {
              op: 'pick_workspace', unavailable: true,
              message: 'No folder chooser on this machine — type the path instead.',
            },
            timestamp: Date.now(),
          });
          break;
        }
        const chosen = await pickFolder('Choose a workspace for the agent');
        // Cancelled. Saying nothing would read as a hung button.
        if (!chosen) {
          this.broadcast('extension', {
            id: randomUUID(), type: 'status',
            payload: { message: 'Workspace unchanged.' },
            timestamp: Date.now(),
          });
          break;
        }
        await this._handleMessage(clientId, { type: 'set_workspace', payload: { path: chosen } });
        break;
      }

      /**
       * Past conversations, for the side panel's picker.
       *
       * The storage and the CLI flags landed first and the panel had no way to
       * reach any of it — reported as "I reopened the sidebar and there is no
       * option to continue". A list nobody can open is the same as no list.
       */
      /**
       * A panel asking for the conversation, because it just opened.
       *
       * `_sendHistory` runs when the **socket** connects — and opening the side
       * panel does not reconnect it: the service worker holds one socket for
       * the life of the browser session, so a panel that opens afterwards is a
       * fresh page arriving in the middle of an existing connection and is
       * never told anything. Reported as "opening and closing the sidebar does
       * not persist the chat", which it looked like from the outside.
       *
       * So the panel asks rather than waiting to be told. The connect-time send
       * stays for the case where the panel is already open when the socket
       * comes up.
       */
      case 'get_history': {
        const client = this.clients.get(clientId);
        if (client) this._sendHistory(client.ws);
        break;
      }

      case 'list_sessions': {
        const store = this.agentLoop?.sessionStore;
        const live = this.agentLoop?.chatThread || null;
        const sessions = (store?.listSessions?.() || []).slice(0, 30).map((s) => ({
          ...s,
          // Said per row, before the choice is made, because the two are
          // different promises: one carries on, the other has to re-explain
          // itself to a model that was never there.
          resume: planResume(s.thread, live).action,
        }));
        this.broadcast('extension', {
          id: randomUUID(), type: 'sessions',
          payload: { sessions, thread: live },
          timestamp: Date.now(),
        });
        break;
      }

      case 'resume_session': {
        // The whole of this — file the current conversation, restore the old
        // one, and point the tab back at its thread — lives on the loop, so
        // the CLI's `/history` cannot drift from the panel's picker.
        const outcome = this.agentLoop.resumeSessionById(payload?.id);
        if (!outcome.ok) {
          this.broadcast('extension', {
            id: randomUUID(), type: 'error',
            payload: { op: 'resume_session', message: outcome.message },
            timestamp: Date.now(),
          });
          break;
        }

        this.broadcast('extension', {
          id: randomUUID(), type: 'session_reset',
          payload: { message: outcome.message },
          timestamp: Date.now(),
        });
        for (const client of this.clients.values()) this._sendHistory(client.ws);
        break;
      }

      /**
       * The browser saying whether it reached that conversation.
       *
       * If it could not, the recap becomes the fallback — otherwise the model
       * is handed a restored transcript it has no knowledge of and asked to
       * carry on, which is the exact failure the thread id exists to prevent.
       */
      /**
       * The browser answering `new_chat`.
       *
       * `/compact` is a handover: it summarises the old thread and sends the
       * summary into a new one. Without this the send is blind, and a new chat
       * that never happened means a full turn-0 payload plus a summary of
       * turns going into the thread that already holds them.
       */
      case 'chat_started':
        this.agentLoop.handleChatStarted?.(payload);
        break;

      case 'thread_opened':
        if (!payload?.ok) {
          this.agentLoop.promptBuilder.pendingRecap = this.agentLoop.conversationHistory;
          this.broadcast('extension', {
            id: randomUUID(), type: 'status',
            payload: { message: 'Could not reopen that conversation — sending a recap instead.' },
            timestamp: Date.now(),
          });
        }
        break;

      case 'set_workspace': {
        const outcome = prepareWorkspaceSwitch(payload?.path);
        if (!outcome.ok) {
          this.broadcast('extension', {
            id: randomUUID(), type: 'error',
            payload: { op: 'set_workspace', message: outcome.error },
            timestamp: Date.now(),
          });
          break;
        }
        this.broadcast('extension', {
          id: randomUUID(), type: 'status',
          payload: { message: `⟳ Restarting in ${outcome.target}…` },
          timestamp: Date.now(),
        });
        // Not out from under a running turn — the browser would keep generating
        // into a socket nobody is holding and the reply would never be drawn.
        leaveWhenIdle(RESTART_EXIT_CODE, { wsServer: this, agentLoop: this.agentLoop });
        break;
      }

      case 'question_response':
        if (payload?.cancelled) this.agentLoop.cancelQuestion();
        else this.agentLoop.answerQuestion(payload?.answer);
        break;

      case 'command_approval_response':
        this.agentLoop.answerCommandApproval(payload?.action, payload?.command);
        break;

      case 'diff_response':
        // User accepted/rejected a diff
        this.agentLoop.handleDiffResponse(id, payload);
        break;

      case 'slash_command':
        // User typed a slash command
        await this._handleSlashCommand(clientId, id, payload);
        break;

      case 'heartbeat':
        // Extension checking connection is alive
        this._send(client.ws, {
          id,
          type: 'heartbeat_ack',
          payload: { status: 'alive' },
          timestamp: Date.now(),
        });
        break;

      case 'error':
        // Written down before anything else. This is the only report we get
        // from inside the browser tab, and until now it was handled and thrown
        // away — a selector that changed on gemini.google.com looked, from the
        // terminal, like the agent simply going quiet.
        // Content scripts run in the page and cannot set fields on this
        // payload — it reaches here as a bare message — so they prefix the
        // stage in brackets and it is lifted back out into `op`. Without it a
        // changed selector on gemini.google.com arrived as "failed", which is
        // the one thing you already knew.
        const tagged = /^\[([a-z_]+)\]\s*/i.exec(payload?.message || '');
        logError(this.agentLoop?.workspace, {
          flow: 'extension',
          op: payload?.op || tagged?.[1] || payload?.stage || 'unknown',
          message: (payload?.message || payload?.error || 'Extension reported an error')
            .replace(/^\[[a-z_]+\]\s*/i, ''),
          detail: payload?.detail || payload?.stack,
          meta: { targetModel: payload?.targetModel, url: payload?.url, stage: payload?.stage },
        });
        /**
         * A lost batch session is recoverable, and must not kill the run.
         *
         * The extension refuses an incremental prompt when the tab holding a
         * task has been closed — rather than opening a fresh one, which would
         * get a confident answer to a question the model never saw. That is a
         * *request* failing, not the bridge failing, and `runBatchTask` answers
         * it by resending the whole history once. Falling through to
         * `abortExtensionWork()` here would take down the user's turn as well.
         */
        if (payload?.op === 'session_lost' && payload?.requestId) {
          this.agentLoop.resolveSubagent?.(payload.requestId, { sessionLost: true });
          break;
        }

        // The turn is dead, so hand the bridge lock back — otherwise every
        // later prompt queues behind a request that will never be answered.
        this.agentLoop.isProcessing = false;
        this.agentLoop.abortExtensionWork();
        if (this.agentLoop.callbacks) {
          this.agentLoop.callbacks.sendToPanel(message);
        }
        break;

      case 'identify':
        // Handled above to set client type, just break
        break;

      case 'tab_status':
        if (payload?.connectedModels && payload.connectedModels.length > 0) {
          if (!client.reportedModels || client.reportedModels.join() !== payload.connectedModels.join()) {
            client.reportedModels = payload.connectedModels;
          }
        }
        break;

      default:
        logError(this.agentLoop?.workspace, {
          flow: 'bridge', op: 'unknown_message',
          message: `Unknown message type: ${type}`,
        });
    }
  }

  async _handleUserMessage(clientId, messageId, payload) {
    const { content } = payload;
    const client = this.clients.get(clientId);
    if (!client) return;

    // Set up callbacks so the agent loop can send messages back
    const callbacks = {
      sendToPanel: (msg) => this.broadcast('extension', msg),
      injectPrompt: (msg) => this.sendInjectPrompt(msg),
      requestDiffApproval: (diff) => this.broadcast('extension', {
        id: randomUUID(),
        type: 'diff_request',
        payload: diff,
        timestamp: Date.now(),
      }),
    };

    // Feed into agent loop
    await this.agentLoop.handleUserMessage(content, callbacks);
  }

  async _handleSlashCommand(clientId, messageId, payload) {
    const { command, args } = payload;
    const client = this.clients.get(clientId);
    if (!client) return;

    const result = await this.agentLoop.handleSlashCommand(command, args);

    // Some commands do not answer, they *replace*. `/new` and `/clear` leave
    // the old conversation on screen otherwise, which reads as though nothing
    // happened — and the panel would then restore that dead transcript the
    // next time it opened.
    if (result?.reset) {
      this.broadcast('extension', {
        id: randomUUID(),
        type: 'session_reset',
        payload: { message: result.message || '' },
        timestamp: Date.now(),
      });
    }

    this._send(client.ws, {
      id: messageId,
      type: 'command_result',
      payload: result,
      timestamp: Date.now(),
    });
  }

  /**
   * Broadcast a message to all clients of a given type.
   * Returns true if at least one client received the message.
   */
  /**
   * Send a prompt to the extension, or hold it until there is an extension.
   *
   * The delivery question is not "is a client connected" but "did anyone
   * receive this", which is what `broadcast`'s return value answers and what
   * every caller used to throw away.
   *
   * A held prompt is still owed an answer: the lane that dispatched it is busy
   * and its watchdog is running, so flushing on reconnect resumes a turn that
   * is genuinely still waiting. Past the watchdog it is not — the loop has
   * already given up and typing it into Gemini would start a conversation
   * nobody is listening to — so stale entries are dropped rather than sent.
   */
  sendInjectPrompt(msg) {
    const message = {
      id: randomUUID(),
      type: 'inject_prompt',
      payload: msg,
      timestamp: Date.now(),
    };
    if (this.broadcast('extension', message)) return true;

    this.pendingInjects.push({ message, queuedAt: Date.now() });
    // Bounded so a long offline stretch cannot grow without limit. The oldest
    // go first: they are the ones closest to their watchdog.
    while (this.pendingInjects.length > MAX_PENDING_INJECTS) this.pendingInjects.shift();
    return false;
  }

  /**
   * The extension is back — send it what it missed.
   *
   * Called when a client identifies as an extension, not on socket open: the
   * socket is open before we know what is on the other end of it, and the side
   * panel connects over the same transport.
   */
  flushPendingInjects() {
    if (this.pendingInjects.length === 0) return 0;

    const now = Date.now();
    const queued = this.pendingInjects;
    this.pendingInjects = [];

    let sent = 0;
    for (const entry of queued) {
      if (now - entry.queuedAt > INJECT_BUFFER_TTL_MS) continue;
      if (this.broadcast('extension', entry.message)) sent++;
    }
    return sent;
  }

  broadcast(clientType, message) {
    let sentCount = 0;
    for (const [id, client] of this.clients) {
      if (client.type === clientType || clientType === 'all') {
        this._send(client.ws, message);
        sentCount++;
      }
    }
    return sentCount > 0;
  }

  /**
   * Send a message to a specific WebSocket.
   */
  _send(ws, message) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }
}
