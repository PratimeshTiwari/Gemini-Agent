import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  resolveState, setActiveScope, getActiveScope, agentDir, sharedAgentDir,
  clearPathCache, homeDir, AGENT_DIR,
} from '../../src/core/paths.js';

/** /tmp/<x>/base-repo/{.agent,repo-1,repo-2} */
function monorepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mono-'));
  const group = path.join(root, 'base-repo');
  fs.mkdirSync(path.join(group, AGENT_DIR), { recursive: true });
  for (const r of ['repo-1', 'repo-2']) fs.mkdirSync(path.join(group, r), { recursive: true });
  return { root, group, repo1: path.join(group, 'repo-1'), repo2: path.join(group, 'repo-2') };
}

test('resolveState', async (t) => {
  t.afterEach(() => { setActiveScope(null); clearPathCache(); });

  await t.test('a plain repo with no .agent keeps the old layout exactly', () => {
    // This is the case every existing install is in; it must not move.
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'solo-'));
    const state = resolveState(ws);
    assert.equal(state.discovered, false);
    assert.equal(state.scope, '');
    assert.equal(agentDir(ws), path.join(ws, AGENT_DIR));
  });

  await t.test('a repo with its own .agent finds it at depth 0', () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'own-'));
    fs.mkdirSync(path.join(ws, AGENT_DIR));
    const state = resolveState(ws);
    assert.equal(state.discovered, true);
    assert.equal(state.scope, '');
    assert.equal(agentDir(ws), path.join(ws, AGENT_DIR));
  });

  await t.test('opening the group gives the root and no scope', () => {
    const { group } = monorepo();
    assert.equal(resolveState(group).scope, '');
    assert.equal(agentDir(group), path.join(group, AGENT_DIR));
  });

  await t.test('opening a repo underneath walks up and scopes itself', () => {
    const { group, repo1 } = monorepo();
    const state = resolveState(repo1);
    assert.equal(state.root, path.join(group, AGENT_DIR));
    assert.equal(state.scope, 'repo-1');
    assert.equal(agentDir(repo1), path.join(group, AGENT_DIR, 'repo-1'));
  });

  await t.test('the group and the repo agree on the shared root', () => {
    // The property that makes this worth doing: same state either way in.
    const { group, repo1 } = monorepo();
    assert.equal(sharedAgentDir(repo1), sharedAgentDir(group));
  });

  await t.test('sibling repos do not share scoped state', () => {
    const { repo1, repo2 } = monorepo();
    assert.notEqual(agentDir(repo1), agentDir(repo2));
  });

  await t.test('a nested repo keeps its full path as the scope', () => {
    const { group } = monorepo();
    const deep = path.join(group, 'services', 'api');
    fs.mkdirSync(deep, { recursive: true });
    assert.equal(resolveState(deep).scope, path.join('services', 'api'));
  });
});

test('the ~/.agent landmine', async (t) => {
  await t.test('a project under $HOME never adopts ~/.agent as its root', () => {
    // The actual risk the upward walk introduces. ~/.agent exists on every
    // machine that has run the agent once, so a naive walk from any project
    // under $HOME would find it and put every project's state — and every
    // project's rules — into one shared directory.
    const project = path.join(os.homedir(), 'code-xyz', 'some-project');
    const state = resolveState(project);
    assert.notEqual(state.root, homeDir());
    assert.notEqual(state.root, path.join(os.homedir(), AGENT_DIR));
    assert.equal(state.discovered, false);
    assert.equal(state.root, path.join(project, AGENT_DIR));
  });

  await t.test('$HOME itself is left where it has always been', () => {
    // Running the agent directly in $HOME resolves to ~/.agent, which is what
    // it did before the walk existed. Moving it would relocate the state of
    // anyone who does that, to fix a collision nobody has reported.
    assert.equal(resolveState(os.homedir()).root, path.join(os.homedir(), AGENT_DIR));
  });

  await t.test('the walk stops at $HOME rather than reaching the filesystem root', () => {
    const under = path.join(os.homedir(), 'definitely-not-a-real-dir-xyz');
    const state = resolveState(under);
    assert.equal(state.discovered, false);
    assert.equal(state.root, path.join(under, AGENT_DIR));
  });
});

test('setActiveScope', async (t) => {
  t.afterEach(() => { setActiveScope(null); clearPathCache(); });

  await t.test('lets you open the group and work on one repo', () => {
    // The scope cannot be derived here — the workspace is the whole group.
    const { group } = monorepo();
    setActiveScope('repo-2');
    assert.equal(agentDir(group), path.join(group, AGENT_DIR, 'repo-2'));
    assert.equal(getActiveScope(group), 'repo-2');
  });

  await t.test('leaves the shared root alone', () => {
    const { group } = monorepo();
    setActiveScope('repo-2');
    assert.equal(sharedAgentDir(group), path.join(group, AGENT_DIR));
  });

  await t.test('overrides a derived scope', () => {
    const { repo1 } = monorepo();
    setActiveScope('repo-2');
    assert.equal(getActiveScope(repo1), 'repo-2');
  });

  await t.test('tolerates the ways a path gets typed', () => {
    const { group } = monorepo();
    for (const typed of ['./repo-1', 'repo-1/', '/repo-1']) {
      setActiveScope(typed);
      assert.equal(getActiveScope(group), 'repo-1', typed);
    }
  });

  await t.test('clearing it returns to the derived scope', () => {
    const { repo1 } = monorepo();
    setActiveScope('repo-2');
    setActiveScope(null);
    assert.equal(getActiveScope(repo1), 'repo-1');
  });
});
