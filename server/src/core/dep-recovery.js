/**
 * A dependency the code imports and the tree does not have, recovered from
 * instead of died on.
 *
 * **The report this exists for.** The owner switched refs to test `/update` and
 * got this, with no way forward but a manual `npm i`:
 *
 * ```
 * 💥 Fatal initialization error: Cannot find package 'figlet'
 *    imported from server/src/ui/App.jsx
 * ```
 *
 * That was not `/update`'s fault — `release-1.0` is the only ref whose
 * `App.jsx` still imports `figlet`, so its code met this branch's
 * `node_modules`, which is the ordinary consequence of checking out another
 * ref. What is a fault is the response: the process **dies**. Whatever puts the
 * two out of sync — a branch switch, a pull that changes dependencies — the
 * answer is always the same command, and the agent knows it. Asked for twice:
 * *"I want npm i to be done and restart auto as a graceful recovery."*
 *
 * **Once is the whole design.** An install that does not fix the import must
 * not become a boot loop, which is the parse-repair bug in a new place and
 * worse here, because there is no UI up to stop it from. The retry happens in a
 * *different process*, so nothing in memory survives to say "already tried" and
 * the marker has to be a file — the same reason `next-workspace` is one. It
 * **fails closed**: a marker that cannot be read or written means no attempt,
 * because one manual `npm i` is cheaper than an unbounded loop.
 *
 * Nothing here throws. Every entry point answers with a reason instead, because
 * every caller is already on a failure path.
 */

import { spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'fs';
import path from 'path';
import { ensureParent, depRecoveryPath } from './paths.js';

/**
 * Long enough for a cold npm cache on a slow network, short enough that a hung
 * registry does not look like a hung agent forever.
 */
export const INSTALL_TIMEOUT_MS = 300_000;

/** npm is a `.cmd` shim on Windows, and `spawn` without a shell needs the real name. */
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/**
 * Package names npm will accept: an optional `@scope/`, then a name of
 * url-safe characters. Deliberately conservative — anything that does not look
 * like a package name is something this did not understand, and the honest
 * answer to that is to leave it to the user rather than hand a guess to `npm`.
 */
const PACKAGE_NAME = /^(?:@[a-z0-9-*~][a-z0-9-*._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/**
 * The package a startup failure was asking for, or `null`.
 *
 * **Measured rather than assumed, because Node words it two ways and this
 * project sees both.** Probed against the real shapes on 2026-09-20:
 *
 * | loader | code | message |
 * | --- | --- | --- |
 * | ESM | `ERR_MODULE_NOT_FOUND` | ``Cannot find package 'figlet' imported from …`` |
 * | ESM, missing *file* | `ERR_MODULE_NOT_FOUND` | ``Cannot find module '/abs/path.js' imported from …`` |
 * | CJS, and **tsx** | `MODULE_NOT_FOUND` | ``Cannot find module 'figlet'`` |
 * | a builtin typo | `ERR_UNKNOWN_BUILTIN_MODULE` | ``No such built-in module: node:nope`` |
 *
 * Three things fall out of that table, and two of them are the reason this is
 * a function rather than one regex at the call site.
 *
 * **The agent runs under `tsx`, and tsx reports a missing package from a
 * `.jsx` file in the CJS shape** — `MODULE_NOT_FOUND`, "module", no "imported
 * from". The owner's report shows the ESM wording for the same package, so
 * which one arrives depends on the path the import took. Handling only the
 * code that carries the useful name would have missed the shape this project
 * actually hits most.
 *
 * **A missing *file* must be excluded.** `npm i` cannot conjure one, so
 * installing burns a restart to change nothing — and because the attempt is
 * recorded, it also burns the one a genuine missing package would have had.
 * The specifier is what decides, not the wording: ESM has already resolved a
 * relative import to an absolute path by the time it reports it, and tsx
 * passes it through as written, so both reduce to something that is not a
 * package name. `packageFromSpecifier` is where that is done and why it is
 * one step rather than a list of prefixes.
 *
 * **A subpath is not a package.** ESM reduces it for us (`figlet/lib/x.js` is
 * reported as `'figlet'`); tsx does not, so `foo/bar` is cut to `foo` and
 * `@scope/name/sub` to `@scope/name` here.
 *
 * @param {unknown} err
 * @returns {string|null} a package name, or null if this is not a missing one
 */
export function missingPackage(err) {
  const code = err?.code;
  if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') return null;

  const message = typeof err?.message === 'string' ? err.message : '';
  const found = /Cannot find (package|module) '([^']+)'/.exec(message);
  if (!found) return null;

  // Both wordings are matched above and neither is trusted to classify on its
  // own: under tsx, "module" is how a missing *package* is reported. The
  // specifier is the evidence, and `packageFromSpecifier` is what reads it.
  return packageFromSpecifier(found[2]);
}

/**
 * Reduce an import specifier to the package `npm install` would fetch, or
 * `null` when it is not one.
 *
 * Split out so the exclusions are testable on their own: every one of them is
 * a case where installing would be wrong rather than merely useless.
 */
export function packageFromSpecifier(specifier) {
  if (typeof specifier !== 'string' || !specifier) return null;

  // Reduce to the package root first: `foo/bar` installs `foo`, and
  // `@scope/name/sub` installs `@scope/name`. ESM has already done this, tsx
  // has not.
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];

  // `~/x.js` is the one path spelling that reaches here looking like a name,
  // because `~` is legal in a package name and reducing leaves it alone.
  if (name === '~') return null;

  // And that is the only explicit exclusion, which is a measured claim rather
  // than an oversight. Reducing then validating already rejects every other
  // path and URL shape on its own: `./x` and `../x` reduce to `.` and `..`,
  // an absolute path reduces to the empty string, `C:\repo\x.js` keeps its
  // colon and backslash, `node:fs` its colon, and a bare `@scope` its `@` —
  // none of which this matches. Three further guards were written here and
  // deleted after a negative control showed no input could reach them; guards
  // that cannot fail are the vacuous assertions this repo keeps finding.
  return PACKAGE_NAME.test(name) ? name : null;
}

