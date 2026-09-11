import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as paths from '../../core/paths.js';
import { createSkill, listSkills, skillSearchPath } from '../../core/skills.js';
import { readErrors, summarizeErrors, clearErrors, FLOWS } from '../../core/error-log.js';
import { listPlans } from '../../core/plan-archive.js';
import { resolveWorkspaceInput, validateWorkspace } from '../../core/workspaces.js';
import { SLASH_COMMANDS } from '../constants.js';
import { SETTING_GROUPS } from '../../core/settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Run a "/" command.
 *
 * Some are answered here (they only touch UI state), the rest are handed to
 * AgentLoop.handleSlashCommand. Anything unrecognised reports itself rather
 * than being sent to the model as a prompt.
 */
export async function handleSlashCommand(query, {
  agentLoop,
  wsServer,
  resetScreen,
  setActiveMenu,
  setHistory,
  setIsProcessing,
  setPendingImage,
}) {
    const parts = query.slice(1).split(/\s+/);
    const command = parts[0].toLowerCase();
    const args = parts.slice(1);

    // Generated from SLASH_COMMANDS, not written out beside it. The hand-kept
    // copy had drifted twice — listing /init-skills and /paste-image after both
    // were gone, and describing /memory as "view memory" while it toggled it —
    // because nothing made the two lists agree.
    if (command === 'help' || command === 'shortcuts') {
      const width = Math.max(...SLASH_COMMANDS.map((c) => c.name.length));
      setHistory(prev => [...prev, { role: 'user', content: query }, {
        role: 'assistant',
        isLocal: true,
        content: [
          '### ⌨️  Keys',
          '  shift+tab   plan ⇄ auto',
          '  ctrl+e      expand or collapse every step',
          '  ctrl+t      shell',
          '  ctrl+o      GitHub dashboard',
          '  ctrl+u      clear the input   ·   ctrl+w   delete the last word',
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
      setHistory(prev => [...prev, { role: 'user', content: query }, { role: 'assistant', content: '👋 Goodbye! Agent shutting down.', isLocal: true }]);
      setIsProcessing(false);
      setTimeout(() => process.exit(0), 100);
      return;
    }

    // Exit with the code src/index.js watches for, and it relaunches us. The
    // old version touched index.js's mtime, which does something only under
    // `tsx --watch` and nothing under `agent-cli` — where it printed
    // "Restarting server..." and stayed exactly where it was.
    if (command === 'restart') {
      if (!process.env.AGENT_CLI_SUPERVISED) {
        setHistory(prev => [...prev, { role: 'user', content: query }, {
          role: 'assistant',
          isLocal: true,
          content: 'This process has no supervisor to restart it — it was started directly '
            + 'rather than through `agent-cli`.\n\nQuit with `/exit` and start it again.',
        }]);
        setIsProcessing(false);
        return;
      }
      setHistory(prev => [...prev, { role: 'user', content: query }, {
        role: 'assistant', content: '🔄 Restarting…', isLocal: true,
      }]);
      setIsProcessing(false);
      // Let the frame paint, then leave. Ink restores the terminal on exit,
      // which is why this is an ordinary exit rather than an exec in place.
      setTimeout(() => process.exit(75), 120);
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
      setHistory(prev => [...prev, { role: 'user', content: query }, {
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
      setActiveMenu({ type: 'settings', query: '', group: SETTING_GROUPS[0] });
      setIsProcessing(false);
      return;
    }

    if (command === 'plans') {
      const plans = listPlans(agentLoop.workspace);
      if (plans.length === 0) {
        setHistory(prev => [...prev, { role: 'user', content: query }, {
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
        setHistory(prev => [...prev, { role: 'user', content: query }, { role: 'assistant', content: `🧹 Cleared ${n} logged failure${n === 1 ? '' : 's'}.`, isLocal: true }]);
        setIsProcessing(false);
        return;
      }

      // `/logs <flow>` drills into one; bare `/logs` answers "what is breaking?"
      if (arg && FLOWS[arg]) {
        const entries = readErrors(agentLoop.workspace, { flow: arg, limit: 15 });
        const body = entries.length === 0
          ? `Nothing logged for **${arg}**.`
          : entries.map((e) => {
            const when = new Date(e.time).toLocaleTimeString();
            const repeat = e.repeatedSince ? ` _(+${e.repeatedSince} more like it)_` : '';
            const detail = e.detail ? `\n    \`${String(e.detail).split('\n')[0].slice(0, 120)}\`` : '';
            return `  ${when} **${e.op || '—'}** — ${e.message}${repeat}${detail}`;
          }).join('\n');
        setHistory(prev => [...prev, { role: 'user', content: query }, { role: 'assistant', content: `### 🩺 ${arg} — ${FLOWS[arg]}\n${body}`, isLocal: true }]);
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
      setHistory(prev => [...prev, { role: 'user', content: query }, { role: 'assistant', content, isLocal: true }]);
      setIsProcessing(false);
      return;
    }

    if (command === 'skills' || command === 'skill') {
      const action = (args[0] || '').toLowerCase();

      // Point the agent at a directory of skills you keep elsewhere.
      if (action === 'dir' || action === 'folder') {
        const sub = (args[1] || '').toLowerCase();
        const target = args.slice(2).join(' ').trim();

        if (sub === 'add' && target) {
          const abs = resolveWorkspaceInput(target, agentLoop.workspace);
          const problem = validateWorkspace(abs);
          if (problem) {
            setHistory(prev => [...prev, { role: 'user', content: query }, { role: 'assistant', content: `❌ ${problem}`, isLocal: true }]);
            setIsProcessing(false);
            return;
          }
          if (!agentLoop.skillFolders.includes(abs)) {
            agentLoop.skillFolders.push(abs);
            agentLoop._saveConfig();
            agentLoop.promptBuilder?.resetPromptState?.();
          }
          const found = listSkills(agentLoop.workspace, agentLoop.skillFolders).length;
          setHistory(prev => [...prev, { role: 'user', content: query }, { role: 'assistant', content: `✅ Watching \`${abs}\` for skills — ${found} skill${found === 1 ? '' : 's'} visible now.`, isLocal: true }]);
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
          setHistory(prev => [...prev, { role: 'user', content: query }, { role: 'assistant', content: changed ? `🗑️ Stopped watching \`${abs}\`.` : `Not a skill folder: \`${target}\``, isLocal: true }]);
          setIsProcessing(false);
          return;
        }

        const dirs = skillSearchPath(agentLoop.workspace, agentLoop.skillFolders)
          .map((d, i) => `  ${i + 1}. \`${d}\`${i === 0 ? ' _(this project)_' : i === 1 ? ' _(yours, all projects)_' : ''}`);
        setHistory(prev => [...prev, { role: 'user', content: query }, {
          role: 'assistant',
          isLocal: true,
          content: `### 📁 Skill folders, searched in order\n${dirs.join('\n')}\n\n`
            + 'Add one with `/skills dir add <path>`, drop one with `/skills dir remove <path>`.\n'
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
          setHistory(prev => [...prev, { role: 'user', content: query }, { role: 'assistant', content: `❌ ${result.error}`, isLocal: true }]);
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
        setHistory(prev => [...prev, { role: 'user', content: query }, {
          role: 'assistant',
          isLocal: true,
          content: `✅ Created skill **${result.name}**\n\n\`${result.file}\`\n\n`
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
        setHistory(prev => [...prev, { role: 'user', content: query }, { role: 'assistant', content: `### 🧩 Skills\n${body}`, isLocal: true }]);
        setIsProcessing(false);
        return;
      }

      setActiveMenu({ type: 'skills', skills, workspace: agentLoop.workspace });
      setIsProcessing(false);
      return;
    }

    // `/workspace` on its own reports; only `/set-workspace` offers the switch,
    // and the switch is a restart.
    if (command === 'set-workspace') {
      setActiveMenu({ type: 'workspace', current: agentLoop.workspace });
      setIsProcessing(false);
      return;
    }

    // Chosen from the picker above. The process leaves and comes back pointing
    // at the new directory, because every collaborator keyed on the workspace —
    // the session store, memory, config, the allowlist — is rebuilt by a
    // restart and was *not* rebuilt by the in-place switch this replaces.
    if (command === 'switch-workspace') {
      const target = args.join(' ').trim();
      const problem = validateWorkspace(target);
      if (problem) {
        setHistory(prev => [...prev, { role: 'assistant', content: `❌ ${problem}`, isLocal: true }]);
        setIsProcessing(false);
        return;
      }
      if (!process.env.AGENT_CLI_SUPERVISED) {
        setHistory(prev => [...prev, {
          role: 'assistant',
          isLocal: true,
          content: 'This process has no supervisor to restart it.\n\n'
            + `Quit with \`/exit\` and start again: \`agent-cli --workspace ${target}\``,
        }]);
        setIsProcessing(false);
        return;
      }
      try {
        const { writeFileSync } = await import('fs');
        writeFileSync(paths.ensureParent(paths.nextWorkspacePath()), target, 'utf8');
      } catch (err) {
        setHistory(prev => [...prev, { role: 'assistant', content: `❌ Could not hand over: ${err.message}`, isLocal: true }]);
        setIsProcessing(false);
        return;
      }
      setHistory(prev => [...prev, { role: 'assistant', content: `📂 Restarting in \`${target}\`…`, isLocal: true }]);
      setIsProcessing(false);
      setTimeout(() => process.exit(75), 120);
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
           setHistory(prev => [...prev, { role: 'user', content: query }, { role: 'assistant', content: `❌ File not found: ${finalFilePath}` }]);
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
        setHistory(prev => [...prev, { role: 'user', content: query }, { role: 'assistant', content: `🖼️ Image attached: ${finalFilePath} (${Math.round(imageBuffer.length / 1024)}KB)\nType your prompt and the image will be included.` }]);
      } catch (e) {
        setHistory(prev => [...prev, { role: 'user', content: query }, { role: 'assistant', content: `❌ Error reading image: ${e.message}` }]);
      }
      setIsProcessing(false);
      return;
    }


    // Handle standard agent loop commands
    const validAgentCommands = ['plan', 'auto', 'context', 'undo', 'workspace', 'memory', 'compact', 'clear', 'agent-dir', 'config', 'mode', 'effort', 'model', 'reasoning', 'allowlist', 'github'];
    if (validAgentCommands.includes(command)) {
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
          setHistory(newHistory);
        } else if (result && result.message) {
          setHistory(prev => [...prev, { role: 'user', content: query }, { role: 'assistant', content: result.message, isLocal: true }]);
        }
      } catch (err) {
        setHistory(prev => [...prev, { role: 'user', content: query }, {
          role: 'assistant',
          isLocal: true,
          content: `❌ \`/${command}\` failed: ${err?.message || err}`,
        }]);
      }
    } else {
      setHistory(prev => [...prev, { role: 'user', content: query }, { role: 'assistant', content: `❌ No such command: \`/${command}\`\nType \`/\` on its own to see what there is.`, isLocal: true }]);
    }
    setIsProcessing(false);
    return;
}
