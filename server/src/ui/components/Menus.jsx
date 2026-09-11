import React from 'react';
import { exec } from 'child_process';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import { QuestionPrompt } from './QuestionPrompt.jsx';
import { summarizeDiff, previewRows } from '../diff-preview.js';
import { oneLine } from '../format.js';
import { canPickFolder, pickFolder } from '../folder-picker.js';
import { readCommands, listCommandDays } from '../../core/command-log.js';
import { EFFORT_LEVELS, resolveEffort } from '../../core/effort.js';
import { describeSettings, filterSettings, settingsChanged, SETTING_GROUPS } from '../../core/settings.js';
import { listWorkspaceCandidates } from '../../core/workspaces.js';
import { skillsDir, agentDir } from '../../core/paths.js';
import { skillSearchPath, listSkills } from '../../core/skills.js';
import { FOCUS_INPUT } from '../constants.js';

/**
 * Every modal the agent can raise: questions, command approval, plan review,
 * and the /mode, /model, /config and /github pickers.
 *
 * All of them answer through SelectInput rather than raw keypresses — an
 * approval that could be triggered by a stray 'y' in typed text is how edits
 * used to get applied without anyone agreeing to them.
 */
/** Settings rows that are a switch, not a choice. Flipped without leaving the page. */
const TOGGLES = new Set(['/plan', '/auto', '/memory on', '/memory off', '/allowlist enable', '/allowlist disable']);

