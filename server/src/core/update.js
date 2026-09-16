/**
 * Noticing that this agent is out of date, and saying what to do about it.
 *
 * **Why this exists, and why the last part is the point.** Three artifacts ship
 * from one repo and *pulling only updates one of them*:
 *
 * - `server/` is live as soon as the process restarts.
 * - `extension/service-worker.js` is a **committed bundle**, which Chrome picks
 *   up only when the extension is reloaded.
 * - `extension/content-scripts/*.js` need the model tab hard-refreshed.
 * - `vscode-companion/*.vsix` has to be reinstalled by hand.
 *
 * So `git pull` leaves new server code talking to an old bridge, and the
 * symptom is the agent going quiet rather than an error. Anyone can lose an
 * afternoon to that once.
 *
 * The version check and the pull are the easy parts. The part worth building is
 * `reloadSteps()`: after a pull, the changed file list says exactly which of
 * those surfaces moved, so the reminder asks for the steps that matter and no
 * others. A standing "you may want to reload things" is the kind of notice
 * people stop reading.
 *
 * Nothing here throws. An update check that can break startup is worse than no
 * update check.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFileSync, writeFileSync, rmSync } from 'fs';
import { ensureParent, pendingReloadPath } from './paths.js';

const run = promisify(execFile);

/** Long enough for a slow network, short enough not to be a hang. */
const FETCH_TIMEOUT_MS = 10_000;

