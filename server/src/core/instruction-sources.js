import { existsSync, statSync } from 'fs';
import * as paths from './paths.js';
import { listSkills, skillSearchPath } from './skills.js';

/**
 * What is actually feeding the prompt, and from where.
 *
 * `PromptBuilder` resolves three instruction sources on every full prompt — a
 * walked chain of `AGENT.md`, `memory.md`, and a skill catalogue across up to 66
 * candidate directories — and then threw the resolution away: `_loadAgentMd`
 * built a `files` array, concatenated it, and returned a string. `/context` and
 * the Context tab reported **how much** was in the window and never **what**.
 *
 * So "which files is it reading?" had no answer anywhere in the product, and the
 * consequence was not hypothetical: this repo's own `AGENT.md` is the unedited
 * stock template — six headings, five "describe your project here" comments —
 * going into every turn-0 prompt as this project's context, for weeks, with
 * nothing able to say so.
 *
 * This is deliberately a *report*, not a registry. The answer to "I cannot tell
 * which files are in play" is to show the walk, not to add a second way of
 * declaring files — that is `contextFolders`, which `## Direction` phase 2
 * removed on purpose.
 */

/** A row per source, with enough to act on and nothing more. */
export function describeInstructionSources(agentLoop) {
  if (!agentLoop) return [];
  const workspace = agentLoop.workspace;
  const rows = [];

  // ── AGENT.md, as walked ────────────────────────────────────────────
  //
  // Read from the builder rather than re-walked, so this cannot disagree with
  // what was sent. It is populated on the first full prompt; before that there
  // is nothing to report and saying so is better than guessing.
  const walked = agentLoop.promptBuilder?.lastAgentMdFiles;
  if (!walked) {
    rows.push({
      group: 'AGENT.md', label: '—', state: 'pending',
      detail: 'read on the first prompt of a session',
    });
  } else if (walked.length === 0) {
    rows.push({
      group: 'AGENT.md', label: '—', state: 'absent',
      detail: 'none found between the code and the state root',
    });
  } else {
    for (const file of walked) {
      rows.push({
        group: 'AGENT.md',
        label: shorten(file.path, workspace),
        state: file.state,
        detail: file.state === 'template'
          ? 'looks like the unedited template — it is being sent as your project context'
          : file.state === 'unreadable'
            ? (file.detail || 'could not be read')
            : `${file.bytes} bytes`,
        path: file.path,
      });
    }
  }

  // ── memory.md ──────────────────────────────────────────────────────
  const memFile = paths.memoryPath(workspace);
  const facts = safe(() => agentLoop.memoryManager?.getAllMemories?.() || [], []);
  const memoryOn = safe(() => agentLoop.memoryManager?.isMemoryEnabled?.() !== false, true);
  rows.push({
    group: 'memory',
    label: shorten(memFile, workspace),
    state: !existsSync(memFile) ? 'absent' : (!memoryOn ? 'off' : (facts.length ? 'loaded' : 'empty')),
    detail: !memoryOn
      ? 'memory is off — nothing is recalled'
      : `${facts.length} fact${facts.length === 1 ? '' : 's'}`,
    path: existsSync(memFile) ? memFile : undefined,
  });

  // ── skills ─────────────────────────────────────────────────────────
  //
  // Every directory on the search path, not only the ones that exist: a
  // configured folder that has been deleted or mistyped contributes nothing and
  // said nothing, because `/skills dir add` validates once, at the door, and
  // nothing re-checks it afterwards.
  const configured = new Set(agentLoop.skillFolders || []);
  const skills = safe(() => listSkills(workspace, agentLoop.skillFolders || []), []);
  const byDir = new Map();
  for (const skill of skills) {
    const dir = skill.file ? skill.file.replace(/\/[^/]+\/?[^/]*$/, '') : '';
    byDir.set(dir, (byDir.get(dir) || 0) + 1);
  }

  for (const dir of safe(() => skillSearchPath(workspace, agentLoop.skillFolders || []), [])) {
    const isConfigured = configured.has(dir);
    const exists = existsSync(dir) && safe(() => statSync(dir).isDirectory(), false);
    const count = [...byDir.entries()]
      .filter(([d]) => d.startsWith(dir))
      .reduce((n, [, c]) => n + c, 0);

    // The walked directories are mostly absent by design — every level between
    // the code and the root is a candidate — so listing them all is noise.
    // A configured one is different: you asked for it, so its absence is news.
    if (!exists && !isConfigured) continue;

    rows.push({
      group: 'skills',
      label: shorten(dir, workspace),
      state: !exists ? 'missing' : (count ? 'loaded' : 'empty'),
      detail: !exists
        ? 'you added this folder and it is not there any more'
        : `${count} skill${count === 1 ? '' : 's'}`,
      path: exists ? dir : undefined,
    });
  }

  return rows;
}

/** Paths relative to the workspace where that helps, `~` where it does not. */
function shorten(file, workspace) {
  if (!file) return '—';
  if (workspace && file.startsWith(`${workspace}/`)) return file.slice(workspace.length + 1);
  const home = process.env.HOME;
  if (home && file.startsWith(`${home}/`)) return `~/${file.slice(home.length + 1)}`;
  return file;
}

function safe(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}
