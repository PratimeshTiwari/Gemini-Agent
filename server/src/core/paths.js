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
 * Home-scoped state (sessions, cross-repo context) lives in `~/.agent/`,
 * overridable with AGENT_CLI_HOME. Note this is deliberately NOT `~/.gemini`,
 * which belongs to Google's Gemini CLI.
 *
 * ## Where `.agent/` actually goes
 *
 * `workspace` used to mean two things at once — where state lives, and what the
 * agent is working on. In a monorepo those come apart:
 *
 *     /base-repo/.agent/            one state root for the whole group
 *     /base-repo/.agent/repo-1/     everything specific to repo-1
 *     /base-repo/repo-1/            the code itself, with no .agent of its own
 *
 * So resolution walks *up* from the workspace looking for an existing
 * `.agent/`, the way git finds `.git`. The first one found is the **root**, and
 * the path from it down to the workspace is the **scope**. Nothing is found —
 * the ordinary single-repo case — and the root is `<workspace>/.agent` with an
 * empty scope, which is exactly the old behaviour.
 *
 * The useful consequence: opening `/base-repo` and opening `/base-repo/repo-1` land
 * on the same state, because both walks end at the same root.
 */

import path from 'path';
import os from 'os';
import { existsSync, mkdirSync } from 'fs';
import crypto from 'crypto';

/** Name of the per-workspace agent directory. */
export const AGENT_DIR = '.agent';

/** Directories used by pre-.agent versions, kept for one-time migration. */
export const LEGACY_DIRS = ['.gemini', '.gemini-agent', '.agent-github-plans'];

// ── Resolving the state root ─────────────────────────────────────────

/** How far up to walk before giving up. A sane tree is nowhere near this deep. */
const MAX_WALK = 64;

/**
 * Directories that must never be mistaken for a project's state root.
 *
 * `~/.agent` is the *home* directory — sessions and cross-repo context for
 * every project on the machine. A naive upward walk from anything under $HOME
 * finds it and would quietly adopt it as the root, putting every project's
 * state in one place and every project's rules in everyone else's prompt.
 */
function forbiddenRoots() {
  return new Set([homeDir(), path.join(os.homedir(), AGENT_DIR)]);
}

// resolveState hits the filesystem, and the path helpers call it constantly.
const resolveCache = new Map();

/** Forget cached resolutions. Call after the workspace changes. */
export function clearPathCache() {
  resolveCache.clear();
}

/**
 * Find the state root for a workspace, and the scope within it.
 *
 * @param {string} workspace
 * @returns {{ root: string, base: string, scope: string, discovered: boolean }}
 *   `root` is the `.agent` directory; `base` is the directory containing it;
 *   `scope` is the workspace's path relative to `base` (empty at the top);
 *   `discovered` is false when nothing was found and the root is the default.
 */
export function resolveState(workspace) {
  const ws = path.resolve(workspace || process.cwd());
  const cached = resolveCache.get(ws);
  if (cached) return cached;

  const forbidden = forbiddenRoots();
  const home = os.homedir();
  let answer = null;
  let dir = ws;

  for (let i = 0; i < MAX_WALK; i++) {
    const candidate = path.join(dir, AGENT_DIR);
    if (!forbidden.has(candidate) && existsSync(candidate)) {
      answer = { root: candidate, base: dir, scope: path.relative(dir, ws), discovered: true };
      break;
    }
    // Stop at $HOME. Above it lies ~/.agent's neighbourhood and then the
    // filesystem root, and adopting anything up there would capture every
    // project on the machine.
    const parent = path.dirname(dir);
    if (parent === dir || dir === home) break;
    dir = parent;
  }

  if (!answer) {
    answer = { root: path.join(ws, AGENT_DIR), base: ws, scope: '', discovered: false };
  }
  resolveCache.set(ws, answer);
  return answer;
}

/**
 * The active scope, when the user has chosen one explicitly.
 *
 * Opening `/base-repo` and asking the agent to work on repo-1 cannot be inferred
 * from the workspace — the workspace is the group. `--scope` and `/scope` set
 * this; it overrides whatever the walk derived.
 */
let scopeOverride = null;

export function setActiveScope(scope) {
  scopeOverride = scope ? String(scope).replace(/^[./]+|\/+$/g, '') : null;
  clearPathCache();
  return scopeOverride;
}

