#!/usr/bin/env node

/**
 * Gemini Agent — Local Agent Server
 *
 * Entry point: starts the WebSocket server, initializes MCP tools,
 * and connects the agent loop.
 *
 * Usage:
 *   gemini-agent                    # Uses cwd as workspace root
 *   gemini-agent --workspace /path  # Explicit workspace root
 *   gemini-agent --port 7777        # Custom port (default: 7777)
 *   gemini-agent --continue         # Resume most recent session
 *   gemini-agent --sessions         # List past sessions
 */

import { resolve, dirname } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { WebSocketServer } from './websocket-server.js';
import { GitHubEventHandler } from './github/GitHubEventHandler.js';
import { MCPServer } from './mcp/mcp-server.js';
import { AgentLoop } from './agent-loop.js';
import { PromptBuilder } from './prompt-builder.js';
import { DiffEngine } from './diff-engine.js';
import { RiskClassifier } from './risk-classifier.js';
import { FileWatcher } from './watcher/FileWatcher.js';
import { TaskManager } from './TaskManager.js';

// ── Parse CLI Arguments ──────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    workspace: process.cwd(),
    port: 7777,
    continue: false,
    sessions: false,
    sessionId: null,
    editor: process.env.EDITOR || 'code',
    github: true,
    ciWatch: true,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--workspace':
      case '-w':
        config.workspace = resolve(args[++i]);
        break;
      case '--port':
      case '-p':
        config.port = parseInt(args[++i], 10);
        break;
      case '--continue':
      case '-c':
        config.continue = true;
        break;
      case '--sessions':
        config.sessions = true;
        break;
      case '--resume':
        config.sessionId = args[++i];
        break;
      case '--editor':
        config.editor = args[++i];
        break;
      case '--no-github':
        config.github = false;
        break;
      case '--no-ci-watch':
        config.ciWatch = false;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
    }
  }

  return config;
}

