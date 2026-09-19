/**
 * Diff Engine
 *
 * Generates unified diffs, queues edits for approval,
 * applies changes atomically with backup support, and provides undo.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, copyFileSync, readdirSync, unlinkSync } from 'fs';
import { backupsDir } from './paths.js';
import { planBackupPruning } from './backup-pruner.js';
import { resolve, dirname, relative, isAbsolute, join } from 'path';
import { createPatch, applyPatch, structuredPatch } from 'diff';
import { randomUUID } from 'crypto';

/**
 * How many **positions** `needle` occupies in `haystack`, overlaps included.
 *
 * Positions, not non-overlapping occurrences, and the two disagree: `aa` in
 * `aaa` is one occurrence and two positions. The number is the answer to
 * "how many places could the model have meant", and it is also the gate on
 * whether the edit is refused — so counting it one way and testing it
 * another produced `ambiguous: 1`, which reads as nonsense and refused
 * nothing consistently.
 *
 * `split().length - 1` is the one-liner and is the non-overlapping answer.
 */
function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let n = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    n += 1;
    at = haystack.indexOf(needle, at + 1);
  }
  return n;
}

export class DiffEngine {
  constructor(workspace) {
    this.workspace = workspace;
    this.pendingDiffs = new Map(); // id -> { diff, filePath, edits, status }
    this.appliedDiffs = [];        // Stack for undo
    this.backupDir = backupsDir(workspace);
  }

  /**
   * Generate a unified diff for proposed edits to a file.
   * Returns the diff object with metadata for approval.
   */
  generateDiff(filePath, edits) {
    const absPath = this._resolvePath(filePath);
    const relPath = relative(this.workspace, absPath);

    let originalContent = '';
    let isNewFile = false;

    if (existsSync(absPath)) {
      originalContent = readFileSync(absPath, 'utf-8');
    } else {
      isNewFile = true;
    }

    // Apply edits to generate new content
    let newContent = originalContent;

    if (isNewFile) {
      // For new files, edits contain the full content
      newContent = edits[0]?.newText || edits[0]?.content || '';
    } else {
      /**
       * Write back the endings the file already had.
       *
       * The fuzzy tier matches a CRLF span with an LF `oldText` — that is the
       * point of it — and then `newText` carries LF, so the edited region
       * comes back converted while the rest of the file does not. Measured:
       * `function f() {\r\n  return 1;\r\n}\r\n` became
       * `function f() {\n  return 2;\n}\r\n`.
       *
       * Single-line edits never showed it, because they match exactly and
       * contain no newline. Multi-line edits are most real edits, so on a
       * CRLF repo every touched block became a whole-block diff and the file
       * ended up mixed.
       *
       * Decided from the *original* content, once, rather than per edit: a
       * file's endings are a property of the file, and reading them from
       * `newContent` would let the first edit's answer decide the rest.
       */
      const crlf = /\r\n/.test(originalContent)
        && (originalContent.match(/\r\n/g) || []).length
           >= (originalContent.match(/(?<!\r)\n/g) || []).length;

      // Apply search-and-replace edits
      for (const edit of edits) {
        if (edit.oldText && edit.newText !== undefined) {
          const match = this._findMatch(newContent, edit.oldText);
          if (match && match.ambiguous) {
            // Named, with the count and what to do about it — the standard
            // the rest of the tool errors hold themselves to. "Not found"
            // would send the model looking for the text it can plainly see.
            throw new Error(
              `Edit target is ambiguous in ${relPath}: it matches ${match.ambiguous} places. `
              + 'Include more surrounding context in oldText so it identifies exactly one.\n'
              + `  Looking for: ${edit.oldText.substring(0, 80)}...`
            );
          }
          if (!match) {
            throw new Error(
              `Edit target not found in ${relPath} (even with fuzzy matching):\n` +
              `  Looking for: ${edit.oldText.substring(0, 80)}...`
            );
          }
          const replacement = crlf
            ? edit.newText.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')
            : edit.newText;
          newContent =
            newContent.substring(0, match.index) +
            replacement +
            newContent.substring(match.index + match.length);
        }
      }
    }

    // Generate unified diff
    const patch = createPatch(
      relPath,
      originalContent,
      newContent,
      'original',
      'modified'
    );

    // Generate structured patch for per-hunk operations
    const structured = structuredPatch(
      relPath,
      relPath,
      originalContent,
      newContent,
      'original',
      'modified'
    );

    const diffId = randomUUID();

    const diffObj = {
      id: diffId,
      filePath: relPath,
      absPath,
      isNewFile,
      originalContent,
      newContent,
      patch,             // Unified diff string
      hunks: structured.hunks.map((hunk, i) => ({
        id: `${diffId}-hunk-${i}`,
        index: i,
        oldStart: hunk.oldStart,
        oldLines: hunk.oldLines,
        newStart: hunk.newStart,
        newLines: hunk.newLines,
        lines: hunk.lines,
        status: 'pending', // pending | accepted | rejected
      })),
      status: 'pending',  // pending | accepted | rejected | partial
      createdAt: Date.now(),
      edits,
    };

    this.pendingDiffs.set(diffId, diffObj);
    return diffObj;
  }

