/**
 * Tool: open_in_editor
 *
 * Open a file in the user's code editor.
 * Used to show plan .md files, navigate to specific code locations, etc.
 */

import { exec } from 'child_process';
import { existsSync } from 'fs';
import { resolve, relative } from 'path';

export async function openInEditor(args, context) {
  const { path: filePath, line } = args;
  const { workspace, editor = 'code' } = context;

  const absPath = filePath.startsWith('/') ? filePath : resolve(workspace, filePath);
  const relPath = relative(workspace, absPath);

  if (!existsSync(absPath)) {
    throw new Error(`File not found: ${relPath}`);
  }

  // Build editor command
  let command;
  if (editor === 'code' || editor === 'cursor') {
    // VS Code / Cursor support --goto for line:column
    command = line
      ? `${editor} --goto "${absPath}:${line}:1"`
      : `${editor} "${absPath}"`;
  } else if (editor === 'subl' || editor === 'sublime') {
    command = line
      ? `subl "${absPath}:${line}"`
      : `subl "${absPath}"`;
  } else if (editor === 'vim' || editor === 'nvim') {
    command = line
      ? `${editor} +${line} "${absPath}"`
      : `${editor} "${absPath}"`;
  } else {
    // Generic fallback
    command = `${editor} "${absPath}"`;
  }

  return new Promise((resolveP) => {
    exec(command, { timeout: 5000 }, (error) => {
      if (error) {
        resolveP({
          success: false,
          filePath: relPath,
          message: `Failed to open in ${editor}: ${error.message}`,
        });
      } else {
        resolveP({
          success: true,
          filePath: relPath,
          line: line || null,
          message: line
            ? `Opened ${relPath} at line ${line} in ${editor}`
            : `Opened ${relPath} in ${editor}`,
        });
      }
    });
  });
}
