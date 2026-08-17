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

      this.spinner.text = 'Thinking...';
      this.spinner.color = 'cyan';
      this.spinner.start();
      
      await this.agentLoop.handleUserMessage(input, this.callbacks);
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
  /plan      - Switch to Plan Mode (Safe). All edits require approval.
  /auto      - Switch to Auto Mode (Fast). Safe edits auto-applied.
  /clear     - Clear the local conversation history.
  /context   - Show current context usage and diff stats.
  /compact   - Ask Gemini to summarize history and start a new chat.
  /undo      - Undo the last applied file change.
  /workspace - Show or change the current workspace directory.
  /model     - Instructions on how to change the Gemini model.
  /exit      - Exit the Gemini Agent server.
  /help      - Show this help menu.
`);
      this.rl.prompt();
      return;
    }

    if (command === 'model') {
      console.log(`\n🤖 To change the model (e.g., from Flash to Pro), simply select the new model from the dropdown menu inside your gemini.google.com browser tab!\n`);
      this.rl.prompt();
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
        } else if (msg.type === 'status') {
          if (msg.payload.message && !msg.payload.message.includes('Thinking')) {
            this.spinner.text = msg.payload.message;
          }
        } else if (msg.type === 'tool_call') {
          this.spinner.text = `Executing ${msg.payload.name}...`;
        } else if (msg.type === 'tool_result') {
          if (!msg.payload.success) {
            this.spinner.stop();
            console.log(chalk.red(`[Error] Tool ${msg.payload.name} failed: ${msg.payload.error}`));
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
}