function printHelp() {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║               🤖 Gemini Agent Server                    ║
╚══════════════════════════════════════════════════════════╝

Usage: gemini-agent [options]

Options:
  --workspace, -w <path>   Set workspace root (default: cwd)
  --port, -p <number>      WebSocket port (default: 7777)
  --continue, -c           Resume most recent session
  --resume <session-id>    Resume a specific session
  --sessions               List past sessions
  --editor <command>       Editor command (default: $EDITOR or 'code')
  --no-github              Disable GitHub PR comment watching
  --no-ci-watch            Disable CI failure watching (comments only)
  --help, -h               Show this help message

Environment:
  EDITOR                   Default editor command (fallback: 'code')
  GEMINI_AGENT_HOME        Config directory (default: ~/.gemini-agent)
  GITHUB_TOKEN             GitHub PAT for PR comment watching (required for --github)
`);
}

// ── Ensure Config Directory ──────────────────────────────────────────
function ensureConfigDir() {
  const home = process.env.GEMINI_AGENT_HOME || resolve(process.env.HOME, '.gemini-agent');
  const dirs = [
    home,
    resolve(home, 'sessions'),
    resolve(home, 'backups'),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
  return home;
}

// ── Main ─────────────────────────────────────────────────────────────
async function main() {
  const config = parseArgs();
  const configHome = ensureConfigDir();
  
  // Verify workspace exists
  if (!existsSync(config.workspace)) {
    console.error(`❌ Workspace directory not found: ${config.workspace}`);
    process.exit(1);
  }

  // Determine agent source directory (the 'server' folder)
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const agentSourceDir = resolve(__dirname, '../');

  // Initialize components
  const diffEngine = new DiffEngine(config.workspace);
  const riskClassifier = new RiskClassifier(config.workspace);
  const promptBuilder = new PromptBuilder(config.workspace, agentSourceDir);
  const mcpServer = new MCPServer(config.workspace, diffEngine);

  const taskManager = new TaskManager(config.workspace);
  
  // Initialize WorkspaceIndexer for Background RAG
  const { WorkspaceIndexer } = await import('./context/WorkspaceIndexer.js');
  const workspaceIndexer = new WorkspaceIndexer(config.workspace);
  // Start building the index asynchronously in the background
  workspaceIndexer.buildIndex();


  const agentLoop = new AgentLoop({
    workspace: config.workspace,
    mcpServer,
    promptBuilder,
    diffEngine,
    riskClassifier,
    editor: config.editor,
    configHome,
    continueSession: config.continue,
    agentSourceDir,
    taskManager,
    workspaceIndexer,
  });

  const fileWatcher = new FileWatcher(config.workspace, agentLoop);
  fileWatcher.start();

  // ── GitHub PR Comment Agent ──────────────────────────────────────
  let githubHandler = null;
  const githubToken = agentLoop.modelConfig?.githubToken || process.env.GITHUB_TOKEN;

  if (config.github && githubToken) {
    githubHandler = new GitHubEventHandler({
      token: githubToken,
      workspace: config.workspace,
      configOverrides: {
        enableCIWatch: config.ciWatch,
      },
      agentLoop,
    });

    // Wire GitHub events to console output (errors only, status is handled by UI)
    githubHandler.on('status', ({ message }) => {
      // console.log(`  [GitHub] ${message}`);
    });
    githubHandler.on('error', ({ message }) => {
      console.error(`  [GitHub] ❌ ${message}`);
    });
    githubHandler.on('notification', ({ message }) => {
      console.log(`  [GitHub] ${message}`);
    });

    // Connect to agent loop for /github slash commands
    agentLoop.githubHandler = githubHandler;

    // Start watching
    try {
      await githubHandler.start();
    } catch (err) {
      console.error(`  [GitHub] ❌ Failed to start: ${err.message}`);
    }
  } else if (config.github && !githubToken) {
    console.log('  ℹ️  Set GITHUB_TOKEN env var to enable PR comment watching');
  }

  const wsServer = new WebSocketServer({
    port: config.port,
    agentLoop,
    githubHandler,
  });

  // Start listening
  try {
    await wsServer.start();
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      const { confirm } = await import('@inquirer/prompts');
      const { execSync } = await import('child_process');
      const shouldKill = await confirm({
        message: `Port ${config.port} is already in use by another process. Do you want to kill it?`
      });
      if (shouldKill) {
        try {
          execSync(`lsof -t -i:${config.port} | xargs kill -9`);
          console.log(`  ✅ Killed existing process on port ${config.port}. Restarting server...`);
          await new Promise(r => setTimeout(r, 500)); // wait a bit for port to free up
          await wsServer.start();
        } catch (killErr) {
          console.error(`  ❌ Failed to kill process: ${killErr.message}`);
          process.exit(1);
        }
      } else {
        console.log('  ❌ Exiting.');
        process.exit(1);
      }
    } else {
      throw err;
    }
  }

  // Start CLI UI
  const { CliUI } = await import('./cli-ui.jsx');
  const cli = new CliUI(agentLoop, wsServer);
  cli.start();

  // Automatically open Gemini Web in the default browser to wake up the extension
  try {
    const { exec } = await import('child_process');
    const startUrl = 'https://gemini.google.com/app';

    if (process.platform === 'darwin') {
      exec(`open ${startUrl}`);
    } else if (process.platform === 'win32') {
      exec(`start ${startUrl}`);
    } else {
      exec(`xdg-open ${startUrl}`);
    }
  } catch (err) {
    console.error('Failed to open browser automatically:', err);
  }

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n🛑 Shutting down...');
    if (githubHandler) githubHandler.stop();
    fileWatcher.stop();
    taskManager.cleanup();
    await wsServer.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('💥 Fatal initialization error:', err.message);
  console.error('Recovering gracefully... please check your configuration and restart.');
  process.exit(1);
});