  /**
   * Generate a diff for a completely new file.
   */
  generateNewFileDiff(filePath, content) {
    return this.generateDiff(filePath, [{ newText: content }]);
  }

  /**
   * Accept a diff (all hunks) and apply it to disk.
   */
  acceptDiff(diffId) {
    const diff = this.pendingDiffs.get(diffId);
    if (!diff) throw new Error(`Diff not found: ${diffId}`);
    if (diff.status !== 'pending' && diff.status !== 'partial') {
      throw new Error(`Diff ${diffId} is already ${diff.status}`);
    }

    // Create backup of original file
    if (!diff.isNewFile && existsSync(diff.absPath)) {
      this._createBackup(diff.absPath, diff.originalContent);
    }

    // Apply the new content
    this._writeFileAtomic(diff.absPath, diff.newContent);

    diff.status = 'accepted';
    diff.hunks.forEach(h => { h.status = 'accepted'; });
    diff.appliedAt = Date.now();

    this.appliedDiffs.push(diff);
    this.pendingDiffs.delete(diffId);

    return { success: true, filePath: diff.filePath };
  }

  /**
   * Accept or reject individual hunks within a diff.
   */
  respondToHunk(diffId, hunkId, accept) {
    const diff = this.pendingDiffs.get(diffId);
    if (!diff) throw new Error(`Diff not found: ${diffId}`);

    const hunk = diff.hunks.find(h => h.id === hunkId);
    if (!hunk) throw new Error(`Hunk not found: ${hunkId}`);

    hunk.status = accept ? 'accepted' : 'rejected';

    // Check if all hunks have been resolved
    const allResolved = diff.hunks.every(h => h.status !== 'pending');
    if (allResolved) {
      const anyAccepted = diff.hunks.some(h => h.status === 'accepted');
      if (anyAccepted) {
        // Rebuild content with only accepted hunks
        const partialContent = this._applySelectedHunks(diff);
        diff.newContent = partialContent;
        diff.status = 'partial';
        return this.acceptDiff(diffId);
      } else {
        diff.status = 'rejected';
        this.pendingDiffs.delete(diffId);
        return { success: true, filePath: diff.filePath, rejected: true };
      }
    }

    return { success: true, pendingHunks: diff.hunks.filter(h => h.status === 'pending').length };
  }

  /**
   * Reject a diff entirely.
   */
  rejectDiff(diffId) {
    const diff = this.pendingDiffs.get(diffId);
    if (!diff) throw new Error(`Diff not found: ${diffId}`);

    diff.status = 'rejected';
    diff.hunks.forEach(h => { h.status = 'rejected'; });
    this.pendingDiffs.delete(diffId);

    return { success: true, filePath: diff.filePath };
  }

  /**
   * Undo the last applied diff.
   */
  undo() {
    const lastDiff = this.appliedDiffs.pop();
    if (!lastDiff) {
      return { success: false, message: 'Nothing to undo' };
    }

    // Restore original content
    if (lastDiff.isNewFile) {
      // If it was a new file, we could delete it, but safer to leave it
      // and just report what was undone
      writeFileSync(lastDiff.absPath, '', 'utf-8');
    } else {
      writeFileSync(lastDiff.absPath, lastDiff.originalContent, 'utf-8');
    }

    return {
      success: true,
      filePath: lastDiff.filePath,
      message: `Reverted changes to ${lastDiff.filePath}`,
    };
  }

  /**
   * Get all pending diffs.
   */
  getPendingDiffs() {
    return Array.from(this.pendingDiffs.values());
  }

  /**
   * Get a specific diff by ID.
   */
  getDiff(diffId) {
    return this.pendingDiffs.get(diffId) || this.appliedDiffs.find(d => d.id === diffId);
  }

  // ── Private Methods ──────────────────────────────────────────────

