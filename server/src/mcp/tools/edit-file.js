/**
 * Tool: edit_file
 *
 * Propose edits to an existing file. Generates a diff and queues
 * it for user approval via the side panel.
 */

import { existsSync } from 'fs';
import { resolve, relative } from 'path';

export async function editFile(args, context) {
  const { path: filePath, edits } = args;
  const { workspace, diffEngine } = context;

  const absPath = filePath.startsWith('/') ? filePath : resolve(workspace, filePath);
  const relPath = relative(workspace, absPath);

  if (!existsSync(absPath)) {
    throw new Error(`File not found: ${relPath}. Use create_file to create a new file.`);
  }

  if (!edits || !Array.isArray(edits) || edits.length === 0) {
    throw new Error('edits must be a non-empty array of { oldText, newText } objects');
  }

  // Validate each edit has required fields
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    if (typeof edit.oldText !== 'string') {
      throw new Error(`Edit ${i}: 'oldText' must be a string`);
    }
    if (typeof edit.newText !== 'string') {
      throw new Error(`Edit ${i}: 'newText' must be a string`);
    }
  }

  // Generate diff
  const diff = diffEngine.generateDiff(relPath, edits);

  return {
    diffId: diff.id,
    filePath: diff.filePath,
    status: 'pending_approval',
    patch: diff.patch,
    hunkCount: diff.hunks.length,
    hunks: diff.hunks.map(h => ({
      id: h.id,
      oldStart: h.oldStart,
      newStart: h.newStart,
      preview: h.lines.slice(0, 10).join('\n') + (h.lines.length > 10 ? '\n...' : ''),
    })),
    message: `Proposed ${edits.length} edit(s) to ${relPath}. Waiting for approval.`,
  };
}
