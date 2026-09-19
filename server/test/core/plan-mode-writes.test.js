/**
 * What plan mode actually protects.
 *
 * The rule the product states — in the system prompt, and in the status row
 * that reads "plan — every edit needs approval" — is that no edit reaches
 * disk without the user saying yes. The code exempted `path.endsWith('.md')`,
 * with a comment explaining that markdown "like plans" is harmless.
 *
 * The intent was real: `task.md` and `plan.md` are files the system prompt
 * *tells* the model to keep current, and it cannot do that if every tick
 * needs a keystroke. But the test was the file **extension**, not the
 * **location**. So in plan mode the agent could silently write any markdown
 * anywhere — `README.md`, `CLAUDE.md`, and `AGENT.md`, the one file this
 * project promises "can always be trusted to say what the human wrote".
 *
 * Reported from use: `create_file test-agent-cli.md` in plan mode returned
 * `"status":"applied"`. It had been written, with no approval, while the
 * status bar claimed every edit needed one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAgentArtifact } from '../../src/core/agent-loop.js';
import * as paths from '../../src/core/paths.js';

/**
 * A real directory, and the artifacts path asked for rather than assumed.
 *
 * My first version hard-coded `<ws>/.agent/artifacts`, which is only the
 * layout when no parent holds an `.agent/`. `resolveState` walks up like git
 * does, so a stray `/tmp/.agent` moved the real directory to
 * `/tmp/.agent/<name>/artifacts` and the test failed against correct code.
 * Deriving it tests the rule — inside the artifacts directory is exempt,
 * outside is not — wherever that directory turns out to be.
 */
const WS = mkdtempSync(path.join(tmpdir(), 'plan-mode-'));
const ARTIFACTS = paths.artifactsDir(WS);
const artifact = (name) => path.join(ARTIFACTS, name);

test('the agent\'s own artifacts are exempt', () => {
  // These are the files the system prompt tells it to maintain.
  for (const name of ['task.md', 'plan.md', 'walkthrough.md']) {
    assert.equal(isAgentArtifact(WS, artifact(name)), true, name);
  }
});

test('ordinary markdown in the repo is not', () => {
  // The whole bug: these all end in .md and none of them is an artifact.
  for (const p of ['README.md', 'CLAUDE.md', 'AGENT.md', 'docs/guide.md', 'test-agent-cli.md']) {
    assert.equal(isAgentArtifact(WS, p), false, p);
  }
});

test('markdown outside the workspace is not', () => {
  // The tools accept absolute paths, so this is reachable.
  assert.equal(isAgentArtifact(WS, '/etc/notes.md'), false);
  assert.equal(isAgentArtifact(WS, '/tmp/elsewhere/plan.md'), false);
});

test('a traversal out of the artifacts directory is not', () => {
  // Named `task.md` and resolving somewhere else entirely.
  assert.equal(isAgentArtifact(WS, '.agent/artifacts/../../../task.md'), false);
  assert.equal(isAgentArtifact(WS, artifact('../../../../etc/task.md')), false);
});

test('the artifacts directory itself is not a file to write', () => {
  assert.equal(isAgentArtifact(WS, '.agent/artifacts'), false);
});

test('nonsense is refused rather than assumed safe', () => {
  for (const bad of [undefined, null, '', 42, {}]) {
    assert.equal(isAgentArtifact(WS, bad), false, String(bad));
  }
});

test('a nested file under artifacts is still an artifact', () => {
  // `plans/` archives live under it.
  assert.equal(isAgentArtifact(WS, artifact('plans/2026-01-01.md')), true);
});

test('a relative path that lands outside the artifacts dir is not exempt', () => {
  // In a scoped setup the state directory is not under the workspace at all,
  // so `.agent/artifacts/task.md` resolved against the workspace need not be
  // the real artifacts directory. Failing closed — ask for approval — is the
  // right answer when the two disagree.
  const scoped = ARTIFACTS !== path.join(WS, '.agent', 'artifacts');
  assert.equal(isAgentArtifact(WS, '.agent/artifacts/task.md'), !scoped);
});
