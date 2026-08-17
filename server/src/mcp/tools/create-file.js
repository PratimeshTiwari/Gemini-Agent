/**
 * Tool: create_file
 *
 * Create a new file with specified content.
 * Queues for approval just like edit_file.
 */

import { existsSync } from 'fs';
import { resolve, relative } from 'path';

export async function createFile(args, context) {
  const { path: filePath, content } = args;
  const { workspace, diffEngine } = context;

  const absPath = filePath.startsWith('/') ? filePath : resolve(workspace, filePath);
  const relPath = relative(workspace, absPath);

  if (typeof content !== 'string') {
    throw new Error("'content' must be a string");
  }

  const fileExists = existsSync(absPath);

  // Generate diff (shows as all-added for new files)
  const diff = diffEngine.generateNewFileDiff(relPath, content);

  return {
    diffId: diff.id,
    filePath: diff.filePath,
    isNewFile: !fileExists,
    isOverwrite: fileExists,
    status: 'pending_approval',
    patch: diff.patch,
    lineCount: content.split('\n').length,
    message: fileExists
      ? `Will overwrite existing file ${relPath}. Waiting for approval.`
      : `Will create new file ${relPath} (${content.split('\n').length} lines). Waiting for approval.`,
  };
}