/** Run git in `dir`, or resolve null. Never throws, never rejects. */
async function git(dir, args, { timeout = 5000 } = {}) {
  try {
    const { stdout } = await run('git', args, { cwd: dir, timeout, windowsHide: true });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * The branch that *is* the released agent.
 *
 * Not the current branch's upstream, which is what this compared against
 * first. Work happens on a branch and lands on `main` through a PR — that is
 * the rule in `CLAUDE.md` — so `main` moving is the only thing that means
 * "there is a newer agent than the one you are running". A dev branch being
 * level with its own remote copy says nothing, and reporting it as "up to
 * date" answered a question nobody asked.
 */
export const UPDATE_BRANCH = 'main';

/**
 * Is there a newer agent than this one?
 *
 * Measured against `origin/main` whatever branch you happen to be on. On a
 * feature branch ahead of `main` the answer is no, correctly: nothing has been
 * released that you do not already have.
 *
 * @returns {Promise<{available: boolean, behind: number, branch: string|null,
 *                    upstream: string|null, reason?: string}>}
 */
export async function checkForUpdate(dir) {
  const none = { available: false, behind: 0, branch: null, upstream: null };
  if (!dir) return { ...none, reason: 'no source directory' };

  const inRepo = await git(dir, ['rev-parse', '--is-inside-work-tree']);
  if (inRepo !== 'true') return { ...none, reason: 'not a git checkout' };

  const branch = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);

  // The one network call, and the only reason this is async.
  await git(dir, ['fetch', 'origin', UPDATE_BRANCH, '--quiet'], { timeout: FETCH_TIMEOUT_MS });

  const upstream = `origin/${UPDATE_BRANCH}`;
  const exists = await git(dir, ['rev-parse', '--verify', '--quiet', upstream]);
  if (!exists) return { ...none, branch, reason: `no ${upstream}` };

  const counts = await git(dir, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`]);
  const behind = Number(counts?.split(/\s+/)[1] ?? 0);
  return {
    available: Number.isFinite(behind) && behind > 0,
    behind: Number.isFinite(behind) ? behind : 0,
    branch,
    upstream,
  };
}

/**
 * Is there uncommitted work in the agent's own repo?
 *
 * Asked by `/update` *after* it knows there is something to pull, not before.
 * Checking first meant a repo with local edits was refused with a complaint
 * about those edits even when there was nothing to update — the state of your
 * tree only matters once there is something to apply to it.
 *
 * `null` when it cannot be read, which callers treat as "do not claim it is
 * clean".
 */
export async function isDirty(dir) {
  const status = await git(dir, ['status', '--porcelain']);
  return status === null ? null : status !== '';
}

/**
 * Which surfaces a set of changed files touches.
 *
 * The whole value of the feature. A pull that only moved `server/` needs
 * nothing from the user beyond the restart that already happened; one that
 * touched the extension needs two specific actions in a specific order.
 *
 * @param {string[]} files - paths relative to the repo root
 * @returns {Array<{id: string, what: string, how: string}>}
 */
export function reloadSteps(files = []) {
  const steps = [];
  const touched = (re) => files.some((f) => re.test(f));

  // The bundle Chrome actually runs. Reloading the extension is what picks it
  // up; nothing else does.
  if (touched(/^extension\/(service-worker\.js|src\/|manifest\.json)/)) {
    steps.push({
      id: 'extension',
      what: 'Reload the Chrome extension',
      how: 'chrome://extensions → Agent CLI → the reload icon',
    });
  }

  // Content scripts are not bundled and are not re-injected into a page that
  // already has one. The tab keeps the old copy until it is refreshed.
  if (touched(/^extension\/content-scripts\//)) {
    steps.push({
      id: 'tabs',
      what: 'Hard-refresh the model tab',
      how: 'Cmd+Shift+R on gemini.google.com — the page keeps the old content script until you do',
    });
  }

  if (touched(/^vscode-companion\/.*\.vsix$/)) {
    steps.push({
      id: 'companion',
      what: 'Reinstall the VS Code companion',
      how: 'Extensions → ... → Install from VSIX, and pick the newest .vsix',
    });
  }

  return steps;
}

/** Did the pull change anything npm has to re-resolve? */
export const needsInstall = (files = []) =>
  files.some((f) => /(^|\/)package(-lock)?\.json$/.test(f));

/**
 * Pull the upstream, and report what changed.
 *
 * **Refuses on a dirty tree.** Someone's uncommitted work is not ours to
 * rebase, stash or clobber, and an update command that eats an afternoon's
 * edits is worse than no update command.
 *
 * @returns {Promise<{ok: boolean, error?: string, from?: string, to?: string,
 *                     files?: string[], steps?: Array, install?: boolean}>}
 */
export async function pullUpdate(dir) {
  const inRepo = await git(dir, ['rev-parse', '--is-inside-work-tree']);
  if (inRepo !== 'true') return { ok: false, error: 'The agent is not running from a git checkout.' };

  const dirty = await isDirty(dir);
  if (dirty === null) return { ok: false, error: 'Could not read the repository status.' };
  if (dirty) {
    return {
      ok: false,
      error: 'There are uncommitted changes in the agent\'s own repo. '
        + 'Commit or stash them first — `/update` will not pull over your work.',
    };
  }

  const from = await git(dir, ['rev-parse', 'HEAD']);
  // From the same place `checkForUpdate` measured against, or the two would
  // disagree about what an update even is. Fast-forward only: a branch with
  // its own commits is not behind `main` in a way a pull can settle, and
  // merging on someone's behalf is not this command's business.
  const pulled = await git(dir, ['pull', '--ff-only', '--quiet', 'origin', UPDATE_BRANCH],
    { timeout: FETCH_TIMEOUT_MS * 3 });
  if (pulled === null) {
    return {
      ok: false,
      error: `Could not fast-forward to origin/${UPDATE_BRANCH}. `
        + 'This branch has commits of its own, so it needs a merge by hand.',
    };
  }

  const to = await git(dir, ['rev-parse', 'HEAD']);
  if (from && to && from === to) return { ok: true, from, to, files: [], steps: [], install: false };

  const diff = await git(dir, ['diff', '--name-only', `${from}..${to}`]);
  const files = diff ? diff.split('\n').filter(Boolean) : [];
  return { ok: true, from, to, files, steps: reloadSteps(files), install: needsInstall(files) };
}

// ── The reminder that survives a restart ─────────────────────────────

/**
 * Steps waiting to be acknowledged.
 *
 * **Not read-once**, unlike the workspace handover it sits beside. The whole
 * failure this prevents is silent — an old bridge answering new server code —
 * so a reminder that scrolls past once and is gone would reproduce it. It stays
 * until the user says they have done it.
 *
 * In the home directory, because the browser extension and the editor companion
 * are yours rather than any one project's.
 *
 * Never throws: a reminder that cannot be written must not fail the update that
 * earned it, and one that cannot be read must not fail startup.
 */
export function savePendingReload(steps, meta = {}) {
  try {
    if (!steps?.length) return false;
    writeFileSync(ensureParent(pendingReloadPath()),
      JSON.stringify({ steps, ...meta, at: Date.now() }, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** @returns {{steps: Array, at?: number, to?: string}|null} */
export function readPendingReload() {
  try {
    const parsed = JSON.parse(readFileSync(pendingReloadPath(), 'utf8'));
    return Array.isArray(parsed?.steps) && parsed.steps.length ? parsed : null;
  } catch {
    return null;
  }
}

/** The user says they have done it. */
export function clearPendingReload() {
  try {
    rmSync(pendingReloadPath(), { force: true });
    return true;
  } catch {
    return false;
  }
}
