/**
 * Which repos the PR agent watches.
 *
 * `resolveGitHubConfig` reads `GITHUB_REPOS`, and the handler's constructor
 * then overwrote the result unconditionally from the git remote — so the env
 * var was ignored in exactly the case someone would set it: watching a repo
 * that is not the one checked out here. An explicit `repos` override had the
 * same fate.
 *
 * Auto-detection is still the default and still right; it is a fallback now
 * rather than the last word.
 */

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert';
import { GitHubEventHandler } from '../../src/github/github-event-handler.js';

const saved = process.env.GITHUB_REPOS;
afterEach(() => {
  if (saved === undefined) delete process.env.GITHUB_REPOS;
  else process.env.GITHUB_REPOS = saved;
});

/** The repo list a handler settles on, without starting any polling. */
function repos({ env, overrides } = {}) {
  if (env === undefined) delete process.env.GITHUB_REPOS;
  else process.env.GITHUB_REPOS = env;
  const handler = new GitHubEventHandler({
    token: 'test-token',
    workspace: process.cwd(),
    configOverrides: overrides || {},
  });
  return handler.config.repos;
}

describe('GITHUB_REPOS is honoured', () => {
  test('the env var wins over the git remote', () => {
    assert.deepEqual(repos({ env: 'octo/one' }), ['octo/one']);
  });

  test('several repos, comma separated and trimmed', () => {
    assert.deepEqual(repos({ env: 'octo/one, octo/two' }), ['octo/one', 'octo/two']);
  });

  test('an explicit override wins too', () => {
    assert.deepEqual(repos({ overrides: { repos: ['octo/three'] } }), ['octo/three']);
  });
});

describe('auto-detection is still the default', () => {
  test('with nothing asked for, the git remote is used', () => {
    // This test runs inside a git checkout with a GitHub origin, which is the
    // case the auto-detection exists for.
    const detected = repos({});
    assert.ok(Array.isArray(detected));
    assert.ok(detected.length >= 1, 'no repo was detected and none was configured');
    assert.match(detected[0], /\//, `expected owner/name, got ${detected[0]}`);
  });

  test('an empty env var is not an answer', () => {
    // `GITHUB_REPOS=` in a shell profile is emptiness, not a request to watch
    // nothing — falling back is the only reading that leaves the agent working.
    const detected = repos({ env: '' });
    assert.ok(detected.length >= 1);
  });
});
