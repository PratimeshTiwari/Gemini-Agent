import fs from 'fs/promises';
import { editorStatePath } from '../../core/paths.js';

/**
 * What the user is looking at — the pointer, never the contents.
 *
 * This used to return `visibleText` as well, and measured on a live session
 * that was **2,501 of 2,630 bytes: 95.1% of the payload**. What those bytes
 * bought was a worse read than the model already had — viewport-cropped to
 * whatever happened to be on screen, with no line numbers, of a file
 * `read_file` returns whole and numbered. So the expensive 95% answered a
 * question that was not asked and answered it badly.
 *
 * It is also why this tool must stay a *pull*. Riding every turn as ambient
 * context would be seven times turn 1's entire size, and the cheap 35-byte
 * version does not survive either: Cursor's ambient active-file works because
 * the chat lives inside the editor, so the focused file *is* the question's
 * context. This CLI is a separate terminal, and the companion tracks whatever
 * VS Code has focus on — observed drifting between two unrelated files inside
 * ten minutes with no matching conversation. An ambient claim that is silently
 * wrong sends the model confidently to the wrong file, which is worse than the
 * model simply not knowing.
 *
 * The age therefore rides every answer rather than only the stale ones. The
 * caller cannot judge "is this still what they mean?" without it, and a bare
 * `Active file:` reads as a fact about now.
 */

/** Past this, the user has probably moved on or closed the editor. */
const STALE_MS = 300000;

export default {
  name: 'get_editor_state',
  description: 'Which file the user has open in their editor and where the cursor is, '
    + 'from the VS Code companion. Returns the location only, never the file contents — '
    + 'use read_file for those. The answer carries its age, because the editor moves '
    + 'independently of this conversation.',
  schema: {
    type: 'object',
    properties: {},
    required: []
  },
  async execute(args, context) {
    // `context.workspace` is what MCPServer always passes; reaching through
    // the indexer for a workspace path was a hack that happened to work, and it
    // would have broken the moment the indexer was deleted.
    const stateFile = editorStatePath(context.workspace || process.cwd());

    try {
      const state = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
      const ageMs = Date.now() - new Date(state.timestamp).getTime();
      const age = Number.isFinite(ageMs)
        ? `${Math.max(0, Math.round(ageMs / 1000))}s ago`
        : 'unknown';

      const lines = [
        `Active file: ${state.activeFile}`,
        `Cursor: line ${state.cursorLine}, char ${state.cursorChar}`,
        `Last updated: ${age}`,
      ];
      if (!Number.isFinite(ageMs) || ageMs > STALE_MS) {
        lines.push(
          'This is stale — the user has probably moved on or closed the editor. '
          + 'Do not assume it is what they are asking about.',
        );
      }
      return { result: lines.join('\n') };
    } catch (err) {
      if (err.code === 'ENOENT') {
        return { error: 'Editor state not found. The user needs to install the Gemini-Agent VS Code companion extension and open this workspace.' };
      }
      return { error: `Failed to read editor state: ${err.message}` };
    }
  }
};