export function getActiveScope(workspace) {
  return scopeOverride ?? resolveState(workspace).scope;
}

// ── Workspace-scoped ─────────────────────────────────────────────────

/**
 * The directory for *this* project's state — `<root>/<scope>`, or the root
 * itself when there is no scope. This is what almost every helper builds on.
 */
export const agentDir = (workspace) => {
  const { root } = resolveState(workspace);
  const scope = getActiveScope(workspace);
  return scope ? path.join(root, scope) : root;
};

/**
 * The root, shared by every scope under it: house rules, skills, the
 * config every repo inherits. Identical to `agentDir` when there is no scope,
 * which is why single-repo workspaces see no change at all.
 */
export const sharedAgentDir = (workspace) => resolveState(workspace).root;

/**
 * Where the *code* being worked on lives, as opposed to where its state is kept.
 *
 * These are different directories in a group layout and the same one otherwise,
 * and conflating them was a real bug: `AGENT.md` and the skills walk both read
 * from `workspace`, so opening `/base-repo` scoped to repo-1 read the group's
 * AGENT.md and never saw repo-1's own.
 *
 *   workspace  /base-repo            what was opened
 *   codeDir    /base-repo/repo-1     what is being worked on   ← this
 *   agentDir   /base-repo/.agent/repo-1
 *
 * Anything about the *project* — instructions, skills, indexing, watching —
 * belongs to codeDir. Anything the agent writes belongs to agentDir.
 */
export const codeDir = (workspace) => {
  const { base } = resolveState(workspace);
  const scope = getActiveScope(workspace);
  return scope ? path.join(base, scope) : path.resolve(workspace);
};

/**
 * The config the agent writes to: the active scope's own.
 *
 * Reads merge `sharedConfigPath` underneath it (see AgentLoop._loadConfig), so
 * a group can set the model and allowlist once and a repo can override just
 * what it needs. With no scope the two are the same file and nothing changes.
 */
export const configPath = (workspace) => path.join(agentDir(workspace), 'config.json');

/** Config inherited by every scope under the root. */
export const sharedConfigPath = (workspace) => path.join(sharedAgentDir(workspace), 'config.json');
/**
 * What the agent has learned here, as markdown.
 *
 * Scoped (`agentDir`, not `sharedAgentDir`) and deliberately never walked: a
 * parent's `AGENT.md` applies to its children because a human wrote it, but a
 * sibling repo's inferences are just guesses nobody reviewed. See
 * context/memory-manager.js.
 */
export const memoryPath = (workspace) => path.join(agentDir(workspace), 'memory.md');

/** Documents written for the user to read: task.md, plan.md, walkthrough.md. */
export const artifactsDir = (workspace) => path.join(agentDir(workspace), 'artifacts');
export const artifactPath = (workspace, name) => path.join(artifactsDir(workspace), name);

/**
 * Past plans, kept.
 *
 * `artifacts/plan.md` is a single file the agent overwrites every time, so
 * asking for a second plan destroyed the first — including the one you were
 * halfway through reviewing. Each is archived here as it is superseded.
 */
export const planArchiveDir = (workspace) => path.join(artifactsDir(workspace), 'plans');

/** Machine state: editor.json, github.json, plan-approval.json. */
export const stateDir = (workspace) => path.join(agentDir(workspace), 'state');
export const statePath = (workspace, name) => path.join(stateDir(workspace), name);
export const editorStatePath = (workspace) => statePath(workspace, 'editor.json');
export const githubStatePath = (workspace) => statePath(workspace, 'github.json');
export const planApprovalPath = (workspace) => statePath(workspace, 'plan-approval.json');
/** Problems from the editor's language servers, written by the VS Code companion. */
export const diagnosticsPath = (workspace) => statePath(workspace, 'diagnostics.json');
/** Selections the user sent over with "Add to Agent Chat". Append-only. */
export const chatQueuePath = (workspace) => statePath(workspace, 'chat-queue.jsonl');
/**
 * Commands that failed in a VS Code terminal, appended by the companion.
 *
 * The agent could always be woken by a process *it* started (`run_background`
 * plus `manage_task watch`); a terminal you opened yourself belonged to the
 * terminal emulator and there was no API for it. Inside VS Code there is one.
 * Append-only for the same reason as chat-queue: the CLI drains by deleting.
 */