/**
 * Where `npm install` has to run.
 *
 * **The lockfile is the answer, not the nearest `package.json`.** This repo is
 * npm workspaces: `server/package.json` is a workspace *member* and there is
 * exactly one `package-lock.json`, at the root. Installing from `server/`
 * would resolve a different tree from the one the lockfile describes, which is
 * how a recovery quietly makes things worse. Walking up for the lockfile lands
 * on the root here and on the project root in a plain checkout, with no
 * special case for either.
 *
 * Falls back to the nearest `package.json` only when there is no lockfile at
 * all, which is a checkout nobody has installed yet.
 *
 * @param {string} from - a directory inside the agent's own source
 * @returns {string|null}
 */
export function installRoot(from) {
  let dir = path.resolve(from);
  let fallback = null;

  for (;;) {
    if (existsSync(path.join(dir, 'package-lock.json'))) return dir;
    if (!fallback && existsSync(path.join(dir, 'package.json'))) fallback = dir;

    const up = path.dirname(dir);
    if (up === dir) return fallback;
    dir = up;
  }
}

// ── The marker that makes it happen once ─────────────────────────────

/**
 * Has an automatic install already been tried?
 *
 * @returns {{ok: true, attempt: object|null} | {ok: false}} `ok: false` is
 *   "could not tell", which callers must treat as "do not try" — see the
 *   fail-closed note at the top of this file.
 */
export function readAttempt() {
  try {
    return { ok: true, attempt: JSON.parse(readFileSync(depRecoveryPath(), 'utf8')) };
  } catch (err) {
    // No marker is a successful answer, and the common one. Anything else —
    // unreadable, unparseable, a permission problem — is a failure to ask.
    if (err?.code === 'ENOENT') return { ok: true, attempt: null };
    return { ok: false };
  }
}

/** Record the attempt. `false` means it could not be recorded, so do not make it. */
export function recordAttempt(pkg, root) {
  try {
    writeFileSync(ensureParent(depRecoveryPath()),
      JSON.stringify({ package: pkg, root, at: Date.now() }, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Forget the attempt, so the next genuine occurrence gets its own.
 *
 * Called from a boot that has drawn the UI, which is the point at which every
 * import in the startup graph is known to have resolved.
 */
export function clearAttempt() {
  try {
    rmSync(depRecoveryPath(), { force: true });
    return true;
  } catch {
    return false;
  }
}

// ── Doing it ─────────────────────────────────────────────────────────

/**
 * `npm install`, with no package named.
 *
 * **Deliberately not `npm install <the missing package>`**, which is a
 * different command: it writes a new dependency into `package.json`. In the
 * reported case that would have added `figlet` back to a project that removed
 * it on purpose, leaving an unasked-for diff in the user's tree and a
 * dependency the code does not use. A bare install reconciles the tree with
 * what this ref already declares, which is exactly the fault being repaired,
 * and it fixes every missing package at once rather than one per restart.
 *
 * @param {string} root
 * @param {{stdio?: 'inherit'|'pipe', timeout?: number}} opts - `inherit` on the
 *   startup path, where there is no UI to corrupt and progress is worth seeing;
 *   `pipe` under the live Ink frame, where stray output is a frame regression.
 * @returns {Promise<{ok: boolean, output?: string, error?: string}>}
 */
export function installDependencies(root, { stdio = 'pipe', timeout = INSTALL_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(NPM, ['install'], { cwd: root, stdio, windowsHide: true });
    } catch (err) {
      resolve({ ok: false, error: err.message });
      return;
    }

    let output = '';
    const collect = (chunk) => { output += chunk; };
    child.stdout?.setEncoding('utf8').on('data', collect);
    child.stderr?.setEncoding('utf8').on('data', collect);

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ ok: false, error: `npm install did not finish within ${Math.round(timeout / 1000)}s.` });
    }, timeout);
    timer.unref?.();

    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.on('error', (err) => done({ ok: false, error: err.message }));
    child.on('close', (code) => done(code === 0
      ? { ok: true, output }
      // The tail, not the whole log: npm is verbose and this goes on a
      // terminal that may have a live frame on it.
      : { ok: false, error: output.trim().split('\n').slice(-8).join('\n') || `npm install exited ${code}` }));
  });
}

