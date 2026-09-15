/**
 * Putting text on the system clipboard.
 *
 * `ctrl+y` copies the last code block a reply contained. That exists because
 * there is no clickable copy button here and there cannot be one: a copy button
 * needs mouse tracking, and a terminal that is tracking hands the app the wheel
 * and suppresses drag-select — so adding the button would take away the
 * selection it was meant to replace.
 *
 * Drag-select is still the primary way to copy, and `format.js` un-indented
 * code blocks so that it works. This is the shortcut for the common case.
 *
 * Same rule as `folder-picker.js`: only offered where it can actually work. A
 * chord that silently does nothing is worse than no chord, because people press
 * it twice and conclude the tool is broken.
 */

import { execFileSync, spawn } from 'child_process';

/** Is there a runnable command by this name on PATH? */
function onPath(binary) {
  try {
    execFileSync('/bin/sh', ['-c', `command -v ${binary}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * The clipboard command for this machine, or null.
 *
 * @returns {{ cmd: string, args: string[] } | null}
 */
export function clipboardCommand() {
  if (process.platform === 'darwin') return { cmd: 'pbcopy', args: [] };
  if (process.platform === 'win32') return { cmd: 'clip', args: [] };
  // Wayland first: `xclip` on a Wayland session copies into an Xwayland
  // clipboard that native applications never read.
  if (process.env.WAYLAND_DISPLAY && onPath('wl-copy')) return { cmd: 'wl-copy', args: [] };
  if (onPath('xclip')) return { cmd: 'xclip', args: ['-selection', 'clipboard'] };
  if (onPath('xsel')) return { cmd: 'xsel', args: ['--clipboard', '--input'] };
  return null;
}

/** Whether `ctrl+y` can do anything on this machine. */
export const canCopy = () => clipboardCommand() !== null;

/**
 * Copy text, reporting whether it worked.
 *
 * Writes through a pipe rather than an argument: a code block can be longer
 * than the platform's argument limit, and it can contain anything at all —
 * quoting it into a shell string is how a copy becomes a command.
 *
 * @returns {Promise<boolean>}
 */
export function copyToClipboard(text) {
  const target = clipboardCommand();
  if (!target) return Promise.resolve(false);
  return writeThrough(target, text);
}

/**
 * Pipe text into a command and report whether it exited cleanly.
 *
 * Separate from `copyToClipboard` so the piping can be tested against a
 * harmless sink. Testing it against the real clipboard would mean overwriting
 * whatever the person running the tests had copied — which on this app could
 * be an image they were about to attach with `/paste-image`.
 *
 * @param {{cmd: string, args: string[]}} target
 * @returns {Promise<boolean>}
 */
export function writeThrough(target, text) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(target.cmd, target.args, { stdio: ['pipe', 'ignore', 'ignore'] });
    } catch {
      return resolve(false);
    }
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
    // A clipboard helper that has already exited makes this write throw, and a
    // failed copy must not take the UI down with it.
    try {
      child.stdin.on('error', () => {});
      child.stdin.end(String(text ?? ''));
    } catch {
      resolve(false);
    }
  });
}
