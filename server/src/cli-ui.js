import readline from 'readline';
import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import chalk from 'chalk';
import ora from 'ora';

marked.use(markedTerminal());

export class CliUI {
  constructor(agentLoop, wsServer) {
    this.agentLoop = agentLoop;
    this.wsServer = wsServer;
    
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: '🤖 > '
    });

    this.spinner = ora();
    this.isWaitingForDiff = false;
    this.pendingDiffId = null;

    this.setupCallbacks();
  }

  start() {
    console.clear();
    this.printHeader();
    this.rl.prompt();

    let inputBuffer = [];
    let submitTimer = null;
    let isMultilineMode = false;

    // Handle Ctrl+C gracefully
    this.rl.on('SIGINT', () => {
      if (isMultilineMode || inputBuffer.length > 0) {
        inputBuffer = [];
        isMultilineMode = false;
        console.log('\n🛑 Input cancelled.');
        if (this.isWaitingForDiff) {
          this.rl.setPrompt('Approve this change? (y/n) or type your feedback: ');
        } else {
          this.updatePrompt();
        }
        this.rl.prompt();
        return;
      }

      if (this.agentLoop.isProcessing || this.isWaitingForDiff) {
        this.spinner.stop();
        console.log('\n🛑 Cancelled.');
        this.agentLoop.isProcessing = false;
        this.isWaitingForDiff = false;
        this.pendingDiffId = null;
        this.updatePrompt();
        this.rl.prompt();
      } else {
        process.exit(0);
      }
    });

    const submitInput = async () => {
      const input = inputBuffer.join('\n').trim();
      inputBuffer = []; // clear buffer
      isMultilineMode = false;

      if (this.isWaitingForDiff) {
        this.handleDiffInput(input);
        return;
      }

      if (!input) {
        if (this.isWaitingForDiff) {
          this.rl.setPrompt('Approve this change? (y/n) or type your feedback: ');
        } else {
          this.updatePrompt();
        }
        this.rl.prompt();
        return;
      }

      if (input.startsWith('/')) {
        // Handle multiline pasted slash commands by taking only the first line as command, 
        // but typically slash commands shouldn't be pasted with newlines. 
        // If they are, we'll just evaluate the first part.
        const firstLine = input.split('\n')[0].trim();
        await this.handleCliCommand(firstLine);
        return;
      }

      // Auto-detect if the user dragged/dropped an image file or pasted an absolute path
      if (input.match(/^\/.+\.(png|jpe?g|gif|webp|bmp)$/i)) {
        const { existsSync } = await import('fs');
        if (existsSync(input.trim())) {
          await this._handleImageCommand([input.trim()]);
          return; // The image command will attach it and prompt for the actual message
        }
      }

      this.spinner.text = 'Thinking...';
      this.spinner.color = 'cyan';
      this.spinner.start();
      
      // Include pending image if one was attached
      let messageContent = input;
      if (this.pendingImage) {
        const imgInfo = this.pendingImage;
        messageContent = `[Image attached: ${imgInfo.path} (${imgInfo.sizeKB}KB, ${imgInfo.mime})]\n\n<image_data>\ndata:${imgInfo.mime};base64,${imgInfo.base64}\n</image_data>\n\n${input}`;
        this.pendingImage = null;
      }

      await this.agentLoop.handleUserMessage(messageContent, this.callbacks);
    };

    this.rl.on('line', (line) => {
      if (isMultilineMode && line.trim() === '') {
        clearTimeout(submitTimer);
        submitInput();
        return;
      }

      inputBuffer.push(line);

      clearTimeout(submitTimer);

      submitTimer = setTimeout(() => {
        if (inputBuffer.length > 1 || isMultilineMode) {
          if (!isMultilineMode) {
            isMultilineMode = true;
            process.stdout.write(chalk.dim('\n[Multiline input detected. Press Enter on an empty line to submit]\n'));
          }
          this.rl.setPrompt('... ');
          this.rl.prompt();
          return;
        }

        submitInput();
      }, 50);
    });
  }

  updatePrompt() {
    const turns = this.agentLoop.conversationHistory.length;
    const modeStr = this.agentLoop.mode === 'plan' ? chalk.yellow('Plan Mode') : chalk.green('Auto Mode');
    const turnsStr = chalk.dim(`[Context: ${turns}/50]`);
    this.rl.setPrompt(`\n${modeStr} ${turnsStr}\n🤖 > `);
  }

  printHeader() {
    // Calculate context usage (using turns instead of exact tokens)
    const MAX_TURNS = 50; // Arbitrary safe limit before we should compact
    const turns = this.agentLoop.conversationHistory.length;
    const usagePercent = Math.min(100, Math.round((turns / MAX_TURNS) * 100));
    
    // Create a progress bar: [██████░░░░░░░░░░]
    const barLength = 20;
    const filledBlocks = Math.floor((usagePercent / 100) * barLength);
    const emptyBlocks = barLength - filledBlocks;
    const progressBar = chalk.green('█'.repeat(filledBlocks)) + chalk.dim('░'.repeat(emptyBlocks));
    
    let color = usagePercent > 80 ? chalk.red : usagePercent > 50 ? chalk.yellow : chalk.green;
    
    console.log(chalk.bold.blue('╭────────────────────────────────────────────────────────────╮'));
    console.log(chalk.bold.blue('│') + chalk.bold.white('                  🤖 Gemini Agent CLI                     ') + chalk.bold.blue('│'));
    console.log(chalk.bold.blue('╰────────────────────────────────────────────────────────────╯'));
    console.log(chalk.dim('Type /help to see available commands.\n'));
    
    console.log(chalk.bold('Model:') + chalk.cyan('  Google Gemini (Managed in Browser UI)'));
    console.log(chalk.bold('Context Usage:'));
    console.log(`[${progressBar}] ${color(`${usagePercent}%`)} (${turns}/${MAX_TURNS} turns)\n`);
    
    if (usagePercent > 80) {
      console.log(chalk.yellow('⚠️  Context is getting full. Consider running ') + chalk.bold('/compact') + chalk.yellow(' soon.\n'));
    }
  }

  async handleCliCommand(input) {
    const parts = input.slice(1).split(/\s+/);
    const command = parts[0].toLowerCase();
    const args = parts.slice(1);

    if (command === 'exit' || command === 'quit') {
      console.log('\n🛑 Goodbye!');
      process.exit(0);
    }
    
    if (command === 'clear') {
      this.agentLoop.conversationHistory = [];
      console.clear();
      this.printHeader();
      this.rl.prompt();
      return;
    }

    if (command === 'help' || command === 'commands') {
      console.log(`
Available Commands:
  /plan         - Switch to Plan Mode (Safe). All edits require approval.
  /auto         - Switch to Auto Mode (Fast). Safe edits auto-applied.
  /clear        - Clear the local conversation history.
  /context      - Show current context usage and diff stats.
  /compact      - Ask Gemini to summarize history and start a new chat.
  /undo         - Undo the last applied file change.
  /workspace    - Show or change the current workspace directory.
  /image <path> - Attach an image file to your next message.
  /paste-image  - Attach image from clipboard (macOS).
  /model        - Instructions on how to change the Gemini model.
  /exit         - Exit the Gemini Agent server.
  /help         - Show this help menu.
`);
      this.rl.prompt();
      return;
    }

    if (command === 'model') {
      console.log(`\n🤖 To change the model (e.g., from Flash to Pro), simply select the new model from the dropdown menu inside your gemini.google.com browser tab!\n`);
      this.rl.prompt();
      return;
    }

    if (command === 'image') {
      await this._handleImageCommand(args);
      return;
    }

    if (command === 'paste-image') {
      await this._handlePasteImage();
      return;
    }

    const result = await this.agentLoop.handleSlashCommand(command, args);
    if (result && result.message) {
      console.log(`\n${result.message}\n`);
    }
    this.rl.prompt();
  }

  setupCallbacks() {
    this.callbacks = {
      sendToPanel: (msg) => {
        this.wsServer.broadcast('extension', msg);

        if (msg.type === 'agent_response') {
          this.spinner.stop();
          console.log(`\n${chalk.blue.bold('🤖 Agent:')}\n`);
          console.log(marked.parse(msg.payload.content).trim());
          console.log('');
          if (!this.isWaitingForDiff) { this.updatePrompt(); this.rl.prompt(); }
        } else if (msg.type === 'response_stream') {
          // Streaming partial response — show preview in spinner
          if (this.spinner.isSpinning && msg.payload.content) {
            const preview = msg.payload.content.substring(0, 80).replace(/\n/g, ' ');
            this.spinner.text = chalk.dim(`Generating: ${preview}...`);
          }
        } else if (msg.type === 'status') {
          if (msg.payload.message && !msg.payload.message.includes('Thinking')) {
            this.spinner.text = msg.payload.message;
          }
        } else if (msg.type === 'tool_call') {
          // Richer tool call display
          const name = msg.payload.name;
          const args = msg.payload.args || {};
          const icon = this._toolIcon(name);
          let detail = '';

          if (name === 'read_file') {
            detail = chalk.dim(` ${args.path || ''}`);
            if (args.startLine) detail += chalk.dim(` (lines ${args.startLine}-${args.endLine || 'end'})`);
          } else if (name === 'grep_search') {
            detail = chalk.dim(` "${args.pattern || ''}"${args.includes ? ` in ${args.includes.join(',')}` : ''}`);
          } else if (name === 'search_files') {
            detail = chalk.dim(` "${args.query || ''}"`);
          } else if (name === 'edit_file' || name === 'create_file') {
            detail = chalk.dim(` ${args.path || ''}`);
          } else if (name === 'run_command') {
            detail = chalk.dim(` $ ${(args.command || '').substring(0, 60)}`);
          } else if (name === 'list_directory') {
            detail = chalk.dim(` ${args.path || '.'}`);
          }

          this.spinner.text = `${icon} ${chalk.bold(name)}${detail}`;
        } else if (msg.type === 'tool_result') {
          if (!msg.payload.success) {
            this.spinner.stop();
            console.log(chalk.red(`  ✗ ${msg.payload.name} failed: ${msg.payload.error}`));
            this.spinner.start();
          }
        } else if (msg.type === 'error') {
          this.spinner.stop();
          console.log(`\n${chalk.bgRed.white(' ❌ ERROR ')} ${chalk.red(msg.payload.message)}\n`);
          if (!this.isWaitingForDiff) { this.updatePrompt(); this.rl.prompt(); }
        }
      },
      
      injectPrompt: (msg) => {
        this.wsServer.broadcast('extension', {
          id: crypto.randomUUID(),
          type: 'inject_prompt',
          payload: msg,
          timestamp: Date.now(),
        });
      },
      
      requestDiffApproval: (diff) => {
        this.spinner.stop();
        
        this.wsServer.broadcast('extension', {
          id: crypto.randomUUID(),
          type: 'diff_request',
          payload: diff,
          timestamp: Date.now(),
        });

        this.isWaitingForDiff = true;
        this.pendingDiffId = diff.diffId;
        
        console.log(`\n⚠️  Diff Approval Required: ${diff.filePath}`);
        console.log(`Risk Level: ${diff.riskLevel}`);
        if (diff.patch) {
          console.log('--- Patch ---');
          console.log(diff.patch);
          console.log('-------------');
        }
        
        this.rl.setPrompt('Approve this change? (y/n) or type your feedback: ');
        this.rl.prompt();
      }
    };
  }

  async handleDiffInput(input) {
    const text = input.trim();
    if (text.toLowerCase() === 'y') {
      this.agentLoop.handleDiffResponse(crypto.randomUUID(), {
        diffId: this.pendingDiffId,
        action: 'accept'
      });
      console.log('✅ Diff accepted.');
    } else if (text.toLowerCase() === 'n') {
      this.agentLoop.handleDiffResponse(crypto.randomUUID(), {
        diffId: this.pendingDiffId,
        action: 'reject'
      });
      console.log('❌ Diff rejected.');
    } else {
      // User typed feedback instead of y/n! We reject the diff and send the feedback to the agent.
      console.log('📨 Sending your feedback to the agent...');
      this.agentLoop.handleDiffResponse(crypto.randomUUID(), {
        diffId: this.pendingDiffId,
        action: 'reject'
      });
      
      this.isWaitingForDiff = false;
      this.pendingDiffId = null;
      this.rl.setPrompt('🤖 > ');
      
      // Send the feedback as a user message
      await this.agentLoop.handleUserMessage(`I rejected the change. Here is my feedback: ${text}`, this.callbacks);
      return;
    }
    
    this.isWaitingForDiff = false;
    this.pendingDiffId = null;
    this.rl.setPrompt('🤖 > ');
    this.rl.prompt();
  }

  _toolIcon(toolName) {
    const icons = {
      read_file: '📖',
      grep_search: '🔍',
      search_files: '🔎',
      edit_file: '✏️',
      create_file: '📁',
      run_command: '⚡',
      list_directory: '📂',
      open_in_editor: '👁️',
    };
    return icons[toolName] || '🔧';
  }

  async _handleImageCommand(args) {
    if (!args || args.length === 0) {
      console.log(chalk.yellow('\nUsage: /image <file-path>'));
      console.log(chalk.dim('  Example: /image ./screenshot.png'));
      console.log(chalk.dim('  Or use /paste-image to grab from clipboard (macOS)\n'));
      this.rl.prompt();
      return;
    }

    const { resolve, extname } = await import('path');
    const { readFileSync, existsSync } = await import('fs');

    const filePath = resolve(this.agentLoop.workspace, args.join(' '));
    
    if (!existsSync(filePath)) {
      console.log(chalk.red(`\n❌ File not found: ${filePath}\n`));
      this.rl.prompt();
      return;
    }

    const ext = extname(filePath).toLowerCase();
    const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];
    if (!imageExts.includes(ext)) {
      console.log(chalk.red(`\n❌ Not an image file (supported: ${imageExts.join(', ')})\n`));
      this.rl.prompt();
      return;
    }

    try {
      let finalFilePath = filePath;
      const { statSync } = await import('fs');
      const sizeMB = statSync(filePath).size / (1024 * 1024);

      if (sizeMB > 2) {
        if (process.platform === 'darwin') {
          console.log(chalk.dim(`Image is large (${sizeMB.toFixed(1)}MB). Compressing...`));
          const { execSync } = await import('child_process');
          const { resolve } = await import('path');
          const { mkdirSync, copyFileSync } = await import('fs');
          
          const tmpDir = resolve(this.agentLoop.workspace, '.gemini-agent');
          mkdirSync(tmpDir, { recursive: true });
          const tmpPath = resolve(tmpDir, `compressed-${Date.now()}${ext}`);
          
          copyFileSync(filePath, tmpPath);
          execSync(`sips -Z 1600 "${tmpPath}"`, { stdio: 'ignore' });
          finalFilePath = tmpPath;
        } else {
          console.log(chalk.yellow(`\n⚠️ Warning: Image is very large (${sizeMB.toFixed(1)}MB). This might slow down the bridge.\n`));
        }
      }

      const imageBuffer = readFileSync(finalFilePath);
      const mimeTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };
      const mime = mimeTypes[ext] || 'image/png';
      const base64 = imageBuffer.toString('base64');
      const sizeKB = Math.round(imageBuffer.length / 1024);

      this.pendingImage = { base64, mime, path: filePath, sizeKB }; // Show original path to user
      console.log(chalk.green(`\n🖼️  Image attached: ${filePath} (${sizeKB}KB)`));
      console.log(chalk.dim('Type your message and the image will be included.\n'));

      // Cleanup tmp file if created
      if (finalFilePath !== filePath) {
        const { unlinkSync } = await import('fs');
        try { unlinkSync(finalFilePath); } catch {}
      }
    } catch (err) {
      console.log(chalk.red(`\n❌ Failed to read or compress image: ${err.message}\n`));
    }
    this.rl.prompt();
  }

  async _handlePasteImage() {
    if (process.platform !== 'darwin') {
      console.log(chalk.yellow('\n⚠️ Clipboard image paste is only supported on macOS.\n'));
      this.rl.prompt();
      return;
    }

    const { execSync } = await import('child_process');
    const { resolve } = await import('path');
    const { readFileSync, existsSync, unlinkSync, mkdirSync } = await import('fs');

    try {
      // Check if clipboard has an image using osascript
      const clipboardCheck = execSync(
        `osascript -e 'clipboard info'`,
        { encoding: 'utf-8', timeout: 5000 }
      ).trim();

      if (!clipboardCheck.includes('«class PNGf»') && !clipboardCheck.includes('«class TIFF»') && !clipboardCheck.includes('JPEG')) {
        console.log(chalk.yellow('\n⚠️ No image found in clipboard. Copy an image first!\n'));
        this.rl.prompt();
        return;
      }

      // Save clipboard image to temp file
      const tmpDir = resolve(this.agentLoop.workspace, '.gemini-agent');
      const tmpPath = resolve(tmpDir, 'clipboard-image.png');
      mkdirSync(tmpDir, { recursive: true });

      // Use osascript to write clipboard image to file
      execSync(
        `osascript -e 'set theFile to open for access POSIX file "${tmpPath}" with write permission' -e 'set eof theFile to 0' -e 'write (the clipboard as «class PNGf») to theFile' -e 'close access theFile'`,
        { timeout: 10000 }
      );

      if (existsSync(tmpPath)) {
        let finalFilePath = tmpPath;
        const { statSync } = await import('fs');
        const sizeMB = statSync(tmpPath).size / (1024 * 1024);

        if (sizeMB > 2) {
          console.log(chalk.dim(`Clipboard image is large (${sizeMB.toFixed(1)}MB). Compressing...`));
          execSync(`sips -Z 1600 "${tmpPath}"`, { stdio: 'ignore' });
        }

        const imageBuffer = readFileSync(finalFilePath);
        const base64 = imageBuffer.toString('base64');
        const sizeKB = Math.round(imageBuffer.length / 1024);

        this.pendingImage = { base64, mime: 'image/png', path: 'clipboard', sizeKB };
        console.log(chalk.green(`\n🖼️  Clipboard image attached (${sizeKB}KB)`));
        console.log(chalk.dim('Type your message and the image will be included.\n'));

        // Clean up temp file
        try { unlinkSync(tmpPath); } catch {}
      } else {
        console.log(chalk.red('\n❌ Failed to extract clipboard image.\n'));
      }
    } catch (err) {
      console.log(chalk.red(`\n❌ Clipboard paste failed: ${err.message}\n`));
    }
    this.rl.prompt();
  }
}
