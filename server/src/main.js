#!/usr/bin/env node

/**
 * Agent CLI — Local Agent Server
 *
 * Entry point: starts the WebSocket server, initializes MCP tools,
 * and connects the agent loop.
 *
 * Usage (installed as both `agent` and `agent-cli`):
 *   agent                    # Uses cwd as workspace root
 *   agent --workspace /path  # Explicit workspace root
 *   agent --port 7777        # Custom port (default: 7777)
 *   agent --continue         # Resume most recent session
 *   agent --sessions         # List past sessions
 */

import { resolve, dirname } from 'path';
import { homeDir, ensureDir, setActiveScope, resolveState, codeDir } from './core/paths.js';
import { runMigrations } from './core/migrate.js';
import { hostEditor } from './core/host-editor.js';
import { rememberWorkspace } from './core/workspaces.js';
import { existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { WebSocketServer } from './bridge/websocket-server.js';
import { MCPServer } from './mcp/mcp-server.js';
import { AgentLoop } from './core/agent-loop.js';
import { PromptBuilder } from './core/prompt-builder.js';
import { DiffEngine } from './core/diff-engine.js';
import { RiskClassifier } from './core/risk-classifier.js';
import { FileWatcher } from './watcher/file-watcher.js';
import { TaskManager } from './core/task-manager.js';
import { logError } from './core/error-log.js';
import { recoverMissingDependency, explainFailure, clearAttempt } from './core/dep-recovery.js';
import { RESTART_EXIT_CODE } from './core/restart.js';

/**
 * This file's own directory, at module scope.
 *
 * It was declared inside `main()`, which is fine for everything that reads it
 * there and wrong for `main().catch()` — that handler runs outside the
 * function, so a reference to it would throw a ReferenceError *from inside the
 * error handler* and replace the real failure with a confusing one.
 */
const SRC_DIR = dirname(fileURLToPath(import.meta.url));

/** How long to wait for an already-running extension to greet us, at startup. */
const EXTENSION_GREETING_MS = 1500;

// ── Parse CLI Arguments ──────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    workspace: process.cwd(),
    scope: null,
    port: 7777,
    continue: false,
    sessions: false,
    sessionId: null,
    /**
     * `--editor` and `$EDITOR` are explicit choices and win. The fallback used
     * to be a bare `'code'`, which is not installed by any VS Code *fork* — so
     * from a terminal inside one, `/open` fell through to the OS default for
     * the file type and opened a markdown file in RStudio. Asking which editor
     * is hosting this terminal answers that properly; see core/host-editor.js.
     */
    editor: process.env.EDITOR || hostEditor() || 'code',
    ciWatch: true,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--workspace':
      case '-w':
        config.workspace = resolve(args[++i]);
        break;
      case '--scope':
      case '-s':
        config.scope = args[++i];
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
║                  🤖 Agent CLI Server                     ║
╚══════════════════════════════════════════════════════════╝

Usage: agent [options]          (alias: agent-cli)

Options:
  --workspace, -w <path>   Set workspace root (default: cwd)
  --scope, -s <name>       Work on one repo inside a group that shares a .agent/
  --port, -p <number>      WebSocket port (default: 7777)
  --continue, -c           Resume most recent session
  --resume <session-id>    Resume a specific session
  --sessions               List past sessions
  --editor <command>       Editor command (default: $EDITOR or 'code')
  --no-ci-watch            Disable CI failure watching (comments only)
  --help, -h               Show this help message

Environment:
  EDITOR                   Default editor command (fallback: 'code')
  AGENT_CLI_HOME           Agent home directory (default: ~/.agent)
`);
}

// ── Ensure Config Directory ──────────────────────────────────────────
function ensureConfigDir() {
  const home = homeDir();
  for (const dir of [home, resolve(home, 'workspaces')]) {
    ensureDir(dir);
  }
  return home;
}

// ── Main ─────────────────────────────────────────────────────────────
async function main() {
  const config = parseArgs();
  // Fold any pre-.agent state (.gemini, .gemini-agent, .agent-github-plans and
  // the old ~/.gemini-agent home) into .agent/. Must run BEFORE ensureConfigDir,
  // which would otherwise create the home directory the migration wants to fill.
  // Before anything reads a path. The scope decides where .agent state lives,
  // and migration is the first thing to touch it.
  if (config.scope) setActiveScope(config.scope);

  /**
   * A migration that throws must not be the thing that stops the agent.
   *
   * Each one guards its own file operations, but this call was unguarded — so
   * an unexpected filesystem state, or a bug in a *new* migration arriving with
   * a pull, would take startup down before there was any UI to report it. That
   * is the shape of "the update broke it": the failure is in the one code path
   * that runs before anything can say so.
   *
   * Reported and continued. A skipped migration is a layout that stays old,
   * which is recoverable; a dead startup is not.
   */
  try {
    runMigrations(config.workspace);
  } catch (err) {
    console.warn(`⚠️  Migration skipped: ${err.message}`);
  }

  const configHome = ensureConfigDir();
  
  // Verify workspace exists
  if (!existsSync(config.workspace)) {
    console.error(`❌ Workspace directory not found: ${config.workspace}`);
    process.exit(1);
  }

  /**
   * `--sessions`: print the list and go.
   *
   * It has been in `--help` the whole time, parsed into `config`, and read by
   * nothing — the agent simply started as though the flag were absent. An
   * advertised flag that silently does nothing is worse than a missing one,
   * because there is no failure to notice.
   *
   * Before the UI, deliberately: this is a question asked of a shell, and the
   * answer belongs in the terminal's scrollback rather than inside an Ink app
   * that clears it.
   */
  if (config.sessions) {
    const { SessionStore } = await import('./storage/session-store.js');
    const sessions = new SessionStore(config.workspace).listSessions();
    if (sessions.length === 0) {
      console.log('No past sessions here yet.\n');
      console.log('One is filed each time the agent starts without `--continue`.');
    } else {
      console.log(`Past sessions in ${config.workspace}\n`);
      for (const s of sessions) {
        const when = s.updated ? new Date(s.updated).toISOString().slice(0, 16).replace('T', ' ') : '';
        // The thread is what decides whether resuming can carry on or has to
        // re-explain itself, so it is worth showing before the choice is made.
        const memory = s.thread?.id ? 'thread kept' : 'no thread';
        console.log(`  ${s.id}`);
        console.log(`    ${s.title}`);
        console.log(`    ${String(s.turns).padStart(3)} turns · ${when} · ${memory}\n`);
      }
      console.log('Resume one with:  agent --resume <id>');
    }
    process.exit(0);
  }

  /**
   * Record where we are, so `/set-workspace` can offer it next time.
   *
   * `listWorkspaceCandidates` has always had a `recent` category and
   * `readRecents()` has always read the file — and **nothing ever wrote it**,
   * so that half of the picker silently offered nothing. The reader, the
   * writer and the picker row all existed; the call did not. Found by auditing
   * exports with no callers.
   *
   * After the existence check, so a path that does not resolve is not offered
   * back to you as somewhere you have been.
   */
  rememberWorkspace(config.workspace);

  // Determine agent source directory (the 'server' folder)
  const agentSourceDir = resolve(SRC_DIR, '../');

  // Initialize components
  const diffEngine = new DiffEngine(config.workspace);
  const riskClassifier = new RiskClassifier(config.workspace);
  const promptBuilder = new PromptBuilder(config.workspace, agentSourceDir);
  const mcpServer = new MCPServer(config.workspace, diffEngine);

  const taskManager = new TaskManager(config.workspace);
  
  // Start building the index asynchronously in the background


  const agentLoop = new AgentLoop({
    workspace: config.workspace,
    mcpServer,
    promptBuilder,
    diffEngine,
    riskClassifier,
    editor: config.editor,
    configHome,
    continueSession: config.continue,
    resumeSessionId: config.sessionId,
    agentSourceDir,
    taskManager,
  });

  const fileWatcher = new FileWatcher(codeDir(config.workspace), agentLoop);
  fileWatcher.start();

  const wsServer = new WebSocketServer({
    port: config.port,
    agentLoop,
  });

  // Start listening
  try {
    await wsServer.start();
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      /**
       * One yes/no, on an error path, from the standard library.
       *
       * This was `@inquirer/prompts` — sixteen packages for a single confirm
       * that fires only when the port is taken. `readline/promises` is built
       * in and does the same job in six lines.
       *
       * The default is unchanged: a bare Enter still means yes, which is what
       * `confirm()` did with no `default` set. Worth revisiting on its own —
       * Enter meaning "kill -9 that process" is a generous default — but that
       * is a behaviour change and this is a dependency removal.
       */
      const { createInterface } = await import('node:readline/promises');
      const { execSync } = await import('child_process');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question(
        `Port ${config.port} is already in use by another process. Do you want to kill it? (Y/n) `,
      );
      rl.close();
      const shouldKill = !/^n(o)?$/i.test(answer.trim());
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
  const { CliUI } = await import('./ui/cli-ui.jsx');
  const cli = new CliUI(agentLoop, wsServer);
  cli.start();

  /**
   * Far enough to matter.
   *
   * Every import in the startup graph has resolved by the time there is a UI,
   * so whatever an automatic `npm install` was recorded against is settled. It
   * is cleared here rather than left, so the next genuine missing dependency
   * gets its own attempt instead of inheriting this one's — the marker is a
   * "once per occurrence" bound, not a "once ever" one.
   */
  clearAttempt();

  /**
   * Give the extension a moment to announce itself, and open a tab only if it
   * does not.
   *
   * This used to open `gemini.google.com/app` unconditionally on every start,
   * *then* wait — so a session that began with Chrome open, the extension
   * connected and a Gemini tab already in front of you still got another tab.
   * Five runs in a day was five tabs, and the information needed to avoid it was
   * already here: the bridge knows whether an extension has identified.
   *
   * **It runs after first paint, and must stay there.** It used to be awaited
   * before the UI was created, which put its full 1.5s on the path to the first
   * frame: measured under a pty with no extension listening, the prompt box
   * appeared at 2.07s, of which this was 1.5s — the single largest cost in
   * startup, larger than every import in the process put together. Nothing the
   * UI draws depends on the answer, so nothing about the UI should wait for it.
   * The wait is still a wait; it is just no longer the user's.
   *
   * The wait stays short because a suspended worker will not make it in any
   * case — and that is fine, because opening the tab is what wakes that one up.
   * That is the case the tab exists for.
   */
  const hasExt = () => wsServer.clients
    && Array.from(wsServer.clients.values()).some((c) => c.type === 'extension');

  const greetExtension = async () => {
    if (!hasExt()) {
      await new Promise((resolve) => {
        const timeout = setTimeout(resolve, EXTENSION_GREETING_MS);
        const interval = setInterval(() => {
          if (hasExt()) {
            clearInterval(interval);
            clearTimeout(timeout);
            resolve();
          }
        }, 50);
      });
    }

    if (hasExt()) return;

    // Never console.error here: the Ink UI owns the terminal by now, and a
    // write into its frame is destroyed by the next repaint anyway.
    const startUrl = 'https://gemini.google.com/app';
    try {
      const { exec } = await import('child_process');

      if (process.platform === 'darwin') {
        exec(`open "${startUrl}"`);
      } else if (process.platform === 'win32') {
        exec(`start "" "${startUrl}"`);
      } else {
        exec(`xdg-open "${startUrl}"`);
      }
    } catch (err) {
      logError(config.workspace, {
        flow: 'bridge',
        op: 'open_start_tab',
        message: `Could not open ${startUrl}: ${err.message}`,
      });
    }
  };

  // Floating on purpose, and caught: an unhandled rejection here would take
  // down a process that has already painted a working UI.
  greetExtension().catch((err) => {
    logError(config.workspace, {
      flow: 'bridge',
      op: 'greet_extension',
      message: `Extension greeting failed: ${err.message}`,
    });
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n🛑 Shutting down...');
    fileWatcher.stop();
    taskManager.cleanup();
    await wsServer.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * The last word, and the one place a startup failure can still be repaired.
 *
 * A dependency the code imports and the tree does not have is the one fatal
 * error whose fix is always the same command, so it is the one worth doing
 * rather than describing. Everything else prints and exits, as before.
 *
 * **This catches what `main()` rejects with**, which covers every dynamically
 * imported module — `ui/cli-ui.jsx`, and through it `App.jsx`, the file the
 * report came from. A package missing from main.js's *static* imports fails
 * before this function is ever reached; see `core/dep-recovery.js`.
 */
main().catch(async (err) => {
  let said = false;
  const outcome = await recoverMissingDependency(err, {
    from: SRC_DIR,
    // Said before npm starts talking, not after: its output streams straight
    // to this terminal, so anything printed afterwards lands under a dozen
    // lines of install log and the reason arrives after the noise.
    announce: ({ package: pkg, root }) => {
      said = true;
      console.error(`💥 ${String(err.message).split('\n')[0]}`);
      console.log(`→ \`${pkg}\` is missing. Installing dependencies in ${root}…`);
    },
  });

  if (outcome.ok) {
    console.log('✔ Dependencies installed.');
    // 75 only means anything to a supervisor. Without one it is a number
    // nobody reads, so say the thing the user has to do instead.
    if (process.env.AGENT_CLI_SUPERVISED) {
      console.log('⟳ Restarting…');
      process.exit(RESTART_EXIT_CODE);
    }
    console.log('Start the agent again to run it.');
    process.exit(1);
  }

  // Not repeated when the attempt was announced — an install that failed has
  // already printed the error once, above its own npm log.
  if (!said) console.error('💥 Fatal initialization error:', err.message);
  const why = explainFailure(outcome);
  if (why) console.error(why);
  process.exit(1);
});
