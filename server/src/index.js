#!/usr/bin/env node
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { resolve, dirname } from 'path';
import { existsSync } from 'fs';

/**
 * The bin: runs main.js under tsx, and restarts it when it asks.
 *
 * The sources contain JSX, so `node src/main.js` fails outright — everything
 * goes through tsx.
 *
 * The loop is what makes `/restart` real. It used to work by touching this
 * file's mtime, which does something only under `tsx --watch` (`npm run dev`)
 * and nothing at all under `agent-cli` — where it still reported success. A
 * coding agent that edits its own source needs to reload it, so the child asks
 * by exiting with RESTART_EXIT_CODE and this relaunches it. Any other status is
 * a real exit and passes straight through.
 */
export const RESTART_EXIT_CODE = 75;

const __dirname = dirname(fileURLToPath(import.meta.url));
const mainJs = resolve(__dirname, 'main.js');

let tsxPath = resolve(__dirname, '../node_modules/.bin/tsx');
if (!existsSync(tsxPath)) {
  tsxPath = resolve(__dirname, '../../node_modules/.bin/tsx');
}

if (!existsSync(tsxPath)) {
  console.error("❌ 'tsx' not found. Please run 'npm install' in the workspace root or server directory.");
  process.exit(1);
}

// A restart re-reads the agent's own code, so a run that keeps asking for one
// is a boot loop, not a feature. Bounded, and it says so before it stops.
const MAX_RESTARTS = 20;

for (let restarts = 0; ; restarts++) {
  const result = spawnSync(tsxPath, [mainJs, ...process.argv.slice(2)], {
    stdio: 'inherit',
    // How the child knows a supervisor is listening. Without it, /restart has
    // nothing to exit into and says so rather than quitting on the user.
    env: { ...process.env, AGENT_CLI_SUPERVISED: '1' },
  });

  if (result.status !== RESTART_EXIT_CODE) {
    process.exit(result.status ?? 0);
  }
  if (restarts >= MAX_RESTARTS) {
    console.error(`❌ Restarted ${MAX_RESTARTS} times without settling. Stopping.`);
    process.exit(1);
  }
  console.log('🔄 Restarting…');
}
