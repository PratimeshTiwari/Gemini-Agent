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
    // 'proposed', not 'pending_approval': at this point a diff exists and
    // nothing has been decided. The agent loop replaces this with 'applied' or
    // 'rejected' once it knows which, and the model must report that rather
    // than this.
    status: 'proposed',
    patch: diff.patch,
    lineCount: content.split('\n').length,
    message: fileExists
      ? `Diff prepared to overwrite ${relPath}.`
      : `Diff prepared to create ${relPath} (${content.split('\n').length} lines).`,
  };
}
