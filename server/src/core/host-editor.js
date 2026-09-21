/**
 * Which editor is hosting this terminal.
 *
 * Reported from use: `/open agent.md` from a terminal inside Antigravity opened
 * the file in **RStudio**. Nothing was misconfigured — the chain simply had
 * nothing good to pick from:
 *
 * 1. `EDITOR` was unset, so the default `'code'` was used.
 * 2. `code` is not on PATH (installing a VS Code *fork* does not put it there).
 * 3. The fallback `open <file>` asks macOS for the default app for `.md`,
 *    which was RStudio.
 *
 * Every step behaved as designed and the answer was still wrong, because none
 * of them asked the question that matters: **which editor is this terminal
 * running inside?** A VS Code-family integrated terminal says so plainly —
 * `TERM_PROGRAM=vscode`, and `VSCODE_GIT_ASKPASS_NODE` pointing into the app
 * bundle that launched it:
 *
 *     /Applications/Antigravity IDE.app/Contents/Frameworks/…/Antigravity IDE Helper
 *
 * From that the CLI is findable — `Contents/Resources/app/bin/antigravity-ide`
 * — and opening a file there puts it in the window the person is already
 * looking at, which is the whole point of the companion being installed in it.
 *
 * Deliberately does **not** override `--editor` or `$EDITOR`. Those are
 * explicit choices; this only replaces the hardcoded `'code'` guess, which was
 * never better than a guess.
 */

import { existsSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';

/** How far up from the askpass helper the app root can be. */
const MAX_WALK = 12;

/** Is this a file we could actually run? */
function isExecutable(file) {
  try {
    const stat = statSync(file);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * The launcher inside an app directory, if there is exactly one place to look.
 *
 * Two shapes, because the platforms package differently: macOS keeps the CLI at
 * `Contents/Resources/app/bin/`, Linux at `<install>/bin/`. Both hold one
 * script named for the product — `code`, `cursor`, `antigravity-ide`.
 */
function binIn(dir) {
  for (const candidate of [join(dir, 'Contents', 'Resources', 'app', 'bin'), join(dir, 'bin')]) {
    if (!existsSync(candidate)) continue;
    let entries;
    try {
      entries = readdirSync(candidate);
    } catch {
      continue;
    }
    // Skip the helpers that ship beside the launcher in some builds.
    const launcher = entries
      .filter((name) => !name.endsWith('.cmd') && !name.endsWith('.bat') && name !== 'remote-cli')
      .map((name) => join(candidate, name))
      .find(isExecutable);
    if (launcher) return launcher;
  }
  return null;
}

/**
 * The CLI of the editor hosting this terminal, or null.
 *
 * Null whenever the answer is not a fact — a plain terminal, an unrecognised
 * host, an app whose CLI is not where it should be. A wrong guess here opens
 * the wrong application, which is exactly the bug this exists to fix.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null} absolute path to the launcher
 */
export function hostEditor(env = process.env) {
  if (env.TERM_PROGRAM !== 'vscode') return null;

  const anchor = env.VSCODE_GIT_ASKPASS_NODE || env.VSCODE_GIT_ASKPASS_MAIN;
  if (!anchor) return null;

  let dir = dirname(anchor);
  for (let i = 0; i < MAX_WALK && dir && dir !== dirname(dir); i += 1) {
    const found = binIn(dir);
    if (found) return found;
    dir = dirname(dir);
  }
  return null;
}

