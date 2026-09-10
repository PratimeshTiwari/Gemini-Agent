/**
 * Everything that is set, on one page.
 *
 * `/help` answers "what can I type?" — a list of verbs. This answers "how is
 * this thing configured right now?", which is a list of nouns and their
 * values, and there was no way to ask it: the answer was spread across
 * `/config`, `/effort`, `/memory`, `/allowlist` and the status bar, one
 * command per fact.
 *
 * Each row knows what to run when you pick it, so the page is navigable rather
 * than a printout — and the running is delegated to the commands that already
 * own each setting, so there is no second way to change anything.
 *
 * @typedef {object} SettingRow
 * @property {string} label   what it is
 * @property {string} value   what it is set to, right now
 * @property {string} [hint]  the consequence, when the value alone is cryptic
 * @property {string} [run]   slash command to run when picked; absent = read-only
 */

import { resolveEffort } from './effort.js';
import * as paths from './paths.js';

/**
 * Build the page.
 *
 * Takes the loop rather than reading config off disk: these are the values in
 * force this second, which is the entire question being asked. Every field is
 * read defensively — a settings page that throws is worse than one with a gap.
 *
 * @returns {SettingRow[]}
 */
export function describeSettings(agentLoop) {
  const mc = agentLoop?.modelConfig || {};
  const effort = resolveEffort(mc.effort);
  const main = mc.main || 'gemini';
  const reviewer = mc.reviewer && mc.reviewer !== main ? mc.reviewer : null;
  const rules = agentLoop?.commandRules || { enabled: true, allow: [], block: [] };
  const memoryOn = agentLoop?.memoryManager?.isMemoryEnabled?.() !== false;
  const facts = memoryOn ? (agentLoop?.memoryManager?.getAllMemories?.() || []).length : 0;
  const scope = safe(() => paths.getActiveScope(agentLoop.workspace), '');
  const github = agentLoop?.githubHandler?.getStatus?.() || {};

  return [
    {
      label: 'Effort',
      value: effort.id,
      hint: `browser tab: ${effort.browser}`,
      run: '/effort',
    },
    {
      label: 'Main model',
      value: main,
      hint: 'implements, and answers you',
      run: '/config',
    },
    {
      label: 'Reviewer',
      value: reviewer || 'none',
      hint: reviewer ? 'duo — audits every non-trivial change' : 'solo — nothing reviews the work',
      run: '/config',
    },
    {
      label: 'Edit approval',
      value: agentLoop?.mode === 'auto' ? 'auto' : 'plan',
      hint: agentLoop?.mode === 'auto' ? 'safe edits apply on their own' : 'every edit shows a diff first',
      run: agentLoop?.mode === 'auto' ? '/plan' : '/auto',
    },
    {
      label: 'Memory',
      value: memoryOn ? 'on' : 'off',
      hint: memoryOn ? `${facts} fact${facts === 1 ? '' : 's'} recalled each session` : 'nothing learned, nothing recalled',
      run: '/memory',
    },
    {
      label: 'Command rules',
      value: rules.enabled === false ? 'off' : 'on',
      hint: `${rules.allow?.length || 0} allowed · ${rules.block?.length || 0} blocked`,
      run: '/allowlist',
    },
    {
      label: 'Skill folders',
      value: String((agentLoop?.skillFolders || []).length + 2),
      hint: 'this project, yours, plus any added by hand',
      run: '/skills',
    },
    {
      label: 'GitHub',
      value: github.username ? `@${github.username}` : 'not connected',
      hint: github.username ? 'PR dashboard on ctrl+o' : 'ctrl+o to add a token',
      run: '/github',
    },
    {
      label: 'Workspace',
      value: agentLoop?.workspace || '',
      hint: scope ? `scope: ${scope} — set at launch with --scope` : 'the files the agent reads and edits',
      run: '/workspace',
    },
    {
      label: 'Agent name',
      value: mc.agentName || agentLoop?.agentName || 'Agent CLI',
      hint: 'shown in the banner',
    },
    {
      label: 'State directory',
      value: safe(() => paths.agentDir(agentLoop.workspace), ''),
      hint: 'config, sessions, memory, plans, logs',
      run: '/agent-dir',
    },
  ].filter((row) => row.value !== '');
}

/**
 * Rows matching what has been typed.
 *
 * Matches the label, the value and the hint, because people look for a setting
 * by any of the three — "duo" is not in any label but it is exactly what
 * someone types when they want to know whether a reviewer is on.
 */
export function filterSettings(rows, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((row) =>
    `${row.label} ${row.value} ${row.hint || ''}`.toLowerCase().includes(q));
}

function safe(fn, fallback) {
  try {
    return fn() ?? fallback;
  } catch {
    return fallback;
  }
}
