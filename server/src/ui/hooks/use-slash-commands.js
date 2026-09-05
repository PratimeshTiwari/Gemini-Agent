import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as paths from '../../core/paths.js';

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
  mouseTracking,
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
          '  [Tab]             - Toggle focus between Chat Input and Tool Executions',
          '  [Up/Down]         - Navigate between tool executions or CLI tabs',
          '  [Enter]           - Expand/Minimize raw output of tools, or Open GitHub Plan',
          '  [Ctrl+T]          - Toggle the Agent Terminal at the bottom of the screen',
          '  [Ctrl+O]          - Toggle between Agent Chat and GitHub PR Dashboard',
          "  :stop             - Immediately cancel the agent's current generation",
          '',
          '### 🧠 AI & LLM Settings',
          '  /mode             - Change agent topology (Single, Duo, Swarm)',
          '  /model            - Switch model tier (Flash, Flash Thinking, Pro)',
          '  /allowlist        - Manage auto-approved/blocked command rules',
          '  /config           - Configure models for specific roles',
          '  /plan             - Switch to Plan Mode (requires approval for edits)',
          '  /auto             - Switch to Auto Mode (auto-applies safe edits)',
          '',
          '### 📁 Workspace & Context',
          '  /workspace <path> - Change the active workspace',
          '  /memory           - View current agent memory context',
          '  /context          - Show current context window usage',
          '  /compact          - Compact history to save tokens',
          '  /clear            - Clear local history',
          '  /new              - Start a new chat session',
          '  /undo             - Undo the last step/action',
          '  /init-skills      - Create workspace rules (.agent/rules.md)',
          '',
          '### 🛠️ System & Tools',
          '  /github           - Run GitHub specific commands (e.g., /github refresh)',
          '  /image            - Attach an image (e.g., /image path/to/img.png)',
          '  /paste-image      - Attach image directly from clipboard (macOS only)',
          '  /mouse            - Toggle mouse tracking (clickable rows)',
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

    if (command === 'mouse') {
      const arg = (args[0] || '').toLowerCase();
      let msg;
      if (!mouseTracking.supported) {
        msg = '⚠️ This terminal does not report mouse events.';
      } else if (arg === 'on' || (arg === '' && !mouseTracking.enabled)) {
        mouseTracking.enable();
        msg = '🖱️ Mouse tracking **on** — click tool rows, slash commands and menus.\n\n'
          + 'The terminal hands the mouse to the app while this is on: drag-select needs '
          + 'Option/Shift held, and the wheel no longer scrolls scrollback. `/mouse off` gives them back.';
      } else {
        mouseTracking.disable();
        msg = '🖱️ Mouse tracking **off** — text selection and scrollback are back.';
      }
      setHistory(prev => [...prev, { role: 'user', content: query }, { role: 'assistant', content: msg, isLocal: true }]);
      setIsProcessing(false);
      return;
    }

    // Handle standard agent loop commands
    const validAgentCommands = ['plan', 'auto', 'context', 'undo', 'workspace', 'memory', 'compact', 'clear', 'agent-dir', 'config', 'mode', 'model', 'allowlist', 'github'];
    if (validAgentCommands.includes(command)) {
      const result = await agentLoop.handleSlashCommand(command, args);
      
      if (command === 'clear' || command === 'undo' || command === 'compact') {
        const newHistory = [...agentLoop.conversationHistory];
        if (result && result.message) {
          newHistory.push({ role: 'assistant', content: result.message });
        }
        setHistory(newHistory);
      } else if (result && result.message) {
        setHistory(prev => [...prev, { role: 'user', content: query }, { role: 'assistant', content: result.message }]);
      }
    } else {
      setHistory(prev => [...prev, { role: 'user', content: query }, { role: 'assistant', content: `❌ Unrecognized command: \`/${command}\`\nType \`/help\` to see the list of available commands.` }]);
    }
    setIsProcessing(false);
    return;
}
