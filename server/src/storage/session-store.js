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
import { logError } from '../core/error-log.js';
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
      logError(this.workspacePath, {
        flow: 'storage', op: 'reconcile',
        message: `Could not reconcile session copies: ${err.message}`, detail: err.stack,
      });
    }
  }

  /** Write to both copies, reporting per-destination failures without throwing. */
  _writeBoth(fn) {
    for (const file of this._targets) {
      try {
        fn(ensureParent(file));
      } catch (err) {
        logError(this.workspacePath, {
          flow: 'storage', op: 'write',
          message: `Error writing ${path.basename(file)}: ${err.message}`,
          meta: { file },
        });
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
      logError(this.workspacePath, {
        flow: 'storage', op: 'load',
        message: `Error loading history: ${err.message}`, detail: err.stack,
      });
      return [];
    }
  }

  /**
   * Remember which browser conversation this session was held in.
   *
   * Kept beside the history rather than inside it: the turns are the human's
   * record and this is a fact about the *model's* memory — whether a future
   * resume can carry on, or has to explain what happened first.
   *
   * Best-effort, like everything else here. A session that cannot record its
   * thread is a session that will be offered as "view", which is the safe
   * answer anyway.
   */
  setThread(thread) {
    if (!thread?.id) return;
    this._writeBoth((file) => {
      const meta = path.join(path.dirname(file), 'session-meta.json');
      let existing = {};
      try { existing = JSON.parse(fs.readFileSync(meta, 'utf-8')); } catch { /* first write */ }
      fs.writeFileSync(meta, JSON.stringify({ ...existing, thread, updated: Date.now() }, null, 2));
    });
  }

  /** The conversation this session was held in, or `null`. */
  getThread() {
    try {
      const meta = path.join(path.dirname(this.localFile), 'session-meta.json');
      return JSON.parse(fs.readFileSync(meta, 'utf-8')).thread || null;
    } catch {
      return null;
    }
  }

  /**
   * Past conversations, newest first.
   *
   * There were none until now. `--sessions` and `--resume <id>` have been in
   * `--help` the whole time, parsed into config, and **read by nothing** — an
   * advertised feature that silently did nothing, which is worse than a
   * missing one because it looks like it works.
   *
   * The reason there were none is that `history.jsonl` is a single rolling
   * file: starting without `--continue` simply wiped it. So the fix is not a
   * picker, it is making a conversation survive the start of the next one.
   *
   * @returns {Array<{id, started, updated, turns, title, thread}>}
   */
  listSessions() {
    const file = fs.existsSync(this._indexFile(this.localFile))
      ? this._indexFile(this.localFile)
      : this._indexFile(this.homeFile);
    try {
      return fs.readFileSync(file, 'utf-8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean)
        .reverse();
    } catch {
      return []; // no sessions yet is the ordinary first-run case
    }
  }

  /** Where the index of past sessions lives, beside a history file. */
  _indexFile(historyFile) {
    return path.join(path.dirname(historyFile), 'index.jsonl');
  }

  /** Where one past conversation lives, beside a history file. */
  _archivedFile(historyFile, id) {
    return path.join(path.dirname(historyFile), 'sessions', `${id}.jsonl`);
  }

  /**
   * Put the current conversation away, so the next one does not destroy it.
   *
   * Called before `clear()` wipes the live file. Everything else here is
   * append-or-overwrite; this is the only operation that has to happen
   * *before* a destructive one, which is why it is its own method rather than
   * a flag on `clear`.
   *
   * The title is the first thing the user said, because that is what a person
   * scanning a list is actually looking for — not a timestamp, and not a
   * summary nobody asked a model to write.
   *
   * @returns {string|null} the id it was filed under, or null if there was
   *   nothing worth keeping
   */
  rollover() {
    const turns = this.loadHistory();
    if (turns.length === 0) return null;

    const firstUser = turns.find((t) => t.role === 'user' && typeof t.content === 'string');
    const title = (firstUser?.content || 'Untitled')
      .replace(/\s+/g, ' ').trim().slice(0, 72);

    // Sortable, filename-safe, and readable — the id doubles as the date.
    //
    // To the millisecond, so the id is readable as a date without opening
    // anything. It is **not** the sort key: two sessions filed in the same
    // millisecond fall back to the random suffix, which a test caught by
    // failing. The index is append-only and its order is the true one — which
    // is also the only scheme that stays correct across processes.
    const id = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23)}-${
      Math.random().toString(36).slice(2, 6)}`;

    const record = {
      id,
      title,
      turns: turns.length,
      started: turns[0]?.timestamp ?? null,
      updated: turns[turns.length - 1]?.timestamp ?? Date.now(),
      thread: this.getThread(),
    };

    const body = turns.map((t) => JSON.stringify(t)).join('\n') + '\n';
    try {
      // The artifacts belong to the conversation, not to the workspace.
      //
      // Reported from use: open the agent fresh, type nothing, and the status
      // row already reads "task.md · walkthrough.md" — a finished plan from a
      // conversation that had just been filed away. Worse than untidy, because
      // `task.md` is also fed back to the model every turn, so a completed
      // checklist from unrelated work arrived with the first prompt of the next
      // task.
      this._archiveArtifacts(id);
      // Beside *both* history files, so the home copy keeps its purpose:
      // surviving a wiped `.agent/` or a fresh checkout.
      for (const file of this._targets) {
        fs.mkdirSync(path.dirname(this._archivedFile(file, id)), { recursive: true });
        fs.writeFileSync(this._archivedFile(file, id), body, 'utf-8');
        fs.appendFileSync(this._indexFile(file), JSON.stringify(record) + '\n', 'utf-8');
      }
    } catch (err) {
      logError(this.workspacePath, {
        flow: 'storage', op: 'rollover',
        message: `Could not file the previous session: ${err.message}`,
      });
      return null;
    }
    return id;
  }

  /** The documents a conversation wrote for the user to read. */
  static get ARTIFACTS() {
    return ['task.md', 'plan.md', 'implementation_plan.md', 'walkthrough.md'];
  }

  _artifactDir() {
    return path.join(path.dirname(path.dirname(this.localFile)), 'artifacts');
  }

  _sessionArtifactDir(id) {
    return path.join(path.dirname(this.localFile), 'sessions', `${id}-artifacts`);
  }

  /**
   * Move this conversation's artifacts in with it.
   *
   * Moved, not copied: leaving them behind is the bug. Only the local copy —
   * they are working documents for the person in this checkout, where the home
   * copy exists to survive losing it.
   */
  _archiveArtifacts(id) {
    const from = this._artifactDir();
    const to = this._sessionArtifactDir(id);
    for (const name of SessionStore.ARTIFACTS) {
      const src = path.join(from, name);
      if (!fs.existsSync(src)) continue;
      try {
        fs.mkdirSync(to, { recursive: true });
        fs.renameSync(src, path.join(to, name));
      } catch (err) {
        logError(this.workspacePath, {
          flow: 'storage', op: 'archive_artifacts',
          message: `Could not file ${name}: ${err.message}`,
        });
      }
    }
  }

  /** Put a resumed conversation's artifacts back where the agent looks. */
  _restoreArtifacts(id) {
    const from = this._sessionArtifactDir(id);
    if (!fs.existsSync(from)) return;
    const to = this._artifactDir();
    for (const name of SessionStore.ARTIFACTS) {
      const src = path.join(from, name);
      if (!fs.existsSync(src)) continue;
      try {
        fs.mkdirSync(to, { recursive: true });
        fs.copyFileSync(src, path.join(to, name));
      } catch (err) {
        logError(this.workspacePath, {
          flow: 'storage', op: 'restore_artifacts',
          message: `Could not restore ${name}: ${err.message}`,
        });
      }
    }
  }

  /**
   * Make a past conversation the current one.
   *
   * Restores its thread too, so `planResume` can still tell whether the model
   * remembers it — a resumed session with no thread would always be treated as
   * needing a replay, which is safe but wrong.
   *
   * @returns {Array<Object>|null} the turns, or null if there is no such session
   */
  resumeSession(id) {
    if (!id) return null;
    const file = [this.localFile, this.homeFile]
      .map((f) => this._archivedFile(f, id))
      .find((f) => fs.existsSync(f));
    if (!file) return null;

    try {
      const turns = fs.readFileSync(file, 'utf-8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l));
      this.saveHistory(turns);
      const record = this.listSessions().find((r) => r.id === id);
      if (record?.thread) this.setThread(record.thread);
      // Its plan and its walkthrough come back with it, or the conversation is
      // restored without the documents it was about.
      this._restoreArtifacts(id);
      return turns;
    } catch (err) {
      logError(this.workspacePath, {
        flow: 'storage', op: 'resume',
        message: `Could not resume ${id}: ${err.message}`,
      });
      return null;
    }
  }

  /** Clear both copies. */
  clear() {
    for (const file of this._targets) {
      try {
        if (fs.existsSync(file)) fs.unlinkSync(file);
      } catch (err) {
        logError(this.workspacePath, {
          flow: 'storage', op: 'clear',
          message: `Error clearing ${path.basename(file)}: ${err.message}`,
          meta: { file },
        });
      }
    }
  }
}
