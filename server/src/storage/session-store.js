/**
 * Session Store
 *
 * Conversation history is written to TWO places on every turn:
 *
 *   <workspace>/.agent/sessions/history.jsonl        travels with the project
 *   ~/.agent/workspaces/<name>-<hash>/history.jsonl  survives losing the project
 *
 * The workspace copy is the one you can see and read next to the code. The home
 * copy is the safety net: a clean checkout, a deleted worktree, or a wiped
 * `.agent/` directory takes the local copy with it, and the home copy restores it.
 *
 * On load the two are reconciled — whichever holds more turns wins, and the
 * other is rebuilt from it. That keeps them converging instead of silently
 * diverging when one of them is lost or edited.
 */

import fs from 'fs';
import path from 'path';
import {
  localSessionPath,
  homeSessionPath,
  ensureParent,
} from '../core/paths.js';

export class SessionStore {
  constructor(workspacePath) {
    this.workspacePath = workspacePath;

    this.localFile = localSessionPath(workspacePath);
    this.homeFile = homeSessionPath(workspacePath);

    // Kept for callers that still reference a single path.
    this.sessionFile = this.localFile;

    this._reconcile();
  }

  /** Both destinations, in write order. */
  get _targets() {
    return [this.localFile, this.homeFile];
  }

  _countLines(file) {
    try {
      if (!fs.existsSync(file)) return -1;
      return fs.readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim() !== '').length;
    } catch {
      return -1;
    }
  }

  /**
   * Make the two copies agree, preferring whichever has more turns. Runs once at
   * construction, which is also what restores a workspace copy that was lost.
   */
  _reconcile() {
    const local = this._countLines(this.localFile);
    const home = this._countLines(this.homeFile);

    if (local === -1 && home === -1) return; // nothing recorded yet

    try {
      if (home > local) {
        fs.copyFileSync(this.homeFile, ensureParent(this.localFile));
      } else if (local > home) {
        fs.copyFileSync(this.localFile, ensureParent(this.homeFile));
      }
    } catch (err) {
      console.error('[SessionStore] Could not reconcile session copies:', err.message);
    }
  }

  /** Write to both copies, reporting per-destination failures without throwing. */
  _writeBoth(fn) {
    for (const file of this._targets) {
      try {
        fn(ensureParent(file));
      } catch (err) {
        console.error(`[SessionStore] Error writing ${path.basename(file)}:`, err.message);
      }
    }
  }

  /**
   * Append a single turn to both JSONL files.
   * @param {Object} turn
   */
  appendTurn(turn) {
    const line = JSON.stringify(turn) + '\n';
    this._writeBoth((file) => fs.appendFileSync(file, line, 'utf-8'));
  }

  /**
   * Rewrite the entire history (e.g. after compaction).
   * @param {Array<Object>} history
   */
  saveHistory(history) {
    const lines = history.map((turn) => JSON.stringify(turn)).join('\n') + '\n';
    this._writeBoth((file) => fs.writeFileSync(file, lines, 'utf-8'));
  }

  /**
   * Load history, preferring the workspace copy (already reconciled at startup).
   * @returns {Array<Object>}
   */
  loadHistory() {
    const file = fs.existsSync(this.localFile) ? this.localFile : this.homeFile;
    if (!fs.existsSync(file)) return [];

    try {
      const data = fs.readFileSync(file, 'utf-8');
      return data
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line));
    } catch (err) {
      console.error('[SessionStore] Error loading history:', err.message);
      return [];
    }
  }

  /** Clear both copies. */
  clear() {
    for (const file of this._targets) {
      try {
        if (fs.existsSync(file)) fs.unlinkSync(file);
      } catch (err) {
        console.error(`[SessionStore] Error clearing ${path.basename(file)}:`, err.message);
      }
    }
  }
}
