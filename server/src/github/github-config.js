/**
 * GitHub Agent Configuration
 *
 * Central config for the GitHub PR Comment Agent.
 * All values can be overridden via environment variables or CLI flags.
 */

import { REL_PLANS_DIR, REL_GITHUB_STATE } from '../core/paths.js';

export const GITHUB_CONFIG = {
  // ── Polling ──────────────────────────────────────────────────────
  pollIntervalMs: 60_000,           // 1 minute default
  maxPRsToWatch: 50,                // Max open PRs to monitor

  // ── Output ───────────────────────────────────────────────────────
  planOutputDir: REL_PLANS_DIR,  // Relative to workspace root
  stateFile: REL_GITHUB_STATE,

  // ── Filtering ────────────────────────────────────────────────────
  repos: [],                        // Empty = auto-discover all repos where user authored PRs
  ignoreAuthors: [                  // Skip comments from these users (bots)
    'dependabot[bot]',
    'dependabot',
    'renovate[bot]',
    'renovate',
    'github-actions[bot]',
    'codecov[bot]',
    'sonarcloud[bot]',
  ],
  avoidWords: [                     // Skip comments containing these phrases
    'lgtm', 'looks good to me', '+1', 'approved', 'looks good',
    'thanks', 'thank you', 'merging'
  ],

  // ── Feature Toggles ─────────────────────────────────────────────
  enableCIWatch: true,              // Also watch GitHub Actions failures
  enableBrowserBridge: true,        // Inject content script into github.com

  // ── API ──────────────────────────────────────────────────────────
  apiBaseUrl: 'https://api.github.com',
  perPage: 100,                     // Items per API page
};

/**
 * Build a runtime config by merging defaults with env vars.
 */
export function resolveGitHubConfig(overrides = {}) {
  const config = { ...GITHUB_CONFIG, ...overrides };

  // Override from env
  if (process.env.GITHUB_POLL_INTERVAL) {
    config.pollIntervalMs = parseInt(process.env.GITHUB_POLL_INTERVAL, 10);
  }
  if (process.env.GITHUB_CI_WATCH === 'false') {
    config.enableCIWatch = false;
  }
  if (process.env.GITHUB_REPOS) {
    config.repos = process.env.GITHUB_REPOS.split(',').map(r => r.trim());
  }

  return config;
}
