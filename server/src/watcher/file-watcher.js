import chokidar from 'chokidar';
import path from 'path';
import { AgentLoop } from '../core/agent-loop.js';

/**
 * FileWatcher
 * 
 * Uses chokidar to monitor the active workspace. Notifies the agent 
 * if a file is modified externally.
 */
export class FileWatcher {
  /**
   * @param {string} workspacePath 
   * @param {AgentLoop} agentLoop 
   */
  constructor(workspacePath, agentLoop) {
    this.workspacePath = workspacePath;
    this.agentLoop = agentLoop;
    this.watcher = null;
    this.enabled = true;
  }

  start() {
    this.watcher = chokidar.watch(this.workspacePath, {
      ignored: [
        /(^|[\/\\])\../, // ignore dotfiles
        /node_modules/,
        /dist/,
        /build/,
        /\.gemini-agent/
      ],
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 1000,
        pollInterval: 100
      }
    });

    this.watcher.on('change', (filePath) => this._handleChange('modified', filePath));
    this.watcher.on('add', (filePath) => this._handleChange('added', filePath));
    this.watcher.on('unlink', (filePath) => this._handleChange('deleted', filePath));
    
    console.log(`[FileWatcher] Watching ${this.workspacePath} for external changes...`);
  }

  stop() {
    if (this.watcher) {
      this.watcher.close();
    }
  }

  /**
   * Pause the watcher temporarily (e.g. when the agent is writing files itself)
   * to avoid echo loops.
   */
  pause() {
    this.enabled = false;
  }

  resume() {
    this.enabled = true;
  }

  _handleChange(event, filePath) {
    if (!this.enabled) return;

    const relativePath = path.relative(this.workspacePath, filePath);
    
    // Inject a system event into the conversation history
    const eventTurn = {
      role: 'system',
      type: 'fs_event',
      content: `[System Event] File ${relativePath} was ${event} externally by the user.`,
      timestamp: Date.now()
    };

    if (this.agentLoop && this.agentLoop.conversationHistory) {
      this.agentLoop.conversationHistory.push(eventTurn);
      if (this.agentLoop.sessionStore) {
        this.agentLoop.sessionStore.appendTurn(eventTurn);
      }
    }
  }
}