/**
 * The whole recovery: decide, record, install, and say whether to restart.
 *
 * The order matters. The marker is written **before** the install, not after,
 * so that an install which is killed half-way — or which corrupts the tree and
 * crashes the next boot the same way — still counts as the one attempt. Writing
 * it afterwards would mean a crash during the install left no record and the
 * next boot tried again, which is the loop this is built to prevent.
 *
 * `announce` is called once, immediately before the install, with the package
 * and the directory. It exists because of the ordering: with `stdio:
 * 'inherit'` npm's own output streams out live, so anything printed *after*
 * the install arrives underneath several lines of npm, and the first thing the
 * user sees is noise rather than the reason for it. The caller supplies the
 * words — this module prints nothing on its own, because one of its two
 * callers is running under a live Ink frame that stray output would corrupt.
 *
 * @param {unknown} err - the failure that reached the top of startup
 * @param {{from?: string, install?: Function, stdio?: string,
 *          announce?: (info: {package: string, root: string}) => void}} opts
 * @returns {Promise<{ok: boolean, package?: string, root?: string,
 *                    restart?: boolean, reason?: string, error?: string}>}
 */
export async function recoverMissingDependency(err, opts = {}) {
  const { from, install = installDependencies, stdio = 'inherit', announce } = opts;

  const pkg = missingPackage(err);
  if (!pkg) return { ok: false, reason: 'not-a-missing-package' };

  const root = from ? installRoot(from) : null;
  if (!root) return { ok: false, reason: 'no-install-root', package: pkg };

  const seen = readAttempt();
  if (!seen.ok) return { ok: false, reason: 'marker-unreadable', package: pkg, root };
  if (seen.attempt) {
    return { ok: false, reason: 'already-tried', package: pkg, root, previous: seen.attempt };
  }

  if (!recordAttempt(pkg, root)) {
    return { ok: false, reason: 'marker-unwritable', package: pkg, root };
  }

  // After the marker, so a caller that announces cannot be made to say it
  // twice by a marker write that failed.
  try { announce?.({ package: pkg, root }); } catch { /* a message is not worth failing over */ }

  const outcome = await install(root, { stdio });
  if (!outcome.ok) {
    return { ok: false, reason: 'install-failed', package: pkg, root, error: outcome.error };
  }

  return { ok: true, package: pkg, root, restart: true };
}

/**
 * What to print when the recovery did not happen, by reason.
 *
 * One place rather than at the call site, because the whole value of this
 * feature to someone watching it fail is being told which of these it was —
 * "already tried" and "install failed" call for different next moves, and the
 * old message (*"Recovering gracefully… please check your configuration and
 * restart"*) described neither, having done no recovering at all.
 */
export function explainFailure(outcome) {
  const manual = (root) => `Run \`npm install\`${root ? ` in ${root}` : ''} and start again.`;

  switch (outcome?.reason) {
    case 'already-tried':
      return `\`${outcome.package}\` is still missing after an automatic \`npm install\`, `
        + 'so this one is not something a reinstall fixes.\n'
        + manual(outcome.root);
    case 'install-failed':
      return `Tried \`npm install\` for \`${outcome.package}\` and it failed:\n\n`
        + `${outcome.error}\n\n${manual(outcome.root)}`;
    case 'marker-unreadable':
    case 'marker-unwritable':
      return 'Could not record whether an automatic install had already been tried, '
        + 'so none was attempted rather than risk a boot loop.\n'
        + manual(outcome.root);
    case 'no-install-root':
      return `\`${outcome.package}\` is missing, but no \`package-lock.json\` or `
        + '`package.json` could be found to install from.';
    default:
      return null;
  }
}
