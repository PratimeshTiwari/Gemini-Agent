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
import { countToday } from './command-log.js';

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
  const commandsToday = safe(() => countToday(agentLoop.workspace), 0);

  const history = agentLoop?.conversationHistory || [];
  // Everything the tab holds, not just the turns kept locally — see
  // AgentLoop.contextTokens.
  const tokens = agentLoop?.contextTokens ?? 0;
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
      restore: (value) => `/effort ${value}`,
    },
    {
      group: 'Settings',
      label: 'Main model',
      value: main,
      hint: 'implements, and answers you',
      run: '/config',
      restore: (value) => `/config main ${value}`,
    },
    {
      group: 'Settings',
      label: 'Reviewer',
      value: reviewer || 'none',
      hint: reviewer ? 'duo — audits every non-trivial change' : 'solo — nothing reviews the work',
      run: '/config',
      restore: (value) => `/config reviewer ${value}`,
    },
    {
      group: 'Settings',
      label: 'Edit approval',
      value: agentLoop?.mode === 'auto' ? 'auto' : 'plan',
      hint: agentLoop?.mode === 'auto' ? 'safe edits apply on their own' : 'every edit shows a diff first',
      run: agentLoop?.mode === 'auto' ? '/plan' : '/auto',
      restore: (value) => `/${value}`,
    },
    {
      group: 'Settings',
      label: 'Memory',
      value: memoryOn ? 'on' : 'off',
      hint: memoryOn ? `${facts} fact${facts === 1 ? '' : 's'} recalled each session` : 'nothing learned, nothing recalled',
      // The direction, not the bare command: `/memory` on its own prints the
      // list of facts, which is not what pressing Enter on a switch should do.
      run: memoryOn ? '/memory off' : '/memory on',
      restore: (value) => `/memory ${value}`,
    },
    {
      group: 'Settings',
      label: 'Command rules',
      value: rules.enabled === false ? 'off' : 'on',
      hint: `${rules.allow?.length || 0} allowed · ${rules.block?.length || 0} blocked — enter to browse them`,
      run: '/allowlist',
      restore: (value) => `/allowlist ${value === 'on' ? 'enable' : 'disable'}`,
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
      label: 'Commands run',
      value: `${commandsToday} today`,
      hint: 'every shell command, kept per day — enter to read them',
      run: '/commands',
    },
    {
      group: 'Status',
      label: 'Extension',
      value: (() => {
        const ms = agentLoop?.extensionConnectMs;
        if (ms === undefined) return 'not connected yet';
        return ms < 1000 ? `connected in ${ms}ms` : `connected in ${(ms / 1000).toFixed(1)}s`;
      })(),
      hint: 'how long the browser bridge took to find this server',
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
      hint: `${Math.min(100, Math.round((tokens / limit) * 100))}% — counts the system prompt and tool results too`,
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
/**
 * What changed between two readings of the page.
 *
 * Settings here apply the moment you pick one — there is no staged copy to
 * save, so a "save or discard" prompt would be describing something that had
 * already happened. What is actually useful on the way out is a list of what
 * you just did, and a way to put it back.
 *
 * Only rows that know how to restore themselves are offered; the rest are
 * reported and left alone, which is honest about what an undo can reach.
 *
 * @returns {Array<{label: string, from: string, to: string, restore?: string}>}
 */
export function settingsChanged(before, after) {
  const was = new Map((before || []).map((row) => [row.label, row.value]));
  const changes = [];
  for (const row of after || []) {
    const from = was.get(row.label);
    if (from === undefined || from === row.value) continue;
    changes.push({
      label: row.label,
      from,
      to: row.value,
      ...(row.restore ? { restore: row.restore(from) } : {}),
    });
  }
  return changes;
}

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
