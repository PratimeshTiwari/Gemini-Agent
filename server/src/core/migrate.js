/**
 * State Migration
 *
 * Earlier versions scattered workspace state across three directories:
 *
 *   .gemini/              config, memory, plans, walkthroughs, context index
 *   .gemini-agent/        diff backups, editor state, GitHub watermarks
 *   .agent-github-plans/  GitHub PR plans
 *
 * plus loose files at the workspace root (setAgentName.json, agent.log). All of
 * that now lives under a single `.agent/` directory — see ./paths.js.
 *
 * This runs once, on startup, and only when `.agent/` does not yet exist and at
 * least one legacy location does. It MOVES rather than copies, so a second run
 * finds nothing to do. Anything it cannot move is reported and skipped: a failed
 * migration must never stop the agent from starting.
 */

import fs from 'fs';
import path from 'path';
import * as paths from './paths.js';

/** Move a file or directory, creating the destination's parent. Returns true if moved. */
function move(from, to) {
  if (!fs.existsSync(from)) return false;
  if (fs.existsSync(to)) return false; // never clobber already-migrated state
  paths.ensureParent(to);
  try {
    fs.renameSync(from, to);
  } catch (err) {
    // EXDEV: different filesystems — fall back to copy + remove
    if (err.code !== 'EXDEV') throw err;
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
  return true;
}

/**
 * Fold the standalone setAgentName.json into .agent/config.json, and drop the
 * useLocalLlm flag left behind by the removed local-LLM feature.
 */
function foldConfig(workspace, moved) {
  const configFile = paths.configPath(workspace);
  const legacyName = path.join(workspace, 'setAgentName.json');

  let config = {};
  if (fs.existsSync(configFile)) {
    try {
      config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    } catch {
      return; // unreadable config: leave it alone rather than overwrite
    }
  }

  let changed = false;

  if (fs.existsSync(legacyName)) {
    try {
      const { agentName } = JSON.parse(fs.readFileSync(legacyName, 'utf8'));
      if (agentName && !config.agentName) {
        config.agentName = agentName;
        changed = true;
      }
      fs.rmSync(legacyName);
      moved.push('setAgentName.json → .agent/config.json (agentName)');
    } catch {
      /* leave the file in place if it cannot be read */
    }
  }

  if (config.modelConfig && 'useLocalLlm' in config.modelConfig) {
    delete config.modelConfig.useLocalLlm;
    changed = true;
  }

  if (changed) {
    paths.ensureParent(configFile);
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  }
}

/**
 * Migrate a workspace to the .agent/ layout if it has not been migrated yet.
 *
 * @param {string} workspace - Workspace root
 * @returns {{ migrated: boolean, items: string[] }}
 */
export function migrateWorkspace(workspace) {
  const target = paths.agentDir(workspace);
  const legacyPresent = paths.LEGACY_DIRS.some((d) => fs.existsSync(path.join(workspace, d)));

  if (fs.existsSync(target) || !legacyPresent) {
    return { migrated: false, items: [] };
  }

  const w = (...p) => path.join(workspace, ...p);
  const plan = [
    // .gemini/ — config, memory, context, approval
    [w('.gemini', 'config.json'), paths.configPath(workspace)],
    [w('.gemini', 'memory.json'), paths.memoryPath(workspace)],
    [w('.gemini', 'rules.md'), paths.rulesPath(workspace)],
    [w('.gemini', 'agent_mistakes.md'), paths.mistakesPath(workspace)],
    [w('.gemini', 'context'), paths.contextDir(workspace)],
    [w('.gemini', 'plan_approval.json'), paths.planApprovalPath(workspace)],
    // human-facing artifacts, from both the old .gemini/ and the workspace root
    [w('.gemini', 'implementation_plan.md'), paths.artifactPath(workspace, 'implementation_plan.md')],
    [w('.gemini', 'plan.md'), paths.artifactPath(workspace, 'plan.md')],
    [w('.gemini', 'walkthrough.md'), paths.artifactPath(workspace, 'walkthrough.md')],
    [w('.gemini', 'task.md'), paths.artifactPath(workspace, 'task.md')],
    [w('walkthrough.md'), paths.artifactPath(workspace, 'walkthrough.md')],
    [w('task.md'), paths.artifactPath(workspace, 'task.md')],
    // .gemini-agent/ — machine state
    [w('.gemini-agent', 'editor_state.json'), paths.editorStatePath(workspace)],
    [w('.gemini-agent', 'github-state.json'), paths.githubStatePath(workspace)],
    [w('.gemini-agent', 'backups'), paths.backupsDir(workspace)],
    // GitHub PR plans
    [w('.agent-github-plans'), paths.plansDir(workspace)],
    // loose log at the workspace root
    [w('agent.log'), paths.logPath(workspace)],
  ];

  const items = [];
  for (const [from, to] of plan) {
    try {
      if (move(from, to)) items.push(`${path.relative(workspace, from)} → ${path.relative(workspace, to)}`);
    } catch (err) {
      console.warn(`⚠️  Could not migrate ${path.relative(workspace, from)}: ${err.message}`);
    }
  }

  try {
    foldConfig(workspace, items);
  } catch (err) {
    console.warn(`⚠️  Could not fold config during migration: ${err.message}`);
  }

  // Remove the legacy directories only if migration emptied them.
  for (const dir of paths.LEGACY_DIRS) {
    const abs = w(dir);
    try {
      if (fs.existsSync(abs) && fs.readdirSync(abs).length === 0) fs.rmdirSync(abs);
    } catch {
      /* leftovers are harmless — the user can delete them */
    }
  }

  return { migrated: items.length > 0, items };
}

/**
 * Migrate the home directory.
 *
 * Two legacy shapes are handled:
 *   ~/.gemini-agent/        the whole previous home directory  -> ~/.agent/
 *   ~/.gemini/context/      an even older global context index -> ~/.agent/legacy-context/
 *
 * Sessions used to live in one shared folder as session_<md5>.jsonl. Each
 * workspace claims its own hashed file the next time it runs, moving it into
 * that workspace's folder. Files belonging to other projects are left in place
 * for those projects to claim.
 *
 * Everything else in ~/.gemini belongs to Google's Gemini CLI and is untouched.
 *
 * @param {string} workspace - the workspace being opened right now
 */
export function migrateHome(workspace) {
  const items = [];

  try {
    // 1. Old home directory -> new one. Move it wholesale when the new one does
    //    not exist yet; otherwise merge its contents in, entry by entry, so an
    //    already-created ~/.agent does not strand the old data.
    const oldHomeDir = paths.legacyHomeDir();
    if (fs.existsSync(oldHomeDir)) {
      if (move(oldHomeDir, paths.homeDir())) {
        items.push('~/.gemini-agent → ~/.agent');
      } else {
        for (const entry of fs.readdirSync(oldHomeDir)) {
          if (move(path.join(oldHomeDir, entry), path.join(paths.homeDir(), entry))) {
            items.push(`~/.gemini-agent/${entry} → ~/.agent/${entry}`);
          }
        }
      }
    }

    // 2. This workspace's hashed session file -> its own folder.
    //    Look in both the new home and the old one: an older build still running
    //    can recreate ~/.gemini-agent/sessions/ after step 1 has already moved it.
    const name = paths.legacySessionName(workspace);
    const searchDirs = [paths.legacySessionsDir(), path.join(paths.legacyHomeDir(), 'sessions')];
    for (const dir of searchDirs) {
      if (move(path.join(dir, name), paths.homeSessionPath(workspace))) {
        items.push(`sessions/${name} → workspaces/${paths.workspaceSlug(workspace)}/history.jsonl`);
        break;
      }
    }

    // Drop shared sessions folders once every project has claimed its file.
    for (const dir of searchDirs) {
      if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    }
    const oldHome = paths.legacyHomeDir();
    if (fs.existsSync(oldHome) && fs.readdirSync(oldHome).length === 0) fs.rmdirSync(oldHome);

    // 3. Pre-.gemini-agent global context index
    const olderContext = path.join(process.env.HOME || '', '.gemini', 'context');
    if (move(olderContext, path.join(paths.homeDir(), 'legacy-context'))) {
      items.push('~/.gemini/context → ~/.agent/legacy-context');
    }
  } catch (err) {
    console.warn(`⚠️  Could not migrate home directory: ${err.message}`);
  }

  return items;
}

/** Run both migrations and print a single summary line. */
export function runMigrations(workspace) {
  const { migrated, items } = migrateWorkspace(workspace);
  const homeItems = migrateHome(workspace);
  const all = [...items, ...homeItems];

  if (all.length > 0) {
    console.log(
      `📦 Migrated ${all.length} item${all.length === 1 ? '' : 's'} into ${paths.AGENT_DIR}/ ` +
        `(was .gemini, .gemini-agent, .agent-github-plans)`,
    );
  }

  return migrated || homeItems.length > 0;
}
