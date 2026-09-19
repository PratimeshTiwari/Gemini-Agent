import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AgentLoop } from '../../src/core/agent-loop.js';
import * as paths from '../../src/core/paths.js';

// _saveConfig used to write a fixed set of keys, destroying every other one.
// agentName is the case that bit: set by hand, read by the banner, never
// written back — so the first /model or /reasoning silently wiped it.
describe('AgentLoop._saveConfig', () => {
  let ws;
  before(() => {
    ws = mkdtempSync(join(tmpdir(), 'cfg-'));
    mkdirSync(join(ws, '.agent'), { recursive: true });
  });
  after(() => rmSync(ws, { recursive: true, force: true }));

  const read = () => JSON.parse(readFileSync(paths.configPath(ws), 'utf8'));

  const loopFor = (workspace) => {
    const loop = Object.create(AgentLoop.prototype);
    loop.workspace = workspace;
    loop.modelConfig = { main: 'gemini', reviewer: 'chatgpt', effort: 'standard' };
    loop.commandRules = { enabled: true, allow: [], block: [] };
    return loop;
  };

  // The default modelConfig already carries `effort: 'standard'`. Folding the
  // *merged* object let that default shadow the legacy keys it exists to read,
  // so every config written before /effort resolved to standard whatever it said.
  test('a pre-/effort config folds to the rung it actually asked for', () => {
    writeFileSync(paths.configPath(ws), JSON.stringify({
      modelConfig: { modelTier: 'flash', reasoningLevel: 'deep', reasoningEffort: 'low' },
    }));
    const loop = loopFor(ws);
    loop.modelConfig = { main: 'gemini', effort: 'standard' };
    loop._loadConfig();

    assert.equal(loop.modelConfig.effort, 'flash');
    assert.equal(loop.modelConfig.modelTier, undefined, 'the old keys are folded away');
    assert.equal(loop.modelConfig.reasoningLevel, undefined);
    assert.equal(loop.modelConfig.reasoningEffort, undefined);
  });

  test('keys it does not own survive a save', () => {
    writeFileSync(paths.configPath(ws), JSON.stringify({
      agentName: 'DCX',
      somethingFuture: { keep: true },
      modelConfig: { main: 'chatgpt' },
    }, null, 2));

    loopFor(ws)._saveConfig();

    const saved = read();
    assert.strictEqual(saved.agentName, 'DCX', 'the banner name must survive');
    assert.deepStrictEqual(saved.somethingFuture, { keep: true });
    assert.strictEqual(saved.modelConfig.main, 'gemini', 'and owned keys still win');
  });

  // topology is derived from modelConfig.reviewer now. Leaving a stale copy in
  // the file is worse than dropping it: it is a value someone would edit and
  // then be ignored for editing.
  test('a stored topology is dropped rather than written back', () => {
    writeFileSync(paths.configPath(ws), JSON.stringify({ topology: 'single', agentName: 'DCX' }));
    loopFor(ws)._saveConfig();

    const saved = read();
    assert.strictEqual('topology' in saved, false);
    assert.strictEqual(saved.agentName, 'DCX', 'without taking its neighbours with it');
  });

  test('a config that stored topology folds it into the reviewer', () => {
    writeFileSync(paths.configPath(ws), JSON.stringify({ topology: 'single' }));
    const loop = loopFor(ws);
    loop._loadConfig();
    assert.strictEqual(loop.modelConfig.reviewer, null, 'single means nobody reviews');
    assert.strictEqual(loop.topology, 'single');
  });

  test('a stored duo with no reviewer named gets a second tab of the one model', () => {
    writeFileSync(paths.configPath(ws), JSON.stringify({
      topology: 'duo', modelConfig: { main: 'gemini', reviewer: null },
    }));
    const loop = loopFor(ws);
    loop._loadConfig();
    assert.strictEqual(loop.modelConfig.reviewer, 'gemini');
    assert.strictEqual(loop.topology, 'duo');
  });

  /*
   * `_saveConfig` preserves keys it does not own, which is what makes a config
   * written when ChatGPT existed survive every later save. Left alone it points
   * the agent at a site with no bridge, and nothing on screen says why.
   */
  test('a config naming ChatGPT is folded to the one model that is left', () => {
    writeFileSync(paths.configPath(ws), JSON.stringify({
      modelConfig: { main: 'chatgpt', reviewer: 'chatgpt', effort: 'standard' },
    }));
    const loop = loopFor(ws);
    loop._loadConfig();
    assert.strictEqual(loop.modelConfig.main, 'gemini');
    assert.strictEqual(loop.modelConfig.reviewer, 'gemini', 'a reviewer was asked for, so keep one');
    assert.strictEqual(loop.topology, 'duo');
  });

  // The negative control. Folding must not invent a reviewer where the config
  // says there is none — that would turn every solo session into a duo one.
  test('a ChatGPT main with no reviewer stays solo', () => {
    writeFileSync(paths.configPath(ws), JSON.stringify({
      modelConfig: { main: 'chatgpt', reviewer: null, effort: 'standard' },
    }));
    const loop = loopFor(ws);
    loop.modelConfig = { main: 'gemini', reviewer: null, effort: 'standard' };
    loop._loadConfig();
    assert.strictEqual(loop.modelConfig.main, 'gemini');
    assert.strictEqual(loop.modelConfig.reviewer, null);
    assert.strictEqual(loop.topology, 'single');
  });

  test('a missing config is created rather than refused', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'cfg2-'));
    loopFor(fresh)._saveConfig();
    assert.strictEqual(JSON.parse(readFileSync(paths.configPath(fresh), 'utf8')).modelConfig.main, 'gemini');
    rmSync(fresh, { recursive: true, force: true });
  });

  test('an unparseable config does not block the save', () => {
    writeFileSync(paths.configPath(ws), '{ this is not json');
    loopFor(ws)._saveConfig();
    assert.strictEqual(read().modelConfig.main, 'gemini');
  });

  test('a config that is an array, not an object, is discarded safely', () => {
    writeFileSync(paths.configPath(ws), '["nope"]');
    loopFor(ws)._saveConfig();
    assert.strictEqual(read().modelConfig.main, 'gemini');
  });
});
