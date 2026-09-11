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
 * The tabs, in the order they are shown.
 *
 * Three, because there are three questions people actually open this to ask:
 * how is the agent set up, is it connected to anything, and what is in the
 * window right now. A fourth tab with two rows in it is a worse answer than a
 * third tab with six.
 */
export const SETTING_GROUPS = ['Settings', 'Status', 'Context'];

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

  const history = agentLoop?.conversationHistory || [];
  const tokens = history.reduce((sum, turn) => {
    const text = turn?.content || JSON.stringify(turn?.result || turn?.args || '');
    return sum + Math.ceil(String(text).length / 4);
  }, 0);
  const limit = agentLoop?.contextManager?.maxTokens || 50000;
  const pending = safe(() => agentLoop.diffEngine.getPendingDiffs().length, 0);
  const applied = safe(() => agentLoop.diffEngine.appliedDiffs.length, 0);

  return [
    {
      group: 'Settings',
      label: 'Effort',
      value: effort.id,
      hint: `browser tab: ${effort.browser}`,
      run: '/effort',
    },
    {
      group: 'Settings',
      label: 'Main model',
      value: main,
      hint: 'implements, and answers you',
      run: '/config',
    },
    {
      group: 'Settings',
      label: 'Reviewer',
      value: reviewer || 'none',
      hint: reviewer ? 'duo — audits every non-trivial change' : 'solo — nothing reviews the work',
      run: '/config',
    },
    {
      group: 'Settings',
      label: 'Edit approval',
      value: agentLoop?.mode === 'auto' ? 'auto' : 'plan',
      hint: agentLoop?.mode === 'auto' ? 'safe edits apply on their own' : 'every edit shows a diff first',
      run: agentLoop?.mode === 'auto' ? '/plan' : '/auto',
    },
    {
      group: 'Settings',
      label: 'Memory',
      value: memoryOn ? 'on' : 'off',
      hint: memoryOn ? `${facts} fact${facts === 1 ? '' : 's'} recalled each session` : 'nothing learned, nothing recalled',
      run: '/memory',
    },
    {
      group: 'Settings',
      label: 'Command rules',
      value: rules.enabled === false ? 'off' : 'on',
      hint: `${rules.allow?.length || 0} allowed · ${rules.block?.length || 0} blocked`,
      run: '/allowlist',
    },
    {
      group: 'Settings',
      label: 'Skill folders',
      value: String((agentLoop?.skillFolders || []).length + 2),
      hint: 'this project, yours, plus any added by hand',
      run: '/skills',
    },
    {
      group: 'Status',
      label: 'GitHub',
      value: github.username ? `@${github.username}` : 'not connected',
      hint: github.username ? 'PR dashboard on ctrl+o' : 'ctrl+o to add a token',
      run: '/github',
    },
    {
      group: 'Status',
      label: 'Workspace',
      value: agentLoop?.workspace || '',
      hint: scope ? `scope: ${scope} — set at launch with --scope` : 'the files the agent reads and edits',
      run: '/workspace',
    },
    {
      group: 'Settings',
      label: 'Agent name',
      value: mc.agentName || agentLoop?.agentName || 'Agent CLI',
      hint: 'shown in the banner',
    },
    {
      group: 'Status',
      label: 'State directory',
      value: safe(() => paths.agentDir(agentLoop.workspace), ''),
      hint: 'config, sessions, memory, plans, logs',
      run: '/agent-dir',
    },
    {
      group: 'Context',
      label: 'Turns',
      value: String(history.length),
      hint: 'user and agent messages in this session',
    },
    {
      group: 'Context',
      label: 'Tokens',
      value: `~${tokens.toLocaleString()} / ${limit.toLocaleString()}`,
      hint: `${Math.min(100, Math.round((tokens / limit) * 100))}% of the budget`,
      run: '/compact',
    },
    {
      group: 'Context',
      label: 'Diffs',
      value: `${pending} pending`,
      hint: `${applied} applied — \`/undo\` steps back one`,
      run: applied > 0 ? '/undo' : undefined,
    },
    {
      group: 'Context',
      label: 'Session',
      value: `${history.length} turn${history.length === 1 ? '' : 's'} kept`,
      hint: 'saved next to the project and under ~/.agent',
      run: '/clear',
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
export function filterSettings(rows, query, group = null) {
  const inGroup = group ? rows.filter((row) => row.group === group) : rows;
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return inGroup;

  // Typing searches *everything*, not just the tab you happen to be on. Making
  // someone find the right tab before they can search for a setting is asking
  // them to know the answer first.
  const pool = q ? rows : inGroup;
  return pool.filter((row) =>
    `${row.label} ${row.value} ${row.hint || ''}`.toLowerCase().includes(q));
}

function safe(fn, fallback) {
  try {
    return fn() ?? fallback;
  } catch {
    return fallback;
  }
}
