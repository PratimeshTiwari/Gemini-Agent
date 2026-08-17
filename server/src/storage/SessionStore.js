import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

/**
 * SessionStore
 * 
 * Manages conversation history persistence using JSONL files in the
 * ~/.gemini-agent/sessions/ directory.
 */
export class SessionStore {
  constructor(workspacePath) {
    this.workspacePath = workspacePath;
    
    const configDir = path.join(os.homedir(), '.gemini-agent');
    this.sessionsDir = path.join(configDir, 'sessions');
    
    if (!fs.existsSync(this.sessionsDir)) {
      fs.mkdirSync(this.sessionsDir, { recursive: true });
    }

    // Use a hash of the workspace path to keep sessions unique per project
    const hash = crypto.createHash('md5').update(workspacePath).digest('hex').substring(0, 10);
    this.sessionFile = path.join(this.sessionsDir, `session_${hash}.jsonl`);
  }

  /**
   * Append a single turn to the JSONL file.
   * @param {Object} turn 
   */
  appendTurn(turn) {
    try {
      const line = JSON.stringify(turn) + '\n';
      fs.appendFileSync(this.sessionFile, line, 'utf-8');
    } catch (err) {
      console.error('[SessionStore] Error saving turn:', err.message);
    }
  }

  /**
   * Rewrite the entire history (e.g. after compaction).
   * @param {Array<Object>} history 
   */
  saveHistory(history) {
    try {
      const lines = history.map(turn => JSON.stringify(turn)).join('\n') + '\n';
      fs.writeFileSync(this.sessionFile, lines, 'utf-8');
    } catch (err) {
      console.error('[SessionStore] Error saving history:', err.message);
    }
  }

  /**
   * Load history from the JSONL file.
   * @returns {Array<Object>}
   */
  loadHistory() {
    if (!fs.existsSync(this.sessionFile)) return [];

    try {
      const data = fs.readFileSync(this.sessionFile, 'utf-8');
      const lines = data.split('\n').filter(line => line.trim() !== '');
      return lines.map(line => JSON.parse(line));
    } catch (err) {
      console.error('[SessionStore] Error loading history:', err.message);
      return [];
    }
  }

  /**
   * Clear the session file.
   */
  clear() {
    if (fs.existsSync(this.sessionFile)) {
      fs.unlinkSync(this.sessionFile);
    }
  }
}
