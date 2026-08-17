/**
 * Diff Engine
 *
 * Generates unified diffs, queues edits for approval,
 * applies changes atomically with backup support, and provides undo.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, copyFileSync } from 'fs';
import { resolve, dirname, relative } from 'path';
import { createPatch, applyPatch, structuredPatch } from 'diff';
import { randomUUID } from 'crypto';

export class DiffEngine {
  constructor(workspace) {
    this.workspace = workspace;
    this.pendingDiffs = new Map(); // id -> { diff, filePath, edits, status }
    this.appliedDiffs = [];        // Stack for undo
    this.backupDir = resolve(workspace, '.gemini-agent', 'backups');
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
      // Apply search-and-replace edits
      for (const edit of edits) {
        if (edit.oldText && edit.newText !== undefined) {
          const idx = newContent.indexOf(edit.oldText);
          if (idx === -1) {
            throw new Error(
              `Edit target not found in ${relPath}:\n` +
              `  Looking for: ${edit.oldText.substring(0, 80)}...`
            );
          }
          newContent =
            newContent.substring(0, idx) +
            edit.newText +
            newContent.substring(idx + edit.oldText.length);
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

  _resolvePath(filePath) {
    if (filePath.startsWith('/')) return filePath;
    return resolve(this.workspace, filePath);
  }

  _createBackup(absPath, content) {
    if (!existsSync(this.backupDir)) {
      mkdirSync(this.backupDir, { recursive: true });
    }
    const relPath = relative(this.workspace, absPath);
    const backupPath = resolve(this.backupDir, `${relPath}.${Date.now()}.bak`);
    const backupDir = dirname(backupPath);
    if (!existsSync(backupDir)) {
      mkdirSync(backupDir, { recursive: true });
    }
    writeFileSync(backupPath, content, 'utf-8');
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
