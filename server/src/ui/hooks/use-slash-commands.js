import fs from 'fs';
import path from 'path';
import * as paths from '../../core/paths.js';
import { leaveWhenIdle, prepareWorkspaceSwitch, RESTART_EXIT_CODE } from '../../core/restart.js';
import { createSkill, listSkills, skillSearchPath } from '../../core/skills.js';
import { describeDestructive } from '../destructive.js';
import { readErrors, summarizeErrors, clearErrors, FLOWS } from '../../core/error-log.js';
import { listPlans } from '../../core/plan-archive.js';
import { listCommandDays, readCommands } from '../../core/command-log.js';
import { resolveWorkspaceInput, validateWorkspace } from '../../core/workspaces.js';
import { SLASH_COMMANDS } from '../constants.js';
import { AGENT_COMMANDS } from '../../core/slash-commands.js';
import { oneLine } from '../format.js';
import { SETTING_GROUPS, describeSettings } from '../../core/settings.js';
import { canPickFolder, pickFolder } from '../folder-picker.js';
import { summariseTraces, formatMs } from '../../core/trace-log.js';
import { channelHealth, formatRate, MIN_TURNS_FOR_RATE } from '../../core/channel-health.js';
import { checkForUpdate, isDirty, pullUpdate, savePendingReload, readPendingReload, clearPendingReload } from '../../core/update.js';


/**
 * Leave, after letting go of the port.
 *
 * `process.exit()` does not run the SIGINT handler in `main.js`, which is the
 * only thing that calls `wsServer.stop()` — so every one of these exits left
 * the bridge's socket bound. That does not matter for `/exit`, and matters a
 * great deal for the restart paths: the supervisor relaunches immediately, the
 * new process finds the port still held, and `main.js` answers `EADDRINUSE` by
 * asking "Port 7777 is already in use by another process. Do you want to kill
 * it?" through an inquirer prompt — into a terminal that Ink is in the middle
 * of tearing down. Which is what "it crashed and said something was already
 * open" was.
 *
 * The paint delay stays: Ink needs a frame to show what it just said before
 * the screen goes.
 */

/**
 * Run a "/" command.
 *
 * Some are answered here (they only touch UI state), the rest are handed to
 * AgentLoop.handleSlashCommand. Anything unrecognised reports itself rather
 * than being sent to the model as a prompt.
 */
// Moved to core/restart.js so the side panel can ask for a workspace switch
// too — the bridge cannot import a React hook. Re-exported because the CLI's
// own restart paths already import it from here.
export { leaveWhenIdle } from '../../core/restart.js';

