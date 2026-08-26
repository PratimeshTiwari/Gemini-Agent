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
  constructor({ port, agentLoop }) {
    this.port = port;
    this.agentLoop = agentLoop;
    this.wss = null;
    this.clients = new Map(); // id -> { ws, type, connectedAt }
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

      default:
        console.warn(`⚠️ Unknown message type: ${type}`);
    }
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
   */
  broadcast(clientType, message) {
    for (const [id, client] of this.clients) {
      if (client.type === clientType || clientType === 'all') {
        this._send(client.ws, message);
      }
    }
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
