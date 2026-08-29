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

export class WebSocketServer {
  constructor({ port, agentLoop, githubHandler }) {
    this.port = port;
    this.agentLoop = agentLoop;
    this.githubHandler = githubHandler;
    this.wss = null;
    this.clients = new Map(); // id -> { ws, type, connectedAt }
    this.pendingGitHubNotifications = []; // Buffer for CLI

    // Wire GitHub events to broadcast
    if (this.githubHandler) {
      this._wireGitHubEvents();
    }

    // Always provide background callbacks so headless tasks (e.g. GitHub agent)
    // can use the extension bridge even when no user message is being processed.
    this._wireBackgroundCallbacks();
  }

  _wireBackgroundCallbacks() {
    const backgroundCallbacks = {
      sendToPanel: (msg) => this.broadcast('extension', msg),
      injectPrompt: (msg) => this.broadcast('extension', {
        id: randomUUID(),
        type: 'inject_prompt',
        payload: msg,
        timestamp: Date.now(),
      }),
      requestDiffApproval: () => {}, // No-op for background tasks
    };
    this.agentLoop.setBackgroundCallbacks(backgroundCallbacks);
  }

  async start() {
    return new Promise((resolve) => {
      this.wss = new WS({ port: this.port });

      this.wss.on('connection', (ws, req) => {
        this._handleConnection(ws, req);
      });

      this.wss.on('listening', () => {
        resolve();
      });

      this.wss.on('error', (err) => {
        console.error('❌ WebSocket server error:', err.message);
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

    console.log(`🔌 Client connected: ${clientId}`);

    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());
        await this._handleMessage(clientId, message);
      } catch (err) {
        console.error(`❌ Error handling message from ${clientId}:`, err.message);
        this._send(ws, {
          id: randomUUID(),
          type: 'error',
          payload: { message: err.message },
          timestamp: Date.now(),
        });
      }
    });

    ws.on('close', (code, reason) => {
      console.log(`🔌 Client disconnected: ${clientId} (code: ${code})`);
      this.clients.delete(clientId);
    });

    ws.on('error', (err) => {
      console.error(`❌ Client error (${clientId}):`, err.message);
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
  }

  async _handleMessage(clientId, message) {
    const { id, type, payload } = message;
    const client = this.clients.get(clientId);

    if (!client) return;

    // Identify client type from first message
    if (payload?.clientType && client.type === 'unknown') {
      client.type = payload.clientType;
      console.log(`  📋 Client ${clientId} identified as: ${client.type}`);
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
        // Extension reported an error (e.g. failed to inject)
        this.agentLoop.isProcessing = false;
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
            console.log(`  🌐 Connected Models: ${payload.connectedModels.join(', ')}`);
          }
        }
        break;

      case 'github_pr_comment':
        // Real-time comment from GitHub content script
        if (this.githubHandler) {
          console.log(`  [GitHub Bridge] New comment detected on PR #${payload?.pr?.number}`);
          // Emit as if it came from the poller — the classifier/plan generator will handle it
          this.githubHandler.poller.emit('new_comment', {
            pr: {
              number: payload.pr.number,
              title: payload.pr.title || `PR #${payload.pr.number}`,
              html_url: payload.pr.url || `https://github.com/${payload.pr.full_name}/pull/${payload.pr.number}`,
              head_ref: payload.pr.head_ref || 'unknown',
              head_sha: null,
              repo: {
                owner: payload.pr.owner,
                name: payload.pr.repo,
                full_name: payload.pr.full_name,
              },
              key: `${payload.pr.full_name}#${payload.pr.number}`,
            },
            comment: payload.comment,
          });
        }
        break;

      case 'github_pr_viewing':
        // User is viewing a PR page
        if (payload?.pr) {
          console.log(`  [GitHub Bridge] User viewing PR #${payload.pr.number} on ${payload.pr.full_name}`);
        }
        break;

      default:
        console.warn(`⚠️ Unknown message type: ${type}`);
    }
  }

  // ── GitHub Event Wiring ─────────────────────────────────────────

  _wireGitHubEvents() {
    this.githubHandler.on('notification', (data) => {
      const msg = {
        id: randomUUID(),
        type: 'github_notification',
        payload: data,
        timestamp: Date.now(),
      };
      this.pendingGitHubNotifications.push(msg);
      this.broadcast('extension', msg);
    });

    this.githubHandler.on('plan_generated', (data) => {
      const payload = {
        type: data.type,
        prNumber: data.pr.number,
        prTitle: data.pr.title,
        filePath: data.filePath,
        isNew: data.isNew,
        category: data.classification?.category || data.type,
        comment: data.comment,
      };
      
      const msg = {
        id: randomUUID(),
        type: 'github_plan_generated',
        payload: payload,
        timestamp: Date.now(),
      };
      
      this.pendingGitHubNotifications.push(msg);
      this.broadcast('extension', msg);
    });
  }

  /**
   * Get and clear pending GitHub notifications (for CLI display).
   */
  getGitHubNotifications() {
    const notifications = [...this.pendingGitHubNotifications];
    this.pendingGitHubNotifications = [];
    return notifications;
  }

  async _handleUserMessage(clientId, messageId, payload) {
    const { content } = payload;
    const client = this.clients.get(clientId);
    if (!client) return;

    // Set up callbacks so the agent loop can send messages back
    const callbacks = {
      sendToPanel: (msg) => this.broadcast('extension', msg),
      injectPrompt: (msg) => this.broadcast('extension', {
        id: randomUUID(),
        type: 'inject_prompt',
        payload: msg,
        timestamp: Date.now(),
      }),
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