export async function handleSlashCommand(query, {
  agentLoop,
  wsServer,
  resetScreen,
  setActiveMenu,
  setHistory,
  setIsProcessing,
  setPendingImage,
  confirmed = false,
}) {
    const parts = query.slice(1).split(/\s+/);
    const command = parts[0].toLowerCase();
    const args = parts.slice(1);

    // Some commands destroy more than they name. Ask first, once, from the one
    // place that decides — `confirmed` is set when the answer comes back.
    if (!confirmed) {
      const rules = agentLoop.commandRules || {};
      const warning = describeDestructive(command, args, {
        allowCount: rules.allow?.length || 0,
        blockCount: rules.block?.length || 0,
        turnCount: agentLoop.conversationHistory?.length || 0,
      });
      if (warning) {
        setActiveMenu({
          type: 'confirm_destructive',
          payload: {
            ...warning,
            onConfirm: () => handleSlashCommand(query, {
              agentLoop, wsServer, resetScreen, setActiveMenu, setHistory,
              setIsProcessing, setPendingImage, confirmed: true,
            }),
          },
        });
        setIsProcessing(false);
        return;
      }
    }

    // Generated from SLASH_COMMANDS, not written out beside it. The hand-kept
    // copy had drifted twice — listing /init-skills and /paste-image after both
    // were gone, and describing /memory as "view memory" while it toggled it —
    // because nothing made the two lists agree.
    if (command === 'help' || command === 'shortcuts') {
      const width = Math.max(...SLASH_COMMANDS.map((c) => c.name.length));
      setHistory(prev => [...prev, { role: 'user', content: query, isLocal: true }, {
        role: 'assistant',
        isLocal: true,
        content: [
          '### ⌨️  Keys',
          '  shift+tab   plan ⇄ auto',
          '  ctrl+e      expand or collapse every step',
          '  ctrl+t      shell',
          '  ctrl+o      GitHub dashboard',
          '  ctrl+u      clear the input   ·   ctrl+w   delete the last word',
          '  ctrl+j      newline, without sending   ·   ↑ ↓   move a line, or recall',
          '  ctrl+f      attach commands that failed in the editor terminal',
          '  ctrl+y      copy the last code block',
          '  esc         stop the run, or close a menu',
          '',
          '### ⌨️  Commands',
          ...SLASH_COMMANDS.map((c) => `  /${c.name.padEnd(width)}   ${c.desc}`),
          '',
          '_Typing `/` filters this same list as you go. `/settings` shows what is configured._',
        ].join('\n'),
      }]);
      setIsProcessing(false);
      return;
    }

    if (command === 'exit') {
      setHistory(prev => [...prev, { role: 'user', content: query, isLocal: true }, { role: 'assistant', content: '👋 Goodbye! Agent shutting down.', isLocal: true }]);
      setIsProcessing(false);
      leave(0, { wsServer, agentLoop, delay: 100 });
      return;
    }

    // Exit with the code src/index.js watches for, and it relaunches us. The
    // old version touched index.js's mtime, which does something only under
    // `tsx --watch` and nothing under `agent-cli` — where it printed
    // "Restarting server..." and stayed exactly where it was.
    if (command === 'restart') {
      if (!process.env.AGENT_CLI_SUPERVISED) {
        setHistory(prev => [...prev, { role: 'user', content: query, isLocal: true }, {
          role: 'assistant',
          isLocal: true,
          content: 'This process has no supervisor to restart it — it was started directly '
            + 'rather than through `agent-cli`.\n\nQuit with `/exit` and start it again.',
        }]);
        setIsProcessing(false);
        return;
      }
      const running = agentLoop.isProcessing;
      setHistory(prev => [...prev, { role: 'user', content: query, isLocal: true }, {
        role: 'assistant', isLocal: true,
        content: running
          ? '⟳ Restarting when this turn finishes — `esc` to stop it and go now.'
          : '⟳ Restarting…',
      }]);
      setIsProcessing(false);
      // Let the frame paint, then leave. Ink restores the terminal on exit,
      // which is why this is an ordinary exit rather than an exec in place.
      leaveWhenIdle(RESTART_EXIT_CODE, { wsServer, agentLoop });
      return;
    }

    /**
     * Pull the agent's own repo, and say what that leaves you to reload.
     *
     * The pull is the easy half. Three artifacts ship from this repo and only
     * one of them is live after a restart: `service-worker.js` is a committed
     * bundle Chrome reads on reload, content scripts stay in the page until it
     * is hard-refreshed, and the `.vsix` is installed by hand. So the reminder
     * is derived from what actually changed, and asks for nothing else.
     */
    if (command === 'update') {
      const say = (content) => {
        setHistory(prev => [...prev, { role: 'user', content: query, isLocal: true },
          { role: 'assistant', content, isLocal: true }]);
        setIsProcessing(false);
      };

      if (args[0] === 'done') {
        const had = readPendingReload();
        clearPendingReload();
        say(had ? '✔ Cleared. Nothing left to reload.' : 'Nothing was waiting to be reloaded.');
        return;
      }

      /**
       * Bare `/update` reports; `/update pull` acts.
       *
       * It used to pull straight away, and it checked the working tree *first*
       * — so on a repo with uncommitted work it refused with a complaint about
       * your changes even when there was nothing to pull. Reported from use,
       * and the order was the whole bug: whether the tree is dirty only matters
       * once there is something to apply.
       *
       * Splitting it also means "is there an update?" is answerable without
       * committing to taking one, which is the question people actually type
       * this to ask.
       */
      if (args[0] !== 'pull' && args[0] !== 'now') {
        const state = await checkForUpdate(agentLoop.agentSourceDir);
        if (state.reason === 'not a git checkout' || state.reason === 'no source directory') {
          say('The agent is not running from a git checkout, so there is nothing to update from.');
          return;
        }
        if (state.reason && state.reason.startsWith('no origin/')) {
          say(`There is no \`${state.reason.slice(3)}\` to compare against — `
            + 'this checkout has no remote, or has never fetched it.');
          return;
        }
        // Which branch it compared, and how far ahead yours is, is not what
        // was asked. "Is there an update?" has a one-word answer.
        if (!state.available) { say('✔ Up to date.'); return; }

        const n = state.behind;
        const lines = [`### ${n} update${n === 1 ? '' : 's'} available`, ''];
        // Said here rather than after the pull is attempted: it is the one
        // thing that would stop this working, and knowing now is worth more
        // than finding out when you ask for it.
        const dirty = await isDirty(agentLoop.agentSourceDir);
        if (dirty) {
          lines.push('! There are uncommitted changes in the agent\'s own repo, so this cannot',
            'be pulled yet. Commit or stash them first — `/update` will not pull over your work.');
        } else {
          lines.push('`/update pull` to take them.');
        }
        say(lines.join('\n'));
        return;
      }

      const outcome = await pullUpdate(agentLoop.agentSourceDir);
      if (!outcome.ok) { say(`! ${outcome.error}`); return; }
      if (!outcome.files.length) { say('✔ Already up to date.'); return; }

      const n = outcome.files.length;
      const lines = [`### Updated — ${n} file${n === 1 ? '' : 's'} changed`, ''];
      if (outcome.install) {
        lines.push('`package.json` moved, so dependencies need reinstalling:', '',
          '```bash', 'npm install', '```', '');
      }
      if (outcome.steps.length) {
        // Saved before the restart, and kept until acknowledged: the failure
        // this prevents is silent, so a notice that scrolls past once and is
        // gone would reproduce it.
        savePendingReload(outcome.steps, { to: outcome.to });
        lines.push('**Then these, because the pull touched them:**', '');
        for (const step of outcome.steps) lines.push(`  - **${step.what}** — ${step.how}`);
        lines.push('', '_Shown again on every start until you run `/update done`._');
      } else {
        lines.push('_Only the server changed — a restart is all it needs._');
      }
      lines.push('', process.env.AGENT_CLI_SUPERVISED
        ? '_Restarting into the new version…_'
        : '_Quit with `/exit` and start again to run the new version._');
      say(lines.join('\n'));

      if (process.env.AGENT_CLI_SUPERVISED && !outcome.install) {
        setTimeout(() => leaveWhenIdle(RESTART_EXIT_CODE, { wsServer, agentLoop }), 1200);
      }
      return;
    }

    // Open a file in the editor. Added for the Context tab's source rows —
    // knowing which AGENT.md is being sent is most of the value, and being able
    // to open it is the rest — but it stands on its own.
    if (command === 'open') {
      const target = args.join(' ').trim();
      if (!target) {
        setHistory(prev => [...prev, { role: 'user', content: query, isLocal: true }, {
          role: 'assistant', isLocal: true, timestamp: Date.now(),
          content: 'Usage: `/open <path>` — opens it in your editor.',
        }]);
        setIsProcessing(false);
        return;
      }
      const abs = target.startsWith('/') ? target : `${agentLoop.workspace}/${target}`;
      const { exec } = await import('child_process');
      const editor = agentLoop.editor || 'code';

      /**
       * Say which editor actually took it, not just that something did.
       *
       * The old version ran `editor || open || xdg-open` and reported
       * "Opened <path>" whatever happened — so when `code` was not installed
       * and macOS handed a `.md` to RStudio, the message read exactly the same
       * as success. Same fault as `open_in_editor` claiming a line number it
       * had not sent: the report has to describe what happened, or it is worse
       * than no report.
       */
      exec(`"${editor}" "${abs}"`, (err) => {
        if (!err) {
          setHistory(prev => [...prev, {
            role: 'assistant', isLocal: true, timestamp: Date.now(),
            content: `Opened \`${abs}\` in ${editor.split(/[\\/]/).pop()}.`,
          }]);
          return;
        }
        // The desktop's own answer, which is a different thing and is named as
        // one: it opens whatever is registered for the file type.
        const fallback = process.platform === 'darwin' ? 'open' : 'xdg-open';
        exec(`${fallback} "${abs}"`, (err2) => {
          setHistory(prev => [...prev, {
            role: 'assistant', isLocal: true, timestamp: Date.now(),
            content: err2
              ? `! Could not open \`${abs}\` — \`${editor}\` failed and so did \`${fallback}\`.`
              : `Opened \`${abs}\` with the desktop default — \`${editor}\` is not runnable.`
                + '\n\n_Set one with `--editor <command>` or `$EDITOR` if that is the wrong app._',
          }]);
        });
      });

      setHistory(prev => [...prev, { role: 'user', content: query, isLocal: true }]);
      setIsProcessing(false);
      return;
    }

    if (command === 'clear') {
      agentLoop.conversationHistory = [];
      setHistory([]);
      resetScreen();
      setIsProcessing(false);
      return;
    }

    if (command === 'new') {
      agentLoop.conversationHistory = [];
      agentLoop.promptBuilder.resetPromptState();
      agentLoop.sessionStore.clear();
      setHistory([]);
      resetScreen();
      wsServer.broadcast('extension', { type: 'new_chat', payload: {} });
      setHistory([{ role: 'assistant', content: '✨ Starting a new chat in Gemini...', isLocal: true }]);
      setIsProcessing(false);
      return;
    }

    // Only the bare form opens the picker. `/config reviewer none` used to open
    // it too and throw the arguments away, so the command was unusable typed.
    if (command === 'config' && args.length === 0) {
      setActiveMenu({ type: 'config' });
      setIsProcessing(false);
      return;
    }

    // /model and /reasoning were two knobs with five meaningful combinations.
    // Both names still work — typing one you have used for months and being
    // told it does not exist is a worse trade than one line of redirection.
    if ((command === 'effort' || command === 'model' || command === 'reasoning') && args.length === 0) {
      setActiveMenu({ type: 'effort' });
      setIsProcessing(false);
      return;
    }

    if (command === 'allowlist' && args.length === 0) {
      setActiveMenu({ type: 'allowlist', rules: agentLoop.commandRules });
      setIsProcessing(false);
      return;
    }

    // Scope is chosen at launch, not switched mid-session. It decides where
    // state, sessions and config live, so changing it is closer to opening a
    // different project than to changing a setting — the conversation on screen
    // belongs to the old scope, and the switcher used to rebuild the session
    // store underneath it while those turns were still being displayed.
    // The name still answers, because "unknown command" teaches nothing.
    if (command === 'scope' || command === 'repo') {
      const active = paths.getActiveScope(agentLoop.workspace);
      const { discovered, base } = paths.resolveState(agentLoop.workspace);
      setHistory(prev => [...prev, { role: 'user', content: query, isLocal: true }, {
        role: 'assistant',
        isLocal: true,
        content: discovered && active
          ? `🎯 Working on **${active}**, inside the group at \`${base}\`.\n\n`
            + 'Scope is set when the agent starts — `agent-cli --scope <repo>`, or just open '
            + 'the repo directly. Switching it mid-session would swap the history out from '
            + 'under the conversation you are looking at.'
          : 'This workspace has its own `.agent/`, so there is nothing to scope between.\n\n'
            + 'Scopes exist when several repos share one `.agent/` from a parent folder. Put '
            + '`.agent/` in the folder above your repos, then start with `--scope <repo>`.',
      }]);
      setIsProcessing(false);
      return;
    }

    // Plans were archived to .agent/artifacts/plans/ and nothing listed them,
    // so they piled up somewhere no command would show them — which is its own
    // way of losing the plan you wanted back.
    if (command === 'settings' || command === 'config-all') {
      // Snapshot on the way in, so leaving can say what changed. Settings apply
      // as they are picked, so this is the only record of what they were.
      setActiveMenu({
        type: 'settings',
        query: '',
        group: SETTING_GROUPS[0],
        at: 0,
        baseline: describeSettings(agentLoop),
      });
      setIsProcessing(false);
      return;
    }

    // What the agent has actually run on this machine. Nothing reads this back
    // into a prompt — it is for the person whose computer it is.
    if (command === 'commands' || command === 'audit') {
      const day = (args[0] || '').trim();
      const days = listCommandDays(agentLoop.workspace);

      if (days.length === 0) {
        setHistory(prev => [...prev, { role: 'user', content: query, isLocal: true }, {
          role: 'assistant', isLocal: true,
          content: 'No commands run yet in this workspace.\n\n'
            + 'Every shell command the agent runs — and every one it is blocked from running — '
            + 'is appended to `.agent/logs/commands/<date>.jsonl`.',
        }]);
        setIsProcessing(false);
        return;
      }

      if (day) {
        const entries = readCommands(agentLoop.workspace, day);
        const icon = { ran: '✔', blocked: '⛔', rejected: '✖' };
        const lines = entries.map((e) => {
          const time = new Date(e.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
          return `  ${icon[e.outcome] || '·'} \`${time}\` ${oneLine(e.command, 70)}`
            + (e.outcome === 'ran' ? '' : ` _(${e.outcome})_`);
        });
        setHistory(prev => [...prev, { role: 'user', content: query, isLocal: true }, {
          role: 'assistant', isLocal: true,
          content: `### 🧾 ${day} — ${entries.length} command${entries.length === 1 ? '' : 's'}\n\n`
            + (lines.join('\n') || '  _(none)_'),
        }]);
        setIsProcessing(false);
        return;
      }

      setActiveMenu({ type: 'commands', days, workspace: agentLoop.workspace });
      setIsProcessing(false);
      return;
    }

    if (command === 'plans') {
      const plans = listPlans(agentLoop.workspace);
      if (plans.length === 0) {
        setHistory(prev => [...prev, { role: 'user', content: query, isLocal: true }, {
          role: 'assistant',
          isLocal: true,
          content: 'No past plans yet.\n\nEach plan is copied to `.agent/artifacts/plans/` when '
            + 'the next one replaces it, so this fills up as you go.',
        }]);
        setIsProcessing(false);
        return;
      }
      setActiveMenu({ type: 'plans', plans });
      setIsProcessing(false);
      return;
    }

    if (command === 'logs' || command === 'errors') {
      const arg = (args[0] || '').toLowerCase();

      if (arg === 'clear') {
        const n = clearErrors(agentLoop.workspace);
        setHistory(prev => [...prev, { role: 'user', content: query, isLocal: true }, { role: 'assistant', content: `🧹 Cleared ${n} logged failure${n === 1 ? '' : 's'}.`, isLocal: true }]);
        setIsProcessing(false);
        return;
      }

      /**
       * `/logs rates` — how often the text channel itself fails.
       *
       * There is no tool-call API here, and `CLAUDE.md` records the question of
       * whether to add one as a fork. It also says the honest thing: any claim
       * about how far behind the text channel is stays an estimate until this
       * view exists. Every number has been logged for months and never read.
       */
      if (arg === 'rates') {
        const h = channelHealth(agentLoop.workspace);
        const width = Math.max(...h.rows.map((r) => r.label.length));
        const body = h.rows.map((r) => `  ${r.label.padEnd(width)}  ${String(r.count).padStart(4)}`
          + `   ${formatRate(r.rate).padStart(6)}`
          + `\n    _${r.detail}_`).join('\n');
        const note = h.enough
          ? `Over **${h.turns}** turns that came back from the browser.`
          : `**${h.turns}** turn${h.turns === 1 ? '' : 's'} recorded — too few to rate `
            + `(${MIN_TURNS_FOR_RATE} needed). The counts are real; the percentages wait.`;
        setHistory(prev => [...prev, { role: 'user', content: query, isLocal: true }, {
          role: 'assistant', isLocal: true,
          content: `### 📉 Text-channel failures\n\n${note}\n\n${body}\n\n`
            + '_The denominator is `traces.jsonl`: one entry per turn the browser answered, '
            + 'which is the population these failures are drawn from._',
        }]);
        setIsProcessing(false);
        return;
      }

      // `/logs <flow>` drills into one; bare `/logs` answers "what is breaking?"
      if (arg && FLOWS[arg]) {
        // The extension is the one flow with timings as well as failures, and
        // "is it slower?" is the question people bring to it. Shown first,
        // because a turn that is merely slow logs nothing at all below.
        let timing = '';
        if (arg === 'extension') {
          const t = summariseTraces(agentLoop.workspace);
          timing = t.samples === 0
            ? '_No turn timings recorded yet — they land here as turns complete._\n\n'
            : `**Browser timings** — median and slowest tenth, over ${t.samples} turn${t.samples === 1 ? '' : 's'}\n`
              + t.stages.map((st) => `  ${st.stage.padEnd(12)} ${formatMs(st.median).padStart(6)}   p90 ${formatMs(st.p90)}`).join('\n')
              + '\n\n';
        }
        const entries = readErrors(agentLoop.workspace, { flow: arg, limit: 15 });
        const body = entries.length === 0
          ? `Nothing logged for **${arg}**.`
          : entries.map((e) => {
            const when = new Date(e.time).toLocaleTimeString();
            const repeat = e.repeatedSince ? ` _(+${e.repeatedSince} more like it)_` : '';
            const detail = e.detail ? `\n    \`${String(e.detail).split('\n')[0].slice(0, 120)}\`` : '';
            return `  ${when} **${e.op || '—'}** — ${e.message}${repeat}${detail}`;
          }).join('\n');
        setHistory(prev => [...prev, { role: 'user', content: query, isLocal: true }, { role: 'assistant', content: `### 🩺 ${arg} — ${FLOWS[arg]}\n${timing}${body}`, isLocal: true }]);
        setIsProcessing(false);
        return;
      }

      const summary = summarizeErrors(agentLoop.workspace);
      // A summary you can act on. Picking a flow drills into it; picking clear
      // clears it — rather than printing a list and a set of commands to type.
      if (summary.total > 0 && !arg) {
        setActiveMenu({ type: 'logs', summary });
        setIsProcessing(false);
        return;
      }
      let content;
      if (summary.total === 0) {
        content = '### 🩺 Failures\nNothing has failed since the log was last cleared.';
      } else {
        const rows = summary.byFlow.map((f) => {
          const when = new Date(f.last).toLocaleTimeString();
          return `  **${f.flow}** ${String(f.count).padStart(3)}  _${f.label}_\n`
            + `      last ${when} — ${f.lastMessage}`;
        }).join('\n');
        content = `### 🩺 ${summary.total} failure${summary.total === 1 ? '' : 's'} logged\n${rows}\n\n`
          + `_\`/logs <flow>\` for detail · \`/logs clear\` to reset · full log in \`.agent/logs/errors.jsonl\`_`;
      }
      setHistory(prev => [...prev, { role: 'user', content: query, isLocal: true }, { role: 'assistant', content, isLocal: true }]);
      setIsProcessing(false);
      return;
    }

    if (command === 'skills' || command === 'skill') {
      const action = (args[0] || '').toLowerCase();

      // Point the agent at a directory of skills you keep elsewhere.
      if (action === 'dir' || action === 'folder') {
        const sub = (args[1] || '').toLowerCase();
        const target = args.slice(2).join(' ').trim();

        // `/skills dir add` with nothing after it: the case where you are adding
        // a folder is the case where you do not remember its path, and every
        // desktop already answers that question well.
        let chosen = target;
        if (sub === 'add' && !chosen) {
          if (!canPickFolder()) {
            setHistory(prev => [...prev, { role: 'user', content: query, isLocal: true }, {
              role: 'assistant', isLocal: true,
              content: 'Usage: `/skills dir add <path>`\n\n'
                + '_(A folder chooser would open here, but this machine has no dialog available — '
                + 'on Linux that usually means `zenity` or `kdialog` is not installed.)_',
            }]);
            setIsProcessing(false);
            return;
          }
          chosen = await pickFolder('Choose a folder of skills');
          if (!chosen) {
            setHistory(prev => [...prev, { role: 'user', content: query, isLocal: true }, {
              role: 'assistant', content: 'Cancelled.', isLocal: true,
            }]);
            setIsProcessing(false);
            return;
          }
        }

        if (sub === 'add' && chosen) {
          const target = chosen;
          const abs = resolveWorkspaceInput(target, agentLoop.workspace);
          const problem = validateWorkspace(abs);
          if (problem) {
            setHistory(prev => [...prev, { role: 'user', content: query, isLocal: true }, { role: 'assistant', content: `❌ ${problem}`, isLocal: true }]);
            setIsProcessing(false);
            return;
          }
          if (!agentLoop.skillFolders.includes(abs)) {
            agentLoop.skillFolders.push(abs);
            agentLoop._saveConfig();
            agentLoop.promptBuilder?.resetPromptState?.();
          }
          const found = listSkills(agentLoop.workspace, agentLoop.skillFolders).length;
          setHistory(prev => [...prev, { role: 'user', content: query, isLocal: true }, { role: 'assistant', content: `✔ Watching \`${abs}\` for skills — ${found} skill${found === 1 ? '' : 's'} visible now.`, isLocal: true }]);
          setIsProcessing(false);
          return;
        }

        if ((sub === 'remove' || sub === 'rm') && target) {
          const abs = resolveWorkspaceInput(target, agentLoop.workspace);
          const before = agentLoop.skillFolders.length;
          agentLoop.skillFolders = agentLoop.skillFolders.filter((f) => f !== abs && f !== target);
          const changed = agentLoop.skillFolders.length !== before;
          if (changed) {
            agentLoop._saveConfig();
            agentLoop.promptBuilder?.resetPromptState?.();
          }
          setHistory(prev => [...prev, { role: 'user', content: query, isLocal: true }, { role: 'assistant', content: changed ? `🗑️ Stopped watching \`${abs}\`.` : `Not a skill folder: \`${target}\``, isLocal: true }]);
          setIsProcessing(false);
          return;
        }

        const dirs = skillSearchPath(agentLoop.workspace, agentLoop.skillFolders)
          .map((d, i) => `  ${i + 1}. \`${d}\`${i === 0 ? ' _(this project)_' : i === 1 ? ' _(yours, all projects)_' : ''}`);
        setHistory(prev => [...prev, { role: 'user', content: query, isLocal: true }, {
          role: 'assistant',
          isLocal: true,
          content: `### 📁 Skill folders, searched in order\n${dirs.join('\n')}\n\n`
            + `Add one with \`/skills dir add <path>\`${canPickFolder() ? ' — or bare, to pick one from a dialog' : ''}, `
            + 'drop one with `/skills dir remove <path>`.\n'
            + 'The first folder to define a name wins, so a project can override a personal skill.',
        }]);
        setIsProcessing(false);
        return;
      }

      if (action === 'new' || action === 'add' || action === 'create') {
        const isGlobal = (args[1] || '').toLowerCase() === '--global';
        const nameParts = isGlobal ? args.slice(2) : args.slice(1);
        const result = createSkill(agentLoop.workspace, nameParts.join(' '), { global: isGlobal });
        if (!result.ok) {
          setHistory(prev => [...prev, { role: 'user', content: query, isLocal: true }, { role: 'assistant', content: `❌ ${result.error}`, isLocal: true }]);
          setIsProcessing(false);
          return;
        }
        // Open it straight away: a scaffold nobody edits is worse than nothing.
        try {
          const { exec } = await import('child_process');
          exec(`"${agentLoop.editor || 'code'}" "${result.file}" || open "${result.file}" || xdg-open "${result.file}"`);
        } catch (e) { /* no editor here; the path is in the message */ }
        // The catalogue is part of the system prompt, so it has to be re-sent.
        agentLoop.promptBuilder?.resetPromptState?.();
        setHistory(prev => [...prev, { role: 'user', content: query, isLocal: true }, {
          role: 'assistant',
          isLocal: true,
          content: `✔ Created skill **${result.name}**\n\n\`${result.file}\`\n\n`
            + 'Fill in the `description` — it is the only part always in the prompt, and it is '
            + 'what the agent matches against to decide whether to read the rest.',
        }]);
        setIsProcessing(false);
        return;
      }

      const skills = listSkills(agentLoop.workspace, agentLoop.skillFolders);
      if (action === 'list' || args.length > 0) {
        const body = skills.length === 0
          ? 'No skills yet. Create one with `/skills new <name>`.'
          : skills.map((sk) => `  • **${sk.name}** — ${sk.description || '_(no description)_'}\n    \`${sk.relative}\``).join('\n');
        setHistory(prev => [...prev, { role: 'user', content: query, isLocal: true }, { role: 'assistant', content: `### 🧩 Skills\n${body}`, isLocal: true }]);
        setIsProcessing(false);
        return;
      }

      setActiveMenu({ type: 'skills', skills, workspace: agentLoop.workspace });
      setIsProcessing(false);
      return;
    }

    /**
     * One command for one noun.
     *
     * There were three: `/workspace` printed a report, `/set-workspace` opened a
     * picker, and an internal `switch-workspace` did the actual restart — and
     * `/workspace <path>` **silently ignored the path**, printing the report and
     * doing nothing, which is the worst kind of no-op because it looks like it
     * worked.
     *
     * This is the shape phase 6 settled on for `/config`: the current state is
     * the screen's heading rather than a separate command that navigates away to
     * print what the screen could have shown. `/workspace` opens that screen;
     * `/workspace <path>` skips it. `/set-workspace` still answers — muscle
     * memory and the old hint text both point at it — but it is out of the
     * palette, because the point was to stop offering two doors to one room.
     */
    if (command === 'workspace' || command === 'set-workspace') {
      const target = args.join(' ').trim();
      if (!target) {
        setActiveMenu({ type: 'workspace', current: agentLoop.workspace });
        setIsProcessing(false);
        return;
      }
      await switchWorkspace(target);
      return;
    }

    // Chosen from the picker above. The process leaves and comes back pointing
    // at the new directory, because every collaborator keyed on the workspace —
    // the session store, memory, config, the allowlist — is rebuilt by a
    // restart and was *not* rebuilt by the in-place switch this replaces.
    /**
     * Leave, and come back pointing somewhere else.
     *
     * A restart rather than an in-place switch because every collaborator keyed
     * on the workspace — the session store, memory, config, the command
     * allowlist — is rebuilt by a restart and was *not* rebuilt by the in-place
     * version this replaced. See CLAUDE.md → P1.
     */
    async function switchWorkspace(raw) {
      // Validation, the supervisor check and the handover file are all in
      // core/restart.js now, because the side panel asks for the same thing
      // and the bridge cannot reach a React hook. Only the wording is local.
      const outcome = prepareWorkspaceSwitch(raw);
      if (!outcome.ok) {
        setHistory(prev => [...prev, { role: 'assistant', content: `❌ ${outcome.error}`, isLocal: true }]);
        setIsProcessing(false);
        return;
      }
      const { target } = outcome;
      const running = agentLoop.isProcessing;
      setHistory(prev => [...prev, {
        role: 'assistant', isLocal: true,
        content: running
          ? `⟳ Switching to \`${target}\` when this turn finishes — \`esc\` to stop it and go now.`
          : `⟳ Restarting in \`${target}\`…`,
      }]);
      setIsProcessing(false);
      leaveWhenIdle(RESTART_EXIT_CODE, { wsServer, agentLoop });
    }

    if (command === 'switch-workspace') {
      await switchWorkspace(args.join(' '));
      return;
    }

    if (command === 'github' && args.length === 0) {
      setActiveMenu({ type: 'github' });
      setIsProcessing(false);
      return;
    }

    if (command === 'image' || command === 'paste-image') {
      let finalFilePath = '';
      let ext = '';
      // `/image` with a path attaches that file; with nothing after it, the
      // thing you meant is the screenshot you just took. Two commands for one
      // idea is one too many, so the bare form reads the clipboard and
      // `/paste-image` survives only as the name people already learned.
      const fromClipboard = command === 'paste-image' || args.length === 0;
      if (fromClipboard) {
        if (process.platform !== 'darwin') {
           setHistory(prev => [...prev, { role: 'assistant', content: '⚠️ Clipboard image paste is only supported on macOS.' }]);
           setIsProcessing(false); return;
        }
        const { execSync } = await import('child_process');
        const { resolve } = await import('path');
        const { existsSync, mkdirSync } = await import('fs');
        
        try {
          const clipboardCheck = execSync(`osascript -e 'clipboard info'`, { encoding: 'utf-8', timeout: 5000 }).trim();
          if (!clipboardCheck.includes('«class PNGf»') && !clipboardCheck.includes('«class TIFF»') && !clipboardCheck.includes('JPEG')) {
            setHistory(prev => [...prev, { role: 'assistant', content: '⚠️ No image found in clipboard.' }]);
            setIsProcessing(false); return;
          }
          finalFilePath = resolve(paths.ensureDir(paths.tmpDir(agentLoop.workspace)), 'clipboard-image.png');
          execSync(`osascript -e 'set theFile to (open for access POSIX file "${finalFilePath}" with write permission)\n try\n write (the clipboard as «class PNGf») to theFile\n end try\n close access theFile'`, { timeout: 10000 });
          ext = '.png';
        } catch (e) {
          setHistory(prev => [...prev, { role: 'assistant', content: `❌ Failed to paste image: ${e.message}` }]);
          setIsProcessing(false); return;
        }
      } else {
        const { resolve, extname } = await import('path');
        const { existsSync } = await import('fs');
        finalFilePath = resolve(agentLoop.workspace, args.join(' '));
        if (!existsSync(finalFilePath)) {
           setHistory(prev => [...prev, { role: 'user', content: query, isLocal: true }, { role: 'assistant', content: `❌ File not found: ${finalFilePath}` }]);
           setIsProcessing(false); return;
        }
        ext = extname(finalFilePath).toLowerCase();
      }

      try {
        const { readFileSync } = await import('fs');
        const imageBuffer = readFileSync(finalFilePath);
        const mimeTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };
        const mime = mimeTypes[ext] || 'image/png';
        setPendingImage({
          base64: imageBuffer.toString('base64'),
          mime,
          path: finalFilePath,
          sizeKB: Math.round(imageBuffer.length / 1024)
        });
        setHistory(prev => [...prev, { role: 'user', content: query, isLocal: true }, { role: 'assistant', content: `🖼️ Image attached: ${finalFilePath} (${Math.round(imageBuffer.length / 1024)}KB)\nType your prompt and the image will be included.` }]);
      } catch (e) {
        setHistory(prev => [...prev, { role: 'user', content: query, isLocal: true }, { role: 'assistant', content: `❌ Error reading image: ${e.message}` }]);
      }
      setIsProcessing(false);
      return;
    }


    // Handle standard agent loop commands
    // From the module that handles them, not a copy kept here. The copy is how
    // `/name` shipped fully implemented and answering "No such command".
    if (AGENT_COMMANDS.has(command)) {
      // A command that throws must still hand the prompt back. Without this the
      // rejection escaped, `setIsProcessing(false)` below never ran, and the CLI
      // sat spinning with nothing on screen — which is exactly how a `/compact`
      // on a fresh session presented itself.
      try {
        const result = await agentLoop.handleSlashCommand(command, args);

        if (command === 'clear' || command === 'undo' || command === 'compact') {
          const newHistory = [...agentLoop.conversationHistory];
          if (result && result.message) {
            newHistory.push({ role: 'assistant', content: result.message, isLocal: true });
          }
          // These three rewrite the transcript rather than extend it — undo
          // removes a turn, compact replaces the older ones with a summary. Ink
          // cannot un-print what <Static> has committed, so a replace has to be
          // a repaint: without this the old turns stay on screen and the next
          // real one is skipped, which is the same fault mergeLoopHistory fixes
          // on the ordinary path.
          setHistory(newHistory);
          resetScreen();
        } else if (result && result.message) {
          setHistory(prev => [...prev, { role: 'user', content: query, isLocal: true }, { role: 'assistant', content: result.message, isLocal: true }]);
        }
      } catch (err) {
        setHistory(prev => [...prev, { role: 'user', content: query, isLocal: true }, {
          role: 'assistant',
          isLocal: true,
          content: `❌ \`/${command}\` failed: ${err?.message || err}`,
        }]);
      }
    } else {
      setHistory(prev => [...prev, { role: 'user', content: query, isLocal: true }, { role: 'assistant', content: `❌ No such command: \`/${command}\`\nType \`/\` on its own to see what there is.`, isLocal: true }]);
    }
    setIsProcessing(false);
    return;
}
