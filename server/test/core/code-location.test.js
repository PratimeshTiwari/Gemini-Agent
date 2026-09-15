import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PromptBuilder } from '../../src/core/prompt-builder.js';
import * as paths from '../../src/core/paths.js';
import { skillSearchPath } from '../../src/core/skills.js';

function group() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-'));
  const base = path.join(root, 'base-repo');
  const repo = path.join(base, 'repo-1');
  fs.mkdirSync(path.join(base, '.agent'), { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  return { root, base, repo };
}

test('codeDir — the code, not the workspace', async (t) => {
  t.afterEach(() => { paths.setActiveScope(null); paths.clearPathCache(); });

  await t.test('is the workspace when there is no scope', () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'solo-'));
    assert.equal(paths.codeDir(ws), path.resolve(ws));
  });

  await t.test('follows an explicit scope down from the group', () => {
    const { base, repo } = group();
    paths.setActiveScope('repo-1');
    assert.equal(paths.codeDir(base), repo);
  });

  await t.test('agrees whichever way you came in', () => {
    const { base, repo } = group();
    paths.setActiveScope('repo-1');
    const viaGroup = paths.codeDir(base);
    paths.setActiveScope(null); paths.clearPathCache();
    assert.equal(viaGroup, paths.codeDir(repo));
  });

  await t.test('is not the state directory', () => {
    const { base } = group();
    paths.setActiveScope('repo-1');
    assert.notEqual(paths.codeDir(base), paths.agentDir(base));
  });
});

test('AGENT.md is read from the code and walked', async (t) => {
  t.afterEach(() => { paths.setActiveScope(null); paths.clearPathCache(); });

  await t.test("finds the repo's own, which reading the workspace missed", () => {
    const { base, repo } = group();
    fs.writeFileSync(path.join(base, 'AGENT.md'), 'GROUP RULE');
    fs.writeFileSync(path.join(repo, 'AGENT.md'), 'REPO RULE');
    paths.setActiveScope('repo-1');
    const loaded = new PromptBuilder(base, base)._loadAgentMd();
    assert.match(loaded, /REPO RULE/);
  });

  await t.test('keeps the group rule too, with the nearest last', () => {
    const { base, repo } = group();
    fs.writeFileSync(path.join(base, 'AGENT.md'), 'GROUP RULE');
    fs.writeFileSync(path.join(repo, 'AGENT.md'), 'REPO RULE');
    paths.setActiveScope('repo-1');
    const loaded = new PromptBuilder(base, base)._loadAgentMd();
    assert.ok(loaded.indexOf('GROUP RULE') < loaded.indexOf('REPO RULE'),
      'nearest must have the last word');
  });

  await t.test('a single repo still reads exactly one file', () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'solo-'));
    fs.writeFileSync(path.join(ws, 'AGENT.md'), 'ONLY');
    assert.equal(new PromptBuilder(ws, ws)._loadAgentMd(), 'ONLY');
  });

  await t.test('is empty, not an error, when there is none', () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'bare-'));
    assert.equal(new PromptBuilder(ws, ws)._loadAgentMd(), '');
  });
});

test("skills are searched from the code too", async (t) => {
  t.afterEach(() => { paths.setActiveScope(null); paths.clearPathCache(); });

  await t.test("the active repo's own skills directory is searched first", () => {
    const { base, repo } = group();
    paths.setActiveScope('repo-1');
    assert.equal(skillSearchPath(base)[0], path.join(repo, '.agent', 'skills'));
  });
});
