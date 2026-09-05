/**
 * Agent Paths
 *
 * The single source of truth for where the agent keeps its files.
 *
 * Everything the agent writes into a workspace lives under one directory,
 * `.agent/`. Nothing else in the codebase should hardcode that name — import
 * from here instead, so the layout can never drift apart again.
 *
 * Machine state is hidden inside `.agent/`; documents the *user* is meant to
 * read and approve (task lists, plans, walkthroughs) live in `.agent/artifacts/`.
 *
 * Home-scoped state (sessions, cross-repo context) lives in `~/.gemini-agent/`,
 * overridable with GEMINI_AGENT_HOME. Note this is deliberately NOT `~/.gemini`,
 * which belongs to Google's Gemini CLI.
 */

import path from 'path';
import os from 'os';
import { existsSync, mkdirSync } from 'fs';
import crypto from 'crypto';

/** Name of the per-workspace agent directory. */
export const AGENT_DIR = '.agent';

/** Directories used by pre-.agent versions, kept for one-time migration. */
export const LEGACY_DIRS = ['.gemini', '.gemini-agent', '.agent-github-plans'];

// ── Workspace-scoped ─────────────────────────────────────────────────

export const agentDir = (workspace) => path.join(workspace, AGENT_DIR);

export const configPath = (workspace) => path.join(agentDir(workspace), 'config.json');
export const memoryPath = (workspace) => path.join(agentDir(workspace), 'memory.json');

/** Documents written for the user to read: task.md, plan.md, walkthrough.md. */
export const artifactsDir = (workspace) => path.join(agentDir(workspace), 'artifacts');
export const artifactPath = (workspace, name) => path.join(artifactsDir(workspace), name);

/** Machine state: editor.json, github.json, plan-approval.json. */
export const stateDir = (workspace) => path.join(agentDir(workspace), 'state');
export const statePath = (workspace, name) => path.join(stateDir(workspace), name);
export const editorStatePath = (workspace) => statePath(workspace, 'editor.json');
export const githubStatePath = (workspace) => statePath(workspace, 'github.json');
export const planApprovalPath = (workspace) => statePath(workspace, 'plan-approval.json');

export const backupsDir = (workspace) => path.join(agentDir(workspace), 'backups');
export const contextDir = (workspace) => path.join(agentDir(workspace), 'context');
export const contextSummaryPath = (workspace) => path.join(contextDir(workspace), 'summary.md');
export const plansDir = (workspace) => path.join(agentDir(workspace), 'github-pr-plans');
export const logsDir = (workspace) => path.join(agentDir(workspace), 'logs');
export const sessionsDirLocal = (workspace) => path.join(agentDir(workspace), 'sessions');
/** Session history kept alongside the project. */
export const localSessionPath = (workspace) => path.join(sessionsDirLocal(workspace), 'history.jsonl');
export const tmpDir = (workspace) => path.join(agentDir(workspace), 'tmp');
export const rulesPath = (workspace) => path.join(agentDir(workspace), 'rules.md');
export const mistakesPath = (workspace) => path.join(agentDir(workspace), 'mistakes.md');
export const logPath = (workspace) => path.join(logsDir(workspace), 'agent.log');

// ── Workspace-relative (for configs and prompts that need a relative name) ──

export const REL_PLANS_DIR = `${AGENT_DIR}/github-pr-plans`;
export const REL_GITHUB_STATE = `${AGENT_DIR}/state/github.json`;
export const REL_ARTIFACTS_DIR = `${AGENT_DIR}/artifacts`;

// ── Home-scoped ──────────────────────────────────────────────────────

export const homeDir = () =>
  process.env.GEMINI_AGENT_HOME || process.env.AGENT_HOME || path.join(os.homedir(), AGENT_DIR);

/** The pre-.agent home directory, kept so migration can find it. */
export const legacyHomeDir = () => path.join(os.homedir(), '.gemini-agent');

/**
 * A stable, readable folder name for a workspace: its directory name plus a
 * short hash of the absolute path, so two projects called "app" never collide.
 */
export const workspaceSlug = (workspace) => {
  const hash = crypto.createHash('md5').update(workspace).digest('hex').slice(0, 8);
  return `${path.basename(workspace)}-${hash}`;
};

/** Legacy session filename, hashed into one shared folder. Migration reads these. */
export const legacySessionName = (workspace) =>
  `session_${crypto.createHash('md5').update(workspace).digest('hex').slice(0, 10)}.jsonl`;

/** Per-workspace folder under the home directory. Survives losing the workspace. */
export const workspaceHomeDir = (workspace) =>
  path.join(homeDir(), 'workspaces', workspaceSlug(workspace));

/** Durable copy of the session history, outside the project. */
export const homeSessionPath = (workspace) =>
  path.join(workspaceHomeDir(workspace), 'history.jsonl');

/** Shared home folder the legacy hashed session files were kept in. */
export const legacySessionsDir = () => path.join(homeDir(), 'sessions');

export const globalContextPath = (workspace) =>
  path.join(workspaceHomeDir(workspace), 'context', 'summary.md');

// ── Helpers ──────────────────────────────────────────────────────────

/** Create a directory if missing. Returns the path so it can be used inline. */
export function ensureDir(dir) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/** Create the parent directory of a file path, then return the file path. */
export function ensureParent(filePath) {
  ensureDir(path.dirname(filePath));
  return filePath;
}
