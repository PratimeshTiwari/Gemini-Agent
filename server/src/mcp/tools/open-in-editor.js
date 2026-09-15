/**
 * Tool: open_in_editor
 *
 * Open a file in the user's code editor.
 * Used to show plan .md files, navigate to specific code locations, etc.
 */

import { exec } from 'child_process';
import { existsSync } from 'fs';
import { resolve, relative } from 'path';

/**
 * The shell command that opens this file, and whether it carries the line.
 *
 * Exported and pure so the branching can be tested without launching an editor.
 *
 * It matches on the editor's **basename**, not the exact string it was spelled
 * with. `config.editor` defaults to `process.env.EDITOR`, which is commonly an
 * absolute path, and this used to compare `editor === 'code'`. Measured:
 *
 *     --editor code                 ->  code --goto /path/widget.js:2:1
 *     --editor /usr/local/bin/code  ->  code /path/widget.js       (no line)
 *
 * The line number was silently dropped — and the tool reported "Opened
 * src/widget.js at line 2" either way, so the model was told navigation had
 * happened when it had not. That is worse than the missing jump: the next step
 * is taken believing the user is looking at line 2.
 *
 * @returns {{ command: string, name: string, aimed: boolean }}
 */
export function editorCommand(editor, absPath, line) {
  // Split on both separators rather than `path.basename`: that one is the
  // platform's, so a Windows-style path handed to a POSIX process keeps its
  // backslashes and the whole string reads as one filename.
  const name = String(editor || 'code').split(/[\\/]/).pop().replace(/\.(exe|cmd|bat)$/i, '');
  const quoted = `"${editor}"`;
  let command;

  if (['code', 'cursor', 'code-insiders', 'codium', 'vscodium', 'windsurf'].includes(name)) {
    // VS Code and its forks all take --goto for line:column.
    command = line ? `${quoted} --goto "${absPath}:${line}:1"` : `${quoted} "${absPath}"`;
  } else if (['subl', 'sublime', 'sublime_text'].includes(name)) {
    command = line ? `${quoted} "${absPath}:${line}"` : `${quoted} "${absPath}"`;
  } else if (['vim', 'nvim', 'vi', 'gvim', 'emacs', 'emacsclient'].includes(name)) {
    command = line ? `${quoted} +${line} "${absPath}"` : `${quoted} "${absPath}"`;
  } else {
    // An editor we do not know how to aim. Open the file and say so, rather
    // than invent a flag and have it opened with a filename of "+12".
    command = `${quoted} "${absPath}"`;
  }

  return { command, name, aimed: Boolean(line) && command.includes(String(line)) };
}

export async function openInEditor(args, context) {
  const { path: filePath, line } = args;
  const { workspace, editor = 'code' } = context;

  const absPath = filePath.startsWith('/') ? filePath : resolve(workspace, filePath);
  const relPath = relative(workspace, absPath);

  if (!existsSync(absPath)) {
    throw new Error(`File not found: ${relPath}`);
  }

  const { command, name, aimed } = editorCommand(editor, absPath, line);

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
          // Reported honestly: an editor this does not know how to aim opens
          // the file at the top, and telling the model otherwise sends it on to
          // its next step believing the user is looking at line 2.
          message: aimed
            ? `Opened ${relPath} at line ${line} in ${name}`
            : line
              ? `Opened ${relPath} in ${name} — it does not take a line number, so it is at the top`
              : `Opened ${relPath} in ${name}`,
        });
      }
    });
  });
}
