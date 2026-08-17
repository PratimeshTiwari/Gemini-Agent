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
import { MCPServer } from './mcp/mcp-server.js';
import { AgentLoop } from './agent-loop.js';
import { PromptBuilder } from './prompt-builder.js';
import { DiffEngine } from './diff-engine.js';
import { RiskClassifier } from './risk-classifier.js';
import { FileWatcher } from './watcher/FileWatcher.js';

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
  --help, -h               Show this help message

Environment:
  EDITOR                   Default editor command (fallback: 'code')
  GEMINI_AGENT_HOME        Config directory (default: ~/.gemini-agent)
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

  console.log(`
╔══════════════════════════════════════════════════════════╗
║               🤖 Gemini Agent Server                    ║
╚══════════════════════════════════════════════════════════╝
  Workspace:  ${config.workspace}
  Port:       ${config.port}
  Editor:     ${config.editor}
  Config:     ${configHome}
`);

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
  const riskClassifier = new RiskClassifier();
  const promptBuilder = new PromptBuilder(config.workspace, agentSourceDir);
  const mcpServer = new MCPServer(config.workspace, diffEngine);

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
  });

  const fileWatcher = new FileWatcher(config.workspace, agentLoop);
  fileWatcher.start();

  const wsServer = new WebSocketServer({
    port: config.port,
    agentLoop,
  });

  // Start listening
  await wsServer.start();

  console.log(`  ✅ WebSocket server listening on ws://localhost:${config.port}`);
  console.log(`  ⏳ Waiting for Chrome Extension connection...\n`);

  // Start CLI UI
  const { CliUI } = await import('./cli-ui.js');
  const cli = new CliUI(agentLoop, wsServer);
  cli.start();

  // Automatically open Gemini Web in the default browser to wake up the extension
  try {
    const { exec } = await import('child_process');
    const startUrl = 'https://gemini.google.com/app';
    console.log(`\n🌐 Opening ${startUrl} in your browser...`);
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
    fileWatcher.stop();
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
