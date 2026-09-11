/**
 * Asking the operating system for a folder.
 *
 * Typing a path into a terminal is fine when you know it and miserable when you
 * do not — and "where did I clone that skills repo?" is exactly the case where
 * you do not. Every desktop already has a good answer to that question, so this
 * borrows it rather than building a file browser inside Ink.
 *
 * Deliberately *not* offered where no picker exists. A menu row that silently
 * does nothing on someone's Linux box is worse than no row: they will press it
 * twice and conclude the tool is broken. `canPickFolder()` says whether to draw
 * it at all, and the answer is a fact about this machine, not a guess.
 */

import { execFile, execFileSync } from 'child_process';
import { existsSync, statSync } from 'fs';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** A picker is a GUI thing; without a display there is nothing to show. */
function hasDisplay() {
  if (process.platform === 'darwin') return true;
  if (process.platform === 'win32') return true;
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

/** Is there a runnable command by this name on PATH? */
function onPath(binary) {
  try {
    // `command -v` rather than `which`: it is a shell builtin, so it is present
    // even on minimal images where `which` is not installed.
    execFileSync('/bin/sh', ['-c', `command -v ${binary}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Can this machine show a folder chooser?
 *
 * @returns {false | 'macos' | 'zenity' | 'kdialog' | 'windows'}
 */
export function canPickFolder() {
  if (!hasDisplay()) return false;
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'win32') return 'windows';
  if (onPath('zenity')) return 'zenity';
  if (onPath('kdialog')) return 'kdialog';
  return false;
}

/**
 * Open the chooser and wait for an answer.
 *
 * @param {string} title - shown in the dialog
 * @returns {Promise<string|null>} the chosen directory, or null if cancelled
 */
export async function pickFolder(title = 'Choose a folder') {
  const kind = canPickFolder();
  if (!kind) return null;

  try {
    const path = await runPicker(kind, title);
    if (!path) return null;
    // A picker can only return a directory, but it can return one that was
    // deleted between the dialog opening and the user clicking Choose.
    const clean = path.trim().replace(/\/+$/, '') || '/';
    if (!existsSync(clean) || !statSync(clean).isDirectory()) return null;
    return clean;
  } catch {
    // Cancelling is reported as a non-zero exit by every one of these, so a
    // failure here is indistinguishable from "no thanks" and is treated as it.
    return null;
  }
}

async function runPicker(kind, title) {
  if (kind === 'macos') {
    const script = `POSIX path of (choose folder with prompt ${JSON.stringify(title)})`;
    const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: 120000 });
    return stdout;
  }

  if (kind === 'zenity') {
    const { stdout } = await execFileAsync(
      'zenity', ['--file-selection', '--directory', `--title=${title}`], { timeout: 120000 },
    );
    return stdout;
  }

  if (kind === 'kdialog') {
    const { stdout } = await execFileAsync(
      'kdialog', ['--getexistingdirectory', process.cwd(), '--title', title], { timeout: 120000 },
    );
    return stdout;
  }

  if (kind === 'windows') {
    const ps = 'Add-Type -AssemblyName System.Windows.Forms;'
      + '$d = New-Object System.Windows.Forms.FolderBrowserDialog;'
      + `$d.Description = ${JSON.stringify(title)};`
      + 'if ($d.ShowDialog() -eq "OK") { $d.SelectedPath }';
    const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', ps], { timeout: 120000 });
    return stdout;
  }

  return null;
}
