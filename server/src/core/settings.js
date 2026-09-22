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

import fs from 'fs';
import { resolveEffort } from './effort.js';
import { browserModelPin } from './model-match.js';
import * as paths from './paths.js';
import { countToday } from './command-log.js';
import { describeInstructionSources } from './instruction-sources.js';

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
/** Read something that may not be there, without taking the screen down. */
function safeRead(fn, fallback) {
  try { return fn() ?? fallback; } catch { return fallback; }
}

export function describeSettings(agentLoop) {
  const mc = agentLoop?.modelConfig || {};
  // The on-disk config, for keys that live there rather than on the loop.
  // `agentName` is one: the banner reads it from the file, so the screen has
  // to read it from the same place or the two disagree.
  const cfg = safeRead(() => JSON.parse(
    fs.readFileSync(paths.configPath(agentLoop.workspace), 'utf8'),
  ), {});
  const effort = resolveEffort(mc.effort);
  const main = mc.main || 'gemini';
  const subagents = mc.subagents !== false;
  const rules = agentLoop?.commandRules || { enabled: true, allow: [], block: [] };
  const memoryOn = agentLoop?.memoryManager?.isMemoryEnabled?.() !== false;
  const facts = memoryOn ? (agentLoop?.memoryManager?.getAllMemories?.() || []).length : 0;
  const scope = safe(() => paths.getActiveScope(agentLoop.workspace), '');
  const commandsToday = safe(() => countToday(agentLoop.workspace), 0);

  const history = agentLoop?.conversationHistory || [];
  // Everything the tab holds, not just the turns kept locally — see
  // AgentLoop.contextTokens.
  const tokens = agentLoop?.contextTokens ?? 0;
  const limit = agentLoop?.contextLimit || 50000;
  const pending = safe(() => agentLoop.diffEngine.getPendingDiffs().length, 0);
  const applied = safe(() => agentLoop.diffEngine.appliedDiffs.length, 0);

  return [
    {
      group: 'Settings',
      label: 'Effort',
      value: effort.id,
      // The pin wins the hint when there is one: `effort.browser` is what the
      // rung is written for, and the pin is what this install actually asks
      // the picker for. Showing the first while the second is in force is how
      // a settings page starts lying about itself.
      hint: browserModelPin(mc, effort.id)
        ? `browser tab: ${browserModelPin(mc, effort.id)} (pinned)`
        : `browser tab: ${effort.browser}`,
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
      label: 'Subagents',
      value: subagents ? 'on' : 'off',
      hint: subagents
        ? 'parallel tabs with empty context — research, review, errands'
        : 'one tab, start to finish — nothing can be delegated',
      run: '/config',
      restore: (value) => `/config subagents ${value}`,
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
      label: 'Workspace',
      value: agentLoop?.workspace || '',
      hint: scope ? `scope: ${scope} — set at launch with --scope` : 'the files the agent reads and edits',
      run: '/workspace',
    },
    {
      group: 'Settings',
      label: 'Agent name',
      // `config.agentName`, which is where the banner reads it. This used to
      // read `modelConfig.agentName` — a key nothing has ever written — so the
      // screen reported "Agent CLI" while the banner said something else.
      value: cfg?.agentName || 'Agent CLI',
      hint: 'shown in the banner — enter to rename, empty to clear',
      // `/name` with no argument only *prints* the current name, so this row
      // promised a change and delivered a paragraph. It opens an editor now;
      // `Menus.jsx` runs `/name <text>` with what you type.
      run: '/name',
      edits: 'name',
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
    // What the prompt is actually being told about this project.
    //
    // The Context tab reported how *much* was in the window — turns, tokens,
    // diffs — and never *what*. `CLAUDE.md` already defines bare `/context` as
    // "a report of what is in the window"; this is the half that was missing,
    // rather than a new surface. Each row is a real file, so Enter opens it.
    ...describeInstructionSources(agentLoop).map((source) => ({
      group: 'Context',
      label: source.group === 'AGENT.md' ? 'Instructions' : source.group === 'memory' ? 'Memory file' : 'Skills',
      value: source.label,
      hint: source.state === 'loaded' ? source.detail : `${source.state} — ${source.detail}`,
      run: source.path ? `/open ${source.path}` : undefined,
    })),
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
 * by any of the three — "review" is not in any label but it is exactly what
 * someone types when they want to know whether subagents are on.
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
 * **Only the Settings group is compared.** Reported from use: opening the page,
 * changing nothing and closing it announced "2 settings changed — Turns 18 → 19,
 * Session 18 turns kept → 19 turns kept". Those are in the Context group, and
 * everything there is a *readout* — turns, tokens, diffs — which moves on its
 * own while the page is open. So the screen fired on every exit during an active
 * session, reporting things the person had not done and could not undo, which is
 * the fastest way to teach someone to ignore a screen that will one day have
 * something real on it.
 *
 * The group is the honest test rather than `restore`: `Skill folders` and
 * `Agent name` are genuine settings with no undo, and they should still be
 * reported when they change.
 *
 * @returns {Array<{label: string, from: string, to: string, restore?: string}>}
 */
export function settingsChanged(before, after) {
  const was = new Map((before || []).map((row) => [row.label, row.value]));
  const changes = [];
  for (const row of after || []) {
    if (row.group !== 'Settings') continue;
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

/**
 * The two column widths the settings list pads to.
 *
 * It is given the rows being **drawn**, and that is the whole of the fix: the
 * page computed these over every row it knew about and then padded the
 * filtered ones to them. Filter to two short rows and they were still spaced
 * for the widest label in the entire set, which is where
 * `Effort              deep` came from — a gap wide enough to read as a
 * missing column, on a screen whose whole job is showing what is set to what.
 *
 * `VALUE_MAX` is the same clamp the caller applies with `oneLine`, and the
 * width is measured on the clamped text rather than the raw value, because
 * padding to a length nothing will occupy is the same bug one column over.
 *
 * @param {Array<{label: string, value: string}>} rows - the rows being drawn
 * @returns {{ width: number, vwidth: number }}
 */
export const VALUE_MAX = 30;

export function settingsColumns(rows) {
  const drawn = Array.isArray(rows) ? rows : [];
  const longest = (pick) => drawn.reduce((n, row) => Math.max(n, pick(row).length), 0);
  return {
    width: longest((row) => String(row?.label ?? '')),
    // Collapsed the way `oneLine` collapses it: a value carrying a newline or a
    // run of spaces is drawn shorter than it measures.
    vwidth: Math.min(VALUE_MAX, longest((row) =>
      String(row?.value ?? '').replace(/\s+/g, ' ').trim().slice(0, VALUE_MAX))),
  };
}

function safe(fn, fallback) {
  try {
    return fn() ?? fallback;
  } catch {
    return fallback;
  }
}
