import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PromptBuilder } from '../../src/core/prompt-builder.js';
import { retiredInstructionFiles } from '../../src/core/migrate.js';
import * as paths from '../../src/core/paths.js';

/** A workspace with its own `.agent/`, i.e. the ordinary single-repo case. */
function workspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'instr-'));
  fs.mkdirSync(path.join(ws, '.agent'), { recursive: true });
  paths.clearPathCache();
  return ws;
}

const firstPrompt = (ws) =>
  new PromptBuilder(ws, ws).buildPrompt({ userMessage: 'hi', mode: 'auto', topology: 'single' });

test('AGENT.md is the only instruction surface', async (t) => {
  t.afterEach(() => { paths.setActiveScope(null); paths.clearPathCache(); });

  await t.test('AGENT.md beside the code reaches the model', () => {
    const ws = workspace();
    fs.writeFileSync(path.join(ws, 'AGENT.md'), 'PREFER TABS OVER SPACES');
    const p = firstPrompt(ws);
    assert.match(p, /<agent_instructions>/);
    assert.match(p, /PREFER TABS OVER SPACES/);
  });

  await t.test('a leftover .agent/rules.md does not', () => {
    const ws = workspace();
    fs.writeFileSync(path.join(ws, '.agent', 'rules.md'), 'NEVER USE SEMICOLONS');
    const p = firstPrompt(ws);
    assert.doesNotMatch(p, /NEVER USE SEMICOLONS/);
    assert.doesNotMatch(p, /<workspace_rules>/);
  });

  await t.test('and neither does .agent/mistakes.md', () => {
    const ws = workspace();
    fs.writeFileSync(path.join(ws, '.agent', 'mistakes.md'), 'I ONCE DELETED PROD');
    assert.doesNotMatch(firstPrompt(ws), /I ONCE DELETED PROD/);
  });

  await t.test('the model is no longer told to keep a mistakes log', () => {
    assert.doesNotMatch(firstPrompt(workspace()), /mistakes\.md/);
  });
});

test('retired files are named at startup rather than moved', async (t) => {
  t.afterEach(() => { paths.setActiveScope(null); paths.clearPathCache(); });

  await t.test('nothing to say when there is nothing left behind', () => {
    assert.deepEqual(retiredInstructionFiles(workspace()), []);
  });

  await t.test('both retired files are reported, and left where they are', () => {
    const ws = workspace();
    const rules = path.join(ws, '.agent', 'rules.md');
    const mistakes = path.join(ws, '.agent', 'mistakes.md');
    fs.writeFileSync(rules, 'house rules');
    fs.writeFileSync(mistakes, 'log');

    assert.deepEqual(retiredInstructionFiles(ws).sort(), [mistakes, rules].sort());
    // Named, never touched: an AGENT.md is usually tracked in git and appending
    // to it would put an unasked-for diff in the user's repo.
    assert.equal(fs.readFileSync(rules, 'utf8'), 'house rules');
    assert.equal(fs.existsSync(path.join(ws, 'AGENT.md')), false);
  });

  await t.test('a scoped rules.md is found too, and listed once', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'instr-grp-'));
    const base = path.join(root, 'base-repo');
    fs.mkdirSync(path.join(base, '.agent', 'repo-1'), { recursive: true });
    fs.mkdirSync(path.join(base, 'repo-1'), { recursive: true });
    paths.clearPathCache();
    paths.setActiveScope('repo-1');
    fs.writeFileSync(path.join(base, '.agent', 'repo-1', 'rules.md'), 'repo rules');

    assert.deepEqual(retiredInstructionFiles(base), [
      path.join(base, '.agent', 'repo-1', 'rules.md'),
    ]);
  });
});
