/**
 * Past plans, listed.
 *
 * `artifacts/plan.md` is one file the agent overwrites, so every plan replaced
 * the last — including one you were half-way through reviewing. That was fixed
 * by copying each plan into `artifacts/plans/` as it is superseded, and then
 * nothing ever read the folder: plans accumulated where no command would show
 * them, which is its own kind of losing them.
 *
 * Files are named `<ISO timestamp>-<original name>`, so the name carries both
 * when it was archived and which artifact it came from.
 */

import fs from 'fs';
import path from 'path';
import * as paths from './paths.js';

/** `2026-09-10T14-32-05-plan.md` → the Date, or null if the name is not ours. */
export function stampOf(filename) {
  const m = String(filename).match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-/);
  if (!m) return null;
  const when = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}`);
  return Number.isNaN(when.getTime()) ? null : when;
}

/**
 * The first heading in a plan, which is what it is actually *about*.
 *
 * A list of timestamps tells you nothing about which plan you want. Bounded to
 * the first few lines: this runs once per file in the picker.
 */
export function titleOf(text) {
  for (const line of String(text ?? '').split('\n', 12)) {
    const heading = line.match(/^#{1,3}\s+(.*\S)/);
    if (heading) return heading[1].replace(/\s+/g, ' ').trim().slice(0, 70);
  }
  return '';
}

/**
 * Archived plans, newest first.
 *
 * @returns {Array<{name: string, path: string, when: Date|null, title: string, bytes: number}>}
 */
export function listPlans(workspace) {
  const dir = paths.planArchiveDir(workspace);
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.md'));
  } catch {
    return []; // no archive yet, which is the ordinary case on a new workspace
  }

  const plans = [];
  for (const name of names) {
    const full = path.join(dir, name);
    let bytes = 0;
    let title = '';
    try {
      bytes = fs.statSync(full).size;
      // Only the head: a plan can be long and only its first heading is wanted.
      title = titleOf(fs.readFileSync(full, 'utf8').slice(0, 4000));
    } catch {
      continue; // vanished or unreadable between readdir and now
    }
    plans.push({ name, path: full, when: stampOf(name), title, bytes });
  }

  // Newest first, and anything without a parseable stamp sorts last rather
  // than throwing the order off — the name is still a fine tiebreaker.
  return plans.sort((a, b) => {
    if (a.when && b.when) return b.when - a.when;
    if (a.when) return -1;
    if (b.when) return 1;
    return b.name.localeCompare(a.name);
  });
}
