import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveWorkspaceInput, validateWorkspace, listWorkspaceCandidates } from './workspaces.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-test-'));
const project = path.join(tmp, 'project');
const sibling = path.join(tmp, 'sibling');
const plain = path.join(tmp, 'plain');
fs.mkdirSync(project);
fs.mkdirSync(sibling);
fs.mkdirSync(plain);
fs.writeFileSync(path.join(sibling, 'package.json'), '{}');
fs.writeFileSync(path.join(tmp, 'a-file.txt'), 'not a directory');

test('resolveWorkspaceInput', async (t) => {
  await t.test('expands ~ against the home directory', () => {
    assert.equal(resolveWorkspaceInput('~'), os.homedir());
    assert.equal(resolveWorkspaceInput('~/code'), path.join(os.homedir(), 'code'));
  });

  await t.test('resolves a relative path against the given base', () => {
    assert.equal(resolveWorkspaceInput('sibling', tmp), sibling);
    assert.equal(resolveWorkspaceInput('./sibling', tmp), sibling);
    assert.equal(resolveWorkspaceInput('../plain', project), plain);
  });

  await t.test('strips quotes and a trailing slash', () => {
    assert.equal(resolveWorkspaceInput(`"${sibling}"`), sibling);
    assert.equal(resolveWorkspaceInput(`${sibling}/`), sibling);
  });

  await t.test('reports nothing for empty input', () => {
    assert.equal(resolveWorkspaceInput('   '), null);
    assert.equal(resolveWorkspaceInput(undefined), null);
  });
});

test('validateWorkspace', async (t) => {
  await t.test('accepts a real directory', () => {
    assert.equal(validateWorkspace(project), null);
  });

  await t.test('rejects a path that is not there — the whole point', () => {
    // Before this check the path was assigned anyway and every later tool call
    // failed separately against a root that never existed.
    assert.match(validateWorkspace(path.join(tmp, 'nope')), /No such directory/);
  });

  await t.test('rejects a file', () => {
    assert.match(validateWorkspace(path.join(tmp, 'a-file.txt')), /Not a directory/);
  });

  await t.test('rejects nothing at all', () => {
    assert.match(validateWorkspace(null), /No path given/);
  });
});

test('listWorkspaceCandidates', async (t) => {
  await t.test('puts the current workspace first and marks it', () => {
    const [first] = listWorkspaceCandidates(project);
    assert.equal(first.path, project);
    assert.equal(first.current, true);
    assert.match(first.label, /current/);
  });

  await t.test('offers sibling folders that look like projects', () => {
    const paths = listWorkspaceCandidates(project).map((c) => c.path);
    assert.ok(paths.includes(sibling), `expected ${sibling} in ${JSON.stringify(paths)}`);
  });

  await t.test('never lists a file, and never repeats a folder', () => {
    const paths = listWorkspaceCandidates(project).map((c) => c.path);
    assert.ok(!paths.includes(path.join(tmp, 'a-file.txt')));
    assert.equal(new Set(paths).size, paths.length);
  });

  await t.test('honours the limit', () => {
    assert.ok(listWorkspaceCandidates(project, { limit: 2 }).length <= 2);
  });
});
