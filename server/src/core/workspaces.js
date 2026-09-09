/**
 * Candidate workspaces for the `/set-workspace` picker.
 *
 * Pure except for the directory reads, which are all guarded: a picker that
 * throws because one candidate folder is unreadable is worse than a short list.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import * as paths from './paths.js';

/** True when `dir` exists and is a directory (following symlinks). */
export function isDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve what a user typed into an absolute path: `~` expands, relative paths
 * resolve against `base`, and a trailing slash is dropped.
 */
export function resolveWorkspaceInput(input, base = process.cwd()) {
  const raw = String(input || '').trim().replace(/^['"]|['"]$/g, '');
  if (!raw) return null;
  const expanded = raw === '~' || raw.startsWith('~/')
    ? path.join(os.homedir(), raw.slice(1))
    : raw;
  const abs = path.resolve(base, expanded);
  return abs.length > 1 ? abs.replace(/\/+$/, '') : abs;
}

/**
 * Why a path cannot be a workspace, or null if it can.
 *
 * `/workspace <path>` used to assign whatever string it was given, so a typo
 * left every tool rooted at a directory that does not exist and the failures
 * showed up much later, one tool call at a time.
 */
export function validateWorkspace(abs) {
  if (!abs) return 'No path given. Usage: `/workspace <path>`, or `/set-workspace` to pick one.';
  if (!fs.existsSync(abs)) return `No such directory: \`${abs}\``;
  if (!isDirectory(abs)) return `Not a directory: \`${abs}\``;
  try {
    fs.accessSync(abs, fs.constants.R_OK | fs.constants.X_OK);
  } catch {
    return `No permission to read: \`${abs}\``;
  }
  return null;
}

/** A directory that looks like a project is worth offering first. */
function looksLikeProject(dir) {
  return ['.git', 'package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'pom.xml']
    .some((marker) => fs.existsSync(path.join(dir, marker)));
}

function readRecents() {
  try {
    const parsed = JSON.parse(fs.readFileSync(paths.recentWorkspacesPath(), 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((p) => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

/** Record `workspace` as the most recently used one. Best effort. */
export function rememberWorkspace(workspace, limit = 10) {
  try {
    const next = [workspace, ...readRecents().filter((p) => p !== workspace)].slice(0, limit);
    paths.ensureParent(paths.recentWorkspacesPath());
    fs.writeFileSync(paths.recentWorkspacesPath(), JSON.stringify(next, null, 2));
    return next;
  } catch {
    return [];
  }
}

function siblingsOf(dir) {
  const parent = path.dirname(dir);
  if (parent === dir) return [];
  try {
    return fs.readdirSync(parent, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => path.join(parent, e.name));
  } catch {
    return [];
  }
}

/**
 * The list the picker shows: the current workspace first, then folders recently
 * worked in, then the neighbours of the current one that look like projects.
 *
 * @returns {Array<{ path: string, label: string, current: boolean }>}
 */
export function listWorkspaceCandidates(current, { limit = 12 } = {}) {
  const seen = new Set();
  const out = [];
  const add = (dir, note) => {
    if (!dir || seen.has(dir) || out.length >= limit) return;
    if (!isDirectory(dir)) return;
    seen.add(dir);
    out.push({
      path: dir,
      label: `${path.basename(dir) || dir}${note ? ` — ${note}` : ''}`,
      current: dir === current,
    });
  };

  add(current, 'current');
  for (const dir of readRecents()) add(dir, 'recent');
  for (const dir of siblingsOf(current)) {
    if (looksLikeProject(dir)) add(dir);
  }
  // Only if there is still room: neighbours with no project marker at all.
  for (const dir of siblingsOf(current)) add(dir);

  return out;
}