  /**
   * Where `targetText` is in `content` — and only if there is one answer.
   *
   * Two tiers: exact, then whitespace-insensitive. The second escapes every
   * regex special *except* whitespace and rewrites each whitespace run as
   * `\s+`, which is what makes it survive a reindent and a CRLF file. It is
   * deliberately not looser than that: `\s+` cannot cross non-whitespace, so
   * it can never weld together two fragments that had code between them.
   *
   * **The tiers count their matches, and more than one is a refusal.** Both
   * used to take the first and say nothing. Measured end to end: a file with
   * two identical `return null;` blocks, an edit meant for the second, and
   * the first is rewritten — silently, with a diff that looks entirely
   * plausible because the change is real and in a real place.
   *
   * That is the brittleness that actually bites, and it is the opposite of
   * the usual diagnosis. A *fuzzier* matcher makes it strictly worse: it
   * creates more candidates for the same first-wins rule. The cure is to
   * refuse and say how many, which is something the model can act on.
   *
   * @returns {{index: number, length: number} | {ambiguous: number} | null}
   */
  _findMatch(content, targetText) {
    // 1. Exact. A unique exact hit is unambiguous by construction, and must
    //    not be spoiled by what the looser pattern would also have matched.
    const exactIdx = content.indexOf(targetText);
    if (exactIdx !== -1) {
      const places = countOccurrences(content, targetText);
      if (places > 1) return { ambiguous: places };
      return { index: exactIdx, length: targetText.length };
    }

    // 2. Whitespace-insensitive.
    const escaped = targetText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regexStr = escaped.replace(/\s+/g, '\\s+');

    try {
      const regex = new RegExp(regexStr, 'g');
      const matches = [...content.matchAll(regex)];
      if (matches.length > 1) return { ambiguous: matches.length };
      if (matches.length === 1) {
        return { index: matches[0].index, length: matches[0][0].length };
      }
    } catch (e) {
      // Fallback if regex compilation fails due to size or weird characters
    }

    return null;
  }

  _resolvePath(filePath) {
    if (filePath.startsWith('/')) return filePath;
    return resolve(this.workspace, filePath);
  }

  _createBackup(absPath, content) {
    if (!existsSync(this.backupDir)) {
      mkdirSync(this.backupDir, { recursive: true });
    }
    const backupPath = resolve(this.backupDir, `${this._backupName(absPath)}.${Date.now()}.bak`);
    const backupDir = dirname(backupPath);
    if (!existsSync(backupDir)) {
      mkdirSync(backupDir, { recursive: true });
    }
    writeFileSync(backupPath, content, 'utf-8');
    this._pruneBackups(backupDir);
  }

  /**
   * Where a file's backup goes, relative to the backup directory.
   *
   * This was `relative(workspace, absPath)` used directly, and the tools accept
   * absolute paths — so editing a file outside the workspace produced a
   * relative path of `../../../tmp/x`, and `resolve(backupDir, that)` wrote the
   * backup *outside the backup directory and outside the workspace*. With
   * workspace `/a/b/c`, a backup of `/tmp/x` landed at `/a/b/tmp/x.bak`.
   *
   * Anything outside goes under `_external/` with its absolute path preserved
   * below that, so the backup is still findable and can no longer escape.
   */
  _backupName(absPath) {
    const rel = relative(this.workspace, absPath);
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel;
    return join('_external', absPath.replace(/^([A-Za-z]:)?[\\/]+/, ''));
  }

  /**
   * Drop surplus backups for the files in one directory.
   *
   * Best-effort by design: a workspace whose backup dir is read-only, or being
   * cleaned by something else, should not fail the edit that triggered this.
   */
  _pruneBackups(dir) {
    try {
      const names = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name);
      for (const name of planBackupPruning(names)) {
        try {
          unlinkSync(resolve(dir, name));
        } catch {
          /* already gone, or not ours to remove */
        }
      }
    } catch {
      /* unreadable directory: the backup itself still landed */
    }
  }

  _writeFileAtomic(absPath, content) {
    const dir = dirname(absPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const tmpPath = `${absPath}.tmp.${Date.now()}`;
    writeFileSync(tmpPath, content, 'utf-8');
    renameSync(tmpPath, absPath);
  }

  _applySelectedHunks(diff) {
    // Rebuild content applying only accepted hunks
    const lines = diff.originalContent.split('\n');
    const result = [];
    let lineIndex = 0;

    // Sort hunks by position
    const sortedHunks = [...diff.hunks].sort((a, b) => a.oldStart - b.oldStart);

    for (const hunk of sortedHunks) {
      // Add lines before this hunk
      while (lineIndex < hunk.oldStart - 1) {
        result.push(lines[lineIndex]);
        lineIndex++;
      }

      if (hunk.status === 'accepted') {
        // Apply hunk: add new lines, skip old lines
        for (const line of hunk.lines) {
          if (line.startsWith('+')) {
            result.push(line.substring(1));
          } else if (line.startsWith('-')) {
            lineIndex++;
          } else if (line.startsWith(' ')) {
            result.push(line.substring(1));
            lineIndex++;
          }
        }
      } else {
        // Skip hunk: keep original lines
        for (let i = 0; i < hunk.oldLines; i++) {
          if (lineIndex < lines.length) {
            result.push(lines[lineIndex]);
            lineIndex++;
          }
        }
      }
    }

    // Add remaining lines
    while (lineIndex < lines.length) {
      result.push(lines[lineIndex]);
      lineIndex++;
    }

    return result.join('\n');
  }
}