/** `2026-09-10 14:32`, in the reader's own timezone. */
function localStamp(when) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} `
    + `${pad(when.getHours())}:${pad(when.getMinutes())}`;
}

export function Menus({
  activeMenu,
  setActiveMenu,
  agentLoop,
  terminalWidth = 80,
  handleSubmit,
  mode,
  setActiveTab,
  setFocus,
  setHistory,
  setInput,
}) {
  // Every menu's footer promised `esc cancel` and nothing listened: the agent's
  // own key bindings go inert while a modal is up, and SelectInput knows only
  // the arrows and Enter. So escape lands here, and only here — one step back
  // where a menu has steps, closed otherwise.
  useInput((_char, key) => {
    // Tab cycles the settings tabs. Not ←/→, which the filter field needs for
    // its cursor, and not shift+tab alone, which is the global mode toggle
    // everywhere else — inside a menu the agent's own bindings are inert, so
    // tab is free here and nowhere else.
    if (key.tab && activeMenu?.type === 'settings') {
      const step = key.shift ? -1 : 1;
      const at = Math.max(0, SETTING_GROUPS.indexOf(activeMenu.group || SETTING_GROUPS[0]));
      const next = (at + step + SETTING_GROUPS.length) % SETTING_GROUPS.length;
      setActiveMenu({ ...activeMenu, group: SETTING_GROUPS[next], query: '' });
      return;
    }

    if (!key.escape) return;
    // Escape clears a filter before it closes the page: having typed three
    // letters, "get me out of this filter" is the more likely of the two.
    if (activeMenu?.type === 'settings' && activeMenu.query) {
      setActiveMenu({ ...activeMenu, query: '' });
      return;
    }
    // On the way out, say what changed — and only then. Settings here apply the
    // moment you pick one, so there is nothing to save; what is worth showing
    // is what you just did and a way to put it back. No dialog when nothing
    // changed: a confirmation you always dismiss teaches people to dismiss
    // confirmations.
    if (activeMenu?.type === 'settings' && activeMenu.view !== 'leaving') {
      const changes = settingsChanged(activeMenu.baseline, describeSettings(agentLoop));
      if (changes.length > 0) {
        setActiveMenu({ ...activeMenu, view: 'leaving', changes });
        return;
      }
    }
    if (activeMenu?.returnTo && !(activeMenu.type === 'allowlist' && activeMenu.view)) {
      setActiveMenu(activeMenu.returnTo);
      return;
    }
    if (activeMenu?.type === 'allowlist' && activeMenu.view) {
      setActiveMenu({ ...activeMenu, view: activeMenu.view === 'confirm' ? 'list' : null, pending: null });
      return;
    }
    setActiveMenu(null);
    setFocus(FOCUS_INPUT);
  }, { isActive: !!activeMenu });

  return (
    <>
        {activeMenu?.type === 'ask_question' && (
          <QuestionPrompt
            payload={activeMenu.payload}
            onAnswer={(entries) => {
              setActiveMenu(null);
              agentLoop.answerQuestion(entries);
              const summary = entries.length === 1
                ? `You answered: ${entries[0].answer}`
                : entries.map((e, i) => `${i + 1}. ${e.answer}`).join('  ');
              setHistory(prev => [...prev, { role: 'system', content: `[System: ${summary}]` }]);
              setFocus(FOCUS_INPUT);
            }}
            onCancel={() => {
              setActiveMenu(null);
              agentLoop.cancelQuestion();
              setHistory(prev => [...prev, { role: 'system', content: '[System: You dismissed the question. The agent will proceed on its own assumption.]' }]);
              setFocus(FOCUS_INPUT);
            }}
          />
        )}

        {activeMenu?.type === 'command_approval' && (
          <Box flexDirection="column" borderStyle="single" borderColor={activeMenu.payload.riskLevel === 'critical' ? 'red' : 'yellow'} padding={1}>
            <Text bold color={activeMenu.payload.riskLevel === 'critical' ? 'red' : 'yellow'}>
              ! Command Execution Request ({activeMenu.payload.riskLevel.toUpperCase()})
            </Text>
            <Text>Command: <Text bold>{activeMenu.payload.command}</Text></Text>
            <Text>Directory: {activeMenu.payload.cwd}</Text>
            <Text>Reason: {activeMenu.payload.riskReason}</Text>
            <SelectInput
              items={[
                { label: 'Allow Command Once', value: 'allow_once' },
                { label: 'Allow Always (Add to Allowlist)', value: 'allow_always' },
                { label: 'Reject Command', value: 'reject' },
                { label: 'Reject Always (Add to Blocklist)', value: 'reject_always' }
              ]}
              onSelect={(item) => {
                setActiveMenu(null);
                agentLoop.answerCommandApproval(item.value, activeMenu.payload.command);
                
                let statusMsg = '';
                if (item.value === 'allow_once') statusMsg = 'allowed once';
                if (item.value === 'allow_always') statusMsg = 'allowed always (added to allowlist)';
                if (item.value === 'reject') statusMsg = 'rejected';
                if (item.value === 'reject_always') statusMsg = 'rejected always (added to blocklist)';
                
                setHistory(prev => [...prev, { role: 'system', content: `[System: You ${statusMsg} the command: ${activeMenu.payload.command}]` }]);
                setFocus(FOCUS_INPUT);
              }}
            />
          </Box>
        )}

        {activeMenu?.type === 'plan_review' && (
          <Box flexDirection="column" borderStyle="single" borderColor="magenta" padding={1}>
            <Text bold color="cyan">Implementation plan ready for review</Text>
            <Text>The agent has created an implementation_plan.md artifact.</Text>
            <SelectInput
              items={[
                { label: 'Proceed with Implementation Plan', value: 'accept' },
                { label: 'Reject', value: 'reject' },
                { label: 'Provide Custom Feedback (Chat)', value: 'custom' }
              ]}
              onSelect={(item) => {
                setActiveMenu(null);
                if (item.value === 'accept') {
                  handleSubmit('I have reviewed the implementation plan and approve it. Please proceed with the execution phase.');
                } else if (item.value === 'reject') {
                  handleSubmit('I reject the implementation plan. Please wait for my feedback.');
                } else {
                  setFocus(FOCUS_INPUT);
                }
              }}
            />
          </Box>
        )}

        {activeMenu?.type === 'effort' && (() => {
          const current = resolveEffort(agentLoop.modelConfig?.effort).id;
          return (
            <Box flexDirection="column" borderStyle="single" borderColor="cyan" padding={1}>
              <Text bold color="cyan">🎚️  How hard should it work?</Text>
              <Text dimColor wrap="wrap">
                One ladder, least effort first. Each rung sets the prompt profile and names
                the browser tab it is written for — set your Gemini tab to match.
              </Text>
              <Box marginTop={1} />
              <SelectInput
                items={(() => {
                  // No emoji in the rows. Their terminal widths disagree — ⚡ is
                  // usually one column and 🧠 is two — so a name column padded
                  // after them lines up on no terminal at all, which is what
                  // made this list look crooked.
                  const nameWidth = Math.max(...EFFORT_LEVELS.map((e) => e.name.length));
                  const tabWidth = Math.max(...EFFORT_LEVELS.map((e) => e.browser.length));
                  return EFFORT_LEVELS.map((e) => ({
                    label: `${e.name.padEnd(nameWidth)}  ${e.browser.padEnd(tabWidth)}`
                      + `  ${e.id === current ? '← current' : '         '}`,
                    value: e.id,
                  }));
                })()}
                onHighlight={(item) => {
                  if (item.value !== activeMenu.at) setActiveMenu((m) => ({ ...m, at: item.value }));
                }}
                onSelect={async (item) => {
                  setActiveMenu(activeMenu.returnTo || null);
                  const result = await agentLoop.handleSlashCommand('effort', [item.value]);
                  setHistory(prev => [...prev, { role: 'assistant', content: result.message, isLocal: true }]);
                  setFocus(FOCUS_INPUT);
                }}
              />
              <Box marginTop={1}>
                <Text dimColor wrap="truncate">
                  {'  '}{resolveEffort(activeMenu.at || current).blurb}
                </Text>
              </Box>
              <Text dimColor>↑↓ move · enter choose · esc cancel</Text>
            </Box>
          );
        })()}

        {/*
          One screen, not three. It used to be a role picker, then a model
          picker, with "View Current Config" as a third row that navigated away
          to print what the screen could have shown. The topology is just
          whether these two models differ, so both states are on the list and
          the current one is the heading.
        */}
        {activeMenu?.type === 'config' && (() => {
          const main = agentLoop.modelConfig?.main || 'gemini';
          const reviewer = agentLoop.modelConfig?.reviewer || null;
          const other = main === 'gemini' ? 'chatgpt' : 'gemini';
          const isDuo = Boolean(reviewer) && reviewer !== main;
          const run = async (args) => {
            setActiveMenu(activeMenu.returnTo || null);
            const result = await agentLoop.handleSlashCommand('config', args);
            setHistory(prev => [...prev, { role: 'assistant', content: result.message, isLocal: true }]);
            setFocus(FOCUS_INPUT);
          };

          return (
            <Box flexDirection="column" borderStyle="single" borderColor="cyan" padding={1}>
              <Text bold color="cyan">
                🌐 {isDuo ? 'Duo' : 'Solo'} — {main} implements
                {isDuo ? `, ${reviewer} reviews` : ' and reviews its own work'}
              </Text>
              <Text dimColor wrap="wrap">
                A second tab is worth it only on the other model: the same model reviewing
                itself has the same blind spots.
              </Text>
              <SelectInput
                items={[
                  {
                    label: `👤  Solo — ${main} alone, start to finish${isDuo ? '' : '  ← current'}`,
                    value: 'reviewer none',
                  },
                  {
                    label: `Duo — ${other} reviews ${main}${isDuo ? '  ← current' : ''}`,
                    value: `reviewer ${other}`,
                  },
                  { label: `Swap the main model to ${other}`, value: `main ${other}` },
                ]}
                onSelect={(item) => run(item.value.split(' '))}
              />
              <Text dimColor>↑↓ move · enter choose · esc cancel</Text>
            </Box>
          );
        })()}

        {/*
          `/help` answers "what can I type?". This answers "how is this set up?",
          which had no answer — it was spread across /config, /effort, /memory,
          /allowlist and the status bar, one command per fact. Picking a row
          runs the command that already owns that setting, so the page is a way
          in rather than a second place to change things.
        */}
        {activeMenu?.type === 'settings' && (() => {
          const rows = describeSettings(agentLoop);
          const query = activeMenu.query || '';
          const group = activeMenu.group || SETTING_GROUPS[0];
          const matches = filterSettings(rows, query, group);

          // ── Leaving, with something to report ──────────────────────
          if (activeMenu.view === 'leaving') {
            const changes = activeMenu.changes || [];
            const undoable = changes.filter((c) => c.restore);
            return (
              <Box flexDirection="column" borderStyle="single" borderColor="cyan" padding={1}>
                <Text bold color="cyan">
                  {changes.length} setting{changes.length === 1 ? '' : 's'} changed
                </Text>
                <Box flexDirection="column" marginY={1} paddingLeft={2}>
                  {changes.map((c) => (
                    <Text key={c.label}>
                      <Text>{c.label}</Text>
                      <Text dimColor>{'  '}{c.from}{' → '}</Text>
                      <Text color="cyan">{c.to}</Text>
                      {c.restore ? null : <Text dimColor>{'  (cannot be undone from here)'}</Text>}
                    </Text>
                  ))}
                </Box>
                <Text dimColor wrap="wrap">
                  These applied as you picked them — there is nothing waiting to be saved.
                </Text>
                <SelectInput
                  items={[
                    { label: 'Keep them', value: 'keep' },
                    ...(undoable.length
                      ? [{ label: `↩️   Put ${undoable.length === changes.length ? 'them' : `${undoable.length} of them`} back`, value: 'undo' }]
                      : []),
                  ]}
                  onSelect={async (item) => {
                    setActiveMenu(null);
                    setFocus(FOCUS_INPUT);
                    if (item.value !== 'undo') return;
                    // One at a time and in order: each runs the command that
                    // owns that setting, which is the same path the user took.
                    for (const change of undoable) {
                      await agentLoop.handleSlashCommand(
                        change.restore.slice(1).split(' ')[0],
                        change.restore.slice(1).split(' ').slice(1),
                      );
                    }
                    setHistory(prev => [...prev, {
                      role: 'assistant', isLocal: true,
                      content: `↩️ Put back: ${undoable.map((c) => `${c.label} → ${c.from}`).join(', ')}`,
                    }]);
                  }}
                />
                <Text dimColor>↑↓ move · enter choose</Text>
              </Box>
            );
          }

          // ── The page ───────────────────────────────────────────────
          // The list lives in Ink's repainted frame, so it is bounded and says
          // how much it is not showing. See ui/constants.js.
          const LIMIT = 8;
          const hidden = Math.max(0, matches.length - LIMIT);
          const width = Math.max(...rows.map((r) => r.label.length), 0);
          const vwidth = Math.min(30, Math.max(...rows.map((r) => r.value.length), 0));
          const selected = matches[Math.min(activeMenu.at || 0, matches.length - 1)];

          return (
            <Box flexDirection="column" borderStyle="single" borderColor="cyan" padding={1}>
              <Box>
                {SETTING_GROUPS.map((name) => (
                  <Text key={name}>
                    {name === group
                      ? <Text bold color="cyan">{name}</Text>
                      : <Text dimColor>{name}</Text>}
                    <Text dimColor>{'   '}</Text>
                  </Text>
                ))}
                {query ? <Text dimColor>{'(all tabs)'}</Text> : null}
              </Box>
              <Box>
                <Text dimColor>{'⌕ '}</Text>
                <TextInput
                  value={query}
                  placeholder="filter…"
                  onChange={(value) => setActiveMenu((m) => ({ ...m, query: value, at: 0 }))}
                />
              </Box>
              {matches.length === 0 ? (
                <Text dimColor>{`  nothing matches “${query}”`}</Text>
              ) : (
                <SelectInput
                  limit={LIMIT}
                  items={matches.map((row) => ({
                    // Two columns and nothing else. The hint used to ride along
                    // here and was truncated mid-word at every width — it is
                    // only ever wanted for the row you are looking at, so it
                    // moved below the list where it has the whole line.
                    label: `${row.label.padEnd(width)}   ${oneLine(row.value, 30).padEnd(vwidth)}`,
                    value: row.run || '',
                    key: row.label,
                  }))}
                  onHighlight={(item) => {
                    const at = matches.findIndex((r) => r.label === item.key);
                    if (at >= 0 && at !== activeMenu.at) setActiveMenu((m) => ({ ...m, at }));
                  }}
                  onSelect={async (item) => {
                    if (!item.value) return;
                    const back = { ...activeMenu, view: undefined, changes: undefined };

                    // A row that needs a choice hands over to that chooser and
                    // gets the page back afterwards. Closing settings to make a
                    // change — and never returning — is why the summary on the
                    // way out could never fire: there was no way out that still
                    // knew what you had come in with.
                    if (item.value === '/effort') {
                      setActiveMenu({ type: 'effort', returnTo: back });
                      return;
                    }
                    if (item.value === '/config') {
                      setActiveMenu({ type: 'config', returnTo: back });
                      return;
                    }
                    if (item.value === '/allowlist') {
                      setActiveMenu({ type: 'allowlist', rules: agentLoop.commandRules, returnTo: back });
                      return;
                    }
                    // Opened here rather than through handleSubmit, which is
                    // what `returnTo` needs: a menu raised by a slash command
                    // has no idea it was reached from the settings page, so
                    // escape closed everything instead of stepping back one.
                    if (item.value === '/skills') {
                      setActiveMenu({
                        type: 'skills',
                        skills: listSkills(agentLoop.workspace, agentLoop.skillFolders || []),
                        workspace: agentLoop.workspace,
                        returnTo: back,
                      });
                      return;
                    }
                    if (item.value === '/commands') {
                      const days = listCommandDays(agentLoop.workspace);
                      if (days.length === 0) { setActiveMenu(null); setFocus(FOCUS_INPUT); handleSubmit(item.value); return; }
                      setActiveMenu({ type: 'commands', days, workspace: agentLoop.workspace, returnTo: back });
                      return;
                    }

                    // A row that is simply a switch flips where it stands.
                    if (TOGGLES.has(item.value)) {
                      await agentLoop.handleSlashCommand(item.value.slice(1).split(' ')[0],
                        item.value.slice(1).split(' ').slice(1));
                      setActiveMenu(back);
                      return;
                    }

                    // Anything else is a command in its own right — it answers
                    // in the transcript, which is not something to read through
                    // a menu.
                    setActiveMenu(null);
                    setFocus(FOCUS_INPUT);
                    handleSubmit(item.value);
                  }}
                />
              )}
              {hidden > 0 ? <Text dimColor>{`  ↓ ${hidden} more — type to narrow`}</Text> : null}
              {selected?.hint
                ? <Text dimColor wrap="truncate">{'  '}{selected.hint}</Text>
                : null}
              <Text dimColor>
                type to filter · tab switches · ↑↓ move · enter change · esc {query ? 'clear' : 'close'}
              </Text>
            </Box>
          );
        })()}

        {activeMenu?.type === 'commands' && (
          <Box flexDirection="column" borderStyle="single" borderColor="yellow" padding={1}>
            <Text bold color="yellow">🧾  Commands run</Text>
            <Text dimColor wrap="wrap">
              Every shell command, and every one that was blocked. Kept per day, and never
              read back into a prompt — this is for you, not for the model.
            </Text>
            <SelectInput
              limit={10}
              items={activeMenu.days.map((day) => {
                const entries = readCommands(activeMenu.workspace, day);
                const blocked = entries.filter((e) => e.outcome !== 'ran').length;
                return {
                  label: `${day}   ${String(entries.length).padStart(3)} command${entries.length === 1 ? ' ' : 's'}`
                    + (blocked ? `   ${blocked} not run` : ''),
                  value: day,
                };
              })}
              onSelect={(item) => {
                setActiveMenu(null);
                setFocus(FOCUS_INPUT);
                handleSubmit(`/commands ${item.value}`);
              }}
              key="commands-days"
            />
            <Text dimColor>↑↓ move · enter open · esc cancel</Text>
          </Box>
        )}

        {activeMenu?.type === 'plans' && (
          <Box flexDirection="column" borderStyle="single" borderColor="cyan" padding={1}>
            <Text bold color="cyan">
              {activeMenu.plans.length} past plan{activeMenu.plans.length === 1 ? '' : 's'}
            </Text>
            <Text dimColor wrap="wrap">
              Each one was archived when the next replaced it. Enter opens it in your editor.
            </Text>
            <SelectInput
              limit={10}
              items={activeMenu.plans.map((plan) => ({
                // Date first because that is how you look for one, then the
                // heading, because a column of timestamps says nothing about
                // which plan you actually want back.
                // Local parts, not toISOString(): the stamp in the filename was
                // written in local time, so converting it to UTC to display it
                // moved every plan by the offset — a plan archived at 14:32
                // listed itself as 09:02.
                label: `${plan.when ? localStamp(plan.when) : '                '}`
                  + `  ${oneLine(plan.title || plan.name, 52)}`,
                value: plan.path,
                key: plan.name,
              }))}
              onSelect={(item) => {
                setActiveMenu(null);
                setFocus(FOCUS_INPUT);
                try {
                  exec(`"${agentLoop.editor || 'code'}" "${item.value}" || open "${item.value}" || xdg-open "${item.value}"`);
                } catch { /* no editor on this machine */ }
              }}
            />
            <Text dimColor>↑↓ move · enter open · esc cancel</Text>
          </Box>
        )}

        {activeMenu?.type === 'logs' && (
          <Box flexDirection="column" borderStyle="single" borderColor="red" padding={1}>
            <Text bold color="red">🩺  {activeMenu.summary.total} failure{activeMenu.summary.total === 1 ? '' : 's'} logged</Text>
            <Text dimColor wrap="wrap">Pick a flow to see what broke in it.</Text>
            <SelectInput
              limit={10}
              items={[
                ...activeMenu.summary.byFlow.map((f) => ({
                  label: `${String(f.count).padStart(3)}  ${f.flow.padEnd(10)} ${f.label}`,
                  value: f.flow,
                })),
                { label: '🧹  Clear the log', value: 'clear' },
              ]}
              onSelect={(item) => {
                setActiveMenu(null);
                setFocus(FOCUS_INPUT);
                handleSubmit(`/logs ${item.value}`);
              }}
            />
            <Text dimColor>↑↓ move · enter open · esc cancel</Text>
          </Box>
        )}

        {activeMenu?.type === 'allowlist' && (() => {
          const rules = activeMenu.rules;
          const on = rules.enabled !== false;
          const all = [
            ...rules.allow.map((c) => ({ cmd: c, kind: 'allow' })),
            ...rules.block.map((c) => ({ cmd: c, kind: 'block' })),
          ];

          const close = () => {
            // Back to settings when that is where this was opened from.
            if (activeMenu.returnTo) { setActiveMenu(activeMenu.returnTo); return; }
            setActiveMenu(null);
            setFocus(FOCUS_INPUT);
          };

          // ── Confirm ────────────────────────────────────────────────
          // A rule can be a paragraph of shell — a compound git command with
          // quoted echoes in it — and one keypress used to delete it outright
          // with nothing shown but a truncated line. So the full text is spelled
          // out here, wrapped, before anything is removed.
          if (activeMenu.view === 'confirm' && activeMenu.pending) {
            const { cmd, kind } = activeMenu.pending;
            return (
              <Box flexDirection="column" borderStyle="single" borderColor="yellow" padding={1}>
                <Text bold color="yellow">🛡️  Remove this rule?</Text>
                <Box marginY={1} paddingLeft={2}>
                  <Text color={kind === 'allow' ? 'green' : 'red'} wrap="wrap">
                    {kind === 'allow' ? '✓ ' : '✗ '}{cmd}
                  </Text>
                </Box>
                <Text dimColor wrap="wrap">
                  {kind === 'allow'
                    ? 'The agent will ask before running this again.'
                    : 'The agent will be allowed to propose this again.'}
                </Text>
                <SelectInput
                  items={[
                    { label: '🗑️   Yes, remove it', value: 'yes' },
                    { label: '↩️   No, keep it', value: 'no' },
                  ]}
                  onSelect={(item) => {
                    if (item.value === 'no') {
                      setActiveMenu({ ...activeMenu, view: 'list', pending: null });
                      return;
                    }
                    close();
                    handleSubmit(`/allowlist remove ${cmd}`);
                  }}
                />
                <Text dimColor>↑↓ move · enter choose · esc back</Text>
              </Box>
            );
          }

          // ── The list ───────────────────────────────────────────────
          // One row per rule, truncated to one line. Untruncated, a compound
          // command wraps to four or five rows and a dozen rules push the live
          // frame past the viewport — which is what makes Ink clear and repaint
          // the whole terminal on every render. See ui/constants.js.
          if (activeMenu.view === 'list') {
            return (
              <Box flexDirection="column" borderStyle="single" borderColor="yellow" padding={1}>
                <Text bold color="yellow">
                  🛡️  {all.length} command rule{all.length === 1 ? '' : 's'}
                </Text>
                <Text dimColor wrap="wrap">Pick one to remove it. You will be asked to confirm.</Text>
                <SelectInput
                  limit={10}
                  items={[
                    ...all.map(({ cmd, kind }) => ({
                      label: `${kind === 'allow' ? '✓' : '✗'}  ${oneLine(cmd, 58)}`,
                      value: cmd,
                      key: `${kind}:${cmd}`,
                    })),
                    { label: '←   Back', value: '\u0000back', key: 'back' },
                  ]}
                  onSelect={(item) => {
                    if (item.value === '\u0000back') {
                      setActiveMenu({ ...activeMenu, view: null, pending: null });
                      return;
                    }
                    const rule = all.find((r) => r.cmd === item.value);
                    setActiveMenu({ ...activeMenu, view: 'confirm', pending: rule });
                  }}
                />
                <Text dimColor>↑↓ move · enter remove · esc back</Text>
              </Box>
            );
          }

          // ── The menu ───────────────────────────────────────────────
          // The rules used to be listed right here, so opening /allowlist to
          // toggle it meant reading every rule you had ever added. What belongs
          // on the first screen is the four things you can do.
          const items = [
            { label: on ? 'Disable — ask before every command' : 'Enable — let allowed commands run',
              value: on ? 'disable' : 'enable' },
            { label: '＋  Allow a command…', value: '\u0000add' },
            { label: '＋  Block a command…', value: '\u0000block' },
            ...(all.length > 0
              ? [
                { label: `View commands (${all.length})`, value: '\u0000list' },
                { label: '🧹  Clear every rule', value: 'clear' },
              ]
              : []),
          ];

          return (
            <Box flexDirection="column" borderStyle="single" borderColor="yellow" padding={1}>
              <Text bold color="yellow">🛡️  Command rules — {on ? 'enabled' : 'disabled'}</Text>
              <Text dimColor wrap="wrap">
                Allowed commands run without asking. Blocked ones are refused outright.
              </Text>
              <SelectInput
                items={items}
                onSelect={(item) => {
                  if (item.value === '\u0000list') {
                    setActiveMenu({ ...activeMenu, view: 'list' });
                    return;
                  }
                  close();
                  if (item.value === '\u0000add') { setInput('/allowlist add '); return; }
                  if (item.value === '\u0000block') { setInput('/allowlist block '); return; }
                  handleSubmit(`/allowlist ${item.value}`);
                }}
              />
              <Text dimColor>↑↓ move · enter choose · esc cancel</Text>
            </Box>
          );
        })()}

        {activeMenu?.type === 'skills' && (() => {
          const skills = activeMenu.skills || [];
          const folders = skillSearchPath(activeMenu.workspace, agentLoop.skillFolders || []);
          // Padded, like every other list here. Names of different lengths
          // against an unpadded description made this read as a ragged wall.
          const nameWidth = Math.min(24, Math.max(...skills.map((sk) => sk.name.length), 0));
          const back = () => {
            if (activeMenu.returnTo) { setActiveMenu(activeMenu.returnTo); return true; }
            setActiveMenu(null);
            setFocus(FOCUS_INPUT);
            return false;
          };

          return (
            <Box flexDirection="column" borderStyle="single" borderColor="cyan" padding={1}>
              <Text bold color="cyan">
                Skills — {skills.length} across {folders.length} folder{folders.length === 1 ? '' : 's'}
              </Text>
              <Text dimColor wrap="wrap">
                Markdown files the agent opens when their description matches the task. Only the
                descriptions sit in the prompt, so writing more of them costs a line each.
              </Text>
              <SelectInput
                limit={10}
                items={[
                  ...skills.map((sk) => ({
                    label: `${sk.name.padEnd(nameWidth)}  ${oneLine(sk.description || '(no description)', 44)}`,
                    value: `open:${sk.file}`,
                    key: sk.file,
                  })),
                  { label: '＋  New skill…', value: 'new', key: '_new' },
                  // The settings row is called "Skill folders" and used to open
                  // a list with no way to reach them, which is what made this
                  // screen feel half-finished.
                  { label: `📁  Folders searched (${folders.length})…`, value: 'folders', key: '_folders' },
                  { label: 'Open the skills folder', value: `open:${skillsDir(activeMenu.workspace)}`, key: '_dir' },
                ]}
                onSelect={(item) => {
                  if (item.value === 'new') {
                    back();
                    setFocus(FOCUS_INPUT);
                    // Hand over a half-written command: the skill needs a name
                    // and the prompt is already the place to type one.
                    setInput('/skills new ');
                    return;
                  }
                  if (item.value === 'folders') {
                    setActiveMenu(null);
                    setFocus(FOCUS_INPUT);
                    handleSubmit('/skills dir');
                    return;
                  }
                  back();
                  const target = item.value.slice('open:'.length);
                  try {
                    exec(`"${agentLoop.editor || 'code'}" "${target}" || open "${target}" || xdg-open "${target}"`);
                  } catch (e) { /* no editor on this machine */ }
                }}
              />
              <Text dimColor>↑↓ move · enter open · esc {activeMenu.returnTo ? 'back' : 'cancel'}</Text>
            </Box>
          );
        })()}

        {activeMenu?.type === 'workspace' && (
          <Box flexDirection="column" borderStyle="single" borderColor="cyan" padding={1}>
            <Text bold color="cyan">Workspace</Text>
            <Text dimColor wrap="truncate-start">Here:  {activeMenu.current}</Text>
            <Text dimColor wrap="truncate-start">State: {agentDir(activeMenu.current)}</Text>
            <Text dimColor wrap="wrap">
              The agent restarts into it. This conversation belongs to the project you are
              leaving, and so do its memory, config and command rules.
            </Text>
            <SelectInput
              limit={10}
              items={[
                ...listWorkspaceCandidates(activeMenu.current).map((c) => ({
                  label: `${c.current ? '● ' : '  '}${c.label}`,
                  value: c.path,
                })),
                ...(canPickFolder()
                  ? [{ label: '  Browse…', value: '\u0000browse' }]
                  : []),
                { label: '  Type a path instead…', value: '\u0000type' },
              ]}
              onSelect={async (item) => {
                setActiveMenu(null);
                setFocus(FOCUS_INPUT);
                if (item.value === '\u0000browse') {
                  const chosen = await pickFolder('Choose a project to work on');
                  if (chosen && chosen !== activeMenu.current) handleSubmit(`/workspace ${chosen}`);
                  return;
                }
                if (item.value === '\u0000type') {
                  // Hand the user a half-written command rather than a second
                  // prompt of our own: the input line already knows how to edit.
                  setInput('/workspace ');
                  return;
                }
                if (item.value === activeMenu.current) return;
                handleSubmit(`/workspace ${item.value}`);
              }}
            />
            <Text dimColor>↑↓ move · enter choose · esc cancel</Text>
          </Box>
        )}

        {activeMenu?.type === 'github' && (
          <Box flexDirection="column" borderStyle="single" borderColor="cyan" padding={1}>
            <Text bold color="cyan">GitHub integration</Text>
            <SelectInput
              items={[
                { label: 'Refresh PR Activity Now', value: 'refresh' },
                { label: `CI Failure Watch [Currently: ${agentLoop.githubHandler?.config?.enableCIWatch ? 'ON' : 'OFF'}]`, value: 'ci-watch' },
                { label: 'Clear Poller State & Rescan', value: 'clear-state' },
                { label: 'Open PR Dashboard (Ctrl+O)', value: 'dashboard' },
                { label: 'Remove/Update GitHub Token', value: 'remove-token' },
              ]}
              onSelect={(item) => {
                setActiveMenu(null);
                if (item.value === 'dashboard') {
                  setActiveTab('github');
                  setFocus(FOCUS_INPUT);
                } else if (item.value === 'ci-watch') {
                  const current = agentLoop.githubHandler?.config?.enableCIWatch;
                  handleSubmit(`/github ci-watch ${current ? 'off' : 'on'}`);
                } else if (item.value === 'remove-token') {
                  handleSubmit('/github remove-token');
                } else {
                  handleSubmit(`/github ${item.value}`);
                }
              }}
            />
          </Box>
        )}
    </>
  );
}

/**
 * Pending edit approval.
 *
 * Its own SelectInput for the same reason as the rest: an approval that a stray
 * 'y' in typed text could trigger is how edits used to get applied without
 * anyone agreeing to them.
 *
 * It shows the actual change, not just a hunk count — approving an edit you
 * cannot see is not approval. The preview is capped so a large edit cannot push
 * the buttons off screen.
 */
export function DiffApproval({
  diffRequest,
  handleDiffResponse,
  setFocus,
}) {
  if (!diffRequest) return null;

  const hunks = diffRequest.hunks ?? [];
  const { added, removed } = summarizeDiff(hunks);
  const rows = previewRows(hunks, { maxLines: 16 });
  const critical = diffRequest.riskLevel === 'critical';

  const colorFor = { add: 'green', del: 'red', header: 'cyan' };

  return (
    <Box
      borderStyle="round"
      borderColor={critical ? 'red' : 'yellow'}
      paddingX={1}
      flexDirection="column"
      width="100%"
      flexShrink={1}
    >
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color={critical ? 'red' : 'yellow'} wrap="truncate-start">
          {diffRequest.isNewFile ? 'Create' : 'Edit'} {diffRequest.filePath}
        </Text>
        <Text>
          <Text color="green">+{added}</Text>
          <Text dimColor> / </Text>
          <Text color="red">-{removed}</Text>
        </Text>
      </Box>

      {diffRequest.riskReason ? (
        <Text dimColor wrap="wrap">{diffRequest.riskReason}</Text>
      ) : null}

      {rows.length > 0 && (
        <Box flexDirection="column" marginY={1}>
          {rows.map((row, i) => (
            <Text
              key={i}
              wrap="truncate"
              dimColor={row.type === 'ctx' || row.type === 'more'}
              color={colorFor[row.type]}
            >
              {row.text}
            </Text>
          ))}
        </Box>
      )}

      <SelectInput
        items={[
          { label: `Approve — write ${hunks.length === 1 ? 'it' : 'all of it'} to disk`, value: 'accept' },
          { label: 'Reject — discard the change', value: 'reject' },
        ]}
        onSelect={(item) => {
          handleDiffResponse(item.value);
          setFocus(FOCUS_INPUT);
        }}
      />
    </Box>
  );
}
