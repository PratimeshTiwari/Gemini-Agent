import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as paths from '../../core/paths.js';
import { createSkill, listSkills, skillSearchPath } from '../../core/skills.js';
import { readErrors, summarizeErrors, clearErrors, FLOWS } from '../../core/error-log.js';
import { resolveWorkspaceInput, validateWorkspace, listScopes } from '../../core/workspaces.js';

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

    if (command === 'shortcuts' || command === 'help') {
      const shortcutsMessage = {
        role: 'assistant',
        isLocal: true,
        content: [
          '### ⌨️ UI & Navigation',
          '  [Tab]             - Complete a slash command, or return to the prompt',
          '  [Up/Down]         - Prompt history (or the list, on the GitHub tab)',
          '  [Ctrl+E]          - Expand/collapse every step and tool output',
          '  [Ctrl+T]          - Toggle the Agent Terminal at the bottom of the screen',
          '  [Ctrl+O]          - Toggle between Agent Chat and GitHub PR Dashboard',
          '  [Shift+Tab]       - Cycle Plan <-> Auto mode',
          '  [Esc]             - Stop the run, or close whatever is open',
          "  :stop             - Immediately cancel the agent's current generation",
          '',
          '### 🧠 AI & LLM Settings',
          '  /mode             - Change agent topology (Single, Duo, Swarm)',
          '  /model            - Switch model tier (Flash, Flash Thinking, Pro)',
          '  /reasoning        - How hard Pro plans before acting (Brief, Standard, Deep)',
          '  /allowlist        - Manage auto-approved/blocked command rules',
          '  /config           - Configure models for specific roles',
          '  /plan             - Switch to Plan Mode (requires approval for edits)',
          '  /auto             - Switch to Auto Mode (auto-applies safe edits)',
          '',
          '### 📁 Workspace & Context',
          '  /scope [repo]     - Work on one repo in a group that shares a .agent/',
          '  /workspace <path> - Change the active workspace (checked before it is set)',
          '  /set-workspace    - Pick a workspace from a list of nearby folders',
          '  /memory           - View current agent memory context',
          '  /context          - Show current context window usage',
          '  /compact          - Compact history to save tokens',
          '  /clear            - Clear local history',
          '  /new              - Start a new chat session',
          '  /undo             - Undo the last step/action',
          '  /skills           - List, create and open skills (.agent/skills/*.md)',
          '  /skills dir       - Show or add directories skills are loaded from',
          '  /init-skills      - Create workspace rules (.agent/rules.md)',
          '',
          '### 🛠️ System & Tools',
          '  /github           - Run GitHub specific commands (e.g., /github refresh)',
          '  /image            - Attach an image (e.g., /image path/to/img.png)',
          '  /paste-image      - Attach image directly from clipboard (macOS only)',
          '  /logs             - What has been failing, grouped by flow',
          '  /agent-dir        - Open the agent data directory',
          '  /restart          - Restart the server',
          '  /exit             - Quit the agent'
        ].join('\n')
      };
      setHistory(prev => [...prev, { role: 'user', content: query }, shortcutsMessage]);
      setIsProcessing(false);
      return;
    }

    if (command === 'exit') {
      setHistory(prev => [...prev, { role: 'user', content: query }, { role: 'assistant', content: '👋 Goodbye! Agent shutting down.', isLocal: true }]);
      setIsProcessing(false);
      setTimeout(() => process.exit(0), 100);
      return;
    }

    if (command === 'restart') {
      const indexPath = path.resolve(__dirname, '../..', 'index.js');
      const now = new Date();
      try {
        fs.utimesSync(indexPath, now, now);
      setHistory(prev => [...prev, { role: 'user', content: query }, { role: 'assistant', content: '🔄 Restarting server...', isLocal: true }]);
      } catch (err) {
        setHistory(prev => [...prev, { role: 'user', content: query }, { role: 'assistant', content: '❌ Failed to restart server: ' + err.message, isLocal: true }]);
      }
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

    if (command === 'mode') {
      setActiveMenu({ type: 'mode' });
      setIsProcessing(false);
      return;
    }

    if (command === 'config') {
      setActiveMenu({ type: 'config_role' });
      setIsProcessing(false);
      return;
    }

    if (command === 'model') {
      setActiveMenu({ type: 'model' });
      setIsProcessing(false);
      return;
    }

    if (command === 'reasoning' && args.length === 0) {
      setActiveMenu({ type: 'reasoning' });
      setIsProcessing(false);
      return;
    }

    if (command === 'scope' || command === 'repo') {
      const scopes = listScopes(agentLoop.workspace);
      const target = args.join(' ').trim();

      if (scopes.length === 0) {
        setHistory(prev => [...prev, { role: 'user', content: query }, {
          role: 'assistant',
          isLocal: true,
          content: 'This workspace has its own `.agent/`, so there is nothing to scope between.\n\n'
            + 'Scopes exist when several repos share one `.agent/` from a parent folder — put '
            + '`.agent/` in the folder above your repos and open that folder (or any repo inside it).',
        }]);
        setIsProcessing(false);
        return;
      }

      if (target) {
        const match = scopes.find((sc) => sc.name === target)
          || scopes.find((sc) => sc.name.toLowerCase() === target.toLowerCase());
        if (!match) {
          setHistory(prev => [...prev, { role: 'user', content: query }, {
            role: 'assistant', isLocal: true,
            content: `❌ No repo called \`${target}\` here.\nAvailable: ${scopes.map((sc) => sc.name).join(', ')}`,
          }]);
          setIsProcessing(false);
          return;
        }
        const message = agentLoop.setScope(match.name);
        setHistory([...agentLoop.conversationHistory, { role: 'assistant', content: message, isLocal: true }]);
        resetScreen();
        setIsProcessing(false);
        return;
      }

      setActiveMenu({ type: 'scope', scopes, workspace: agentLoop.workspace });
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

    if (command === 'set-workspace' || (command === 'workspace' && args.length === 0)) {
      setActiveMenu({ type: 'workspace', current: agentLoop.workspace });
      setIsProcessing(false);
      return;
    }

    if (command === 'github' && args.length === 0) {
      setActiveMenu({ type: 'github' });
      setIsProcessing(false);
      return;
    }

    if (command === 'init-skills') {
      const { resolve } = await import('path');
      const { existsSync, mkdirSync, writeFileSync } = await import('fs');
      const rulesPath = paths.rulesPath(agentLoop.workspace);
      paths.ensureParent(rulesPath);
      
      let msg = '';
      if (!existsSync(rulesPath)) {
        writeFileSync(rulesPath, `# Workspace Rules\n\nAdd any custom instructions, architectural rules, or context specific to this project here.\n`, 'utf-8');
        msg = `✅ Created workspace memory at: ${rulesPath}\nEdit this file to teach the agent custom skills!`;
      } else {
        msg = `⚠️ Workspace rules already exist at: ${rulesPath}`;
      }
      setHistory(prev => [...prev, { role: 'user', content: query }, { role: 'assistant', content: msg, isLocal: true }]);
      setIsProcessing(false);
      return;
    }

    if (command === 'image' || command === 'paste-image') {
      let finalFilePath = '';
      let ext = '';
      if (command === 'paste-image') {
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
    const validAgentCommands = ['plan', 'auto', 'context', 'undo', 'workspace', 'memory', 'compact', 'clear', 'agent-dir', 'config', 'mode', 'model', 'reasoning', 'allowlist', 'github'];
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
      setHistory(prev => [...prev, { role: 'user', content: query }, { role: 'assistant', content: `❌ Unrecognized command: \`/${command}\`\nType \`/help\` to see the list of available commands.`, isLocal: true }]);
    }
    setIsProcessing(false);
    return;
}