export const terminalQueuePath = (workspace) => statePath(workspace, 'terminal.jsonl');
/** Comments left on a plan while reviewing it, before the review is submitted. */
export const planReviewPath = (workspace) => statePath(workspace, 'plan-review.json');

export const backupsDir = (workspace) => path.join(agentDir(workspace), 'backups');
export const contextDir = (workspace) => path.join(agentDir(workspace), 'context');
export const contextSummaryPath = (workspace) => path.join(contextDir(workspace), 'summary.md');
export const plansDir = (workspace) => path.join(agentDir(workspace), 'github-pr-plans');
export const logsDir = (workspace) => path.join(agentDir(workspace), 'logs');
export const sessionsDirLocal = (workspace) => path.join(agentDir(workspace), 'sessions');
/** Session history kept alongside the project. */
export const localSessionPath = (workspace) => path.join(sessionsDirLocal(workspace), 'history.jsonl');
export const tmpDir = (workspace) => path.join(agentDir(workspace), 'tmp');
/**
 * Where `/skills` keeps one markdown file per skill.
 *
 * Shared across the whole root: a skill written for the group applies to every
 * repo in it, which is the same thing the ancestor walk in core/skills.js does
 * for directories further up the tree.
 */
export const skillsDir = (workspace) => path.join(sharedAgentDir(workspace), 'skills');
export const skillPath = (workspace, name) => path.join(skillsDir(workspace), `${name}.md`);
export const logPath = (workspace) => path.join(logsDir(workspace), 'agent.log');
/** Structured failure log, one JSON object per line. See core/error-log.js. */
export const errorLogPath = (workspace) => path.join(logsDir(workspace), 'errors.jsonl');

// ── Workspace-relative (for configs and prompts that need a relative name) ──

export const REL_PLANS_DIR = `${AGENT_DIR}/github-pr-plans`;
export const REL_GITHUB_STATE = `${AGENT_DIR}/state/github.json`;
export const REL_ARTIFACTS_DIR = `${AGENT_DIR}/artifacts`;

// ── Home-scoped ──────────────────────────────────────────────────────

/**
 * The home directory, `~/.agent` unless overridden.
 *
 * `AGENT_CLI_HOME` is the current name. The two older ones are still read
 * because dropping them would not fail — it would silently point an existing
 * install at a different directory and look like the session history had
 * vanished. They cost one `||` each.
 */
export const homeDir = () =>
  process.env.AGENT_CLI_HOME           // current
  || process.env.GEMINI_AGENT_HOME     // deprecated: pre-rename name
  || process.env.AGENT_HOME            // deprecated: earlier alias
  || path.join(os.homedir(), AGENT_DIR);

/** The pre-.agent home directory, kept so migration can find it. */
export const legacyHomeDir = () => path.join(os.homedir(), '.gemini-agent');

/**
 * A stable, readable folder name for a workspace: its directory name plus a
 * short hash of the absolute path, so two projects called "app" never collide.
 */
export const workspaceSlug = (workspace) => {
  // Keyed on the resolved state directory, not the workspace path. Opening
  // /base-repo with --scope repo-1 and opening /base-repo/repo-1 are the same
  // project and must share one history file; /base-repo with repo-1 and with
  // repo-2 are different projects and must not.
  const identity = agentDir(workspace);
  const hash = crypto.createHash('md5').update(identity).digest('hex').slice(0, 8);
  const scope = getActiveScope(workspace);
  const name = scope ? path.basename(scope) : path.basename(workspace);
  return `${name}-${hash}`;
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

/**
 * Absolute paths of workspaces this agent has been pointed at, most recent
 * first. The per-workspace home folders are named by `workspaceSlug`, which
 * hashes the path and cannot be reversed, so the list has to be kept separately.
 */
export const recentWorkspacesPath = () => path.join(homeDir(), 'recent-workspaces.json');

/**
 * Where a chosen workspace is left for the supervisor to pick up.
 *
 * Switching workspace mid-session was the problem, not the feature — see
 * CLAUDE.md → What's next. `/set-workspace` writes the choice here, the process
 * exits asking to be restarted, and `src/index.js` relaunches pointing at it.
 * A file rather than an argument because the child cannot change its own argv.
 */
export const nextWorkspacePath = () => path.join(homeDir(), 'next-workspace');
