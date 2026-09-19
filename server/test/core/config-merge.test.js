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
    loop.modelConfig = { main: 'gemini', subagents: true, effort: 'standard' };
    loop.commandRules = { enabled: true, allow: [], block: [] };
    return loop;
  };

  // The default modelConfig already carries `effort: 'standard'`. Folding the
  // *merged* object let that default shadow the legacy keys it exists to read,
  // so every config written before /effort resolved to standard whatever it said.
  test('a pre-/effort config folds to the rung it actually asked for', () => {
    writeFileSync(paths.configPath(ws), JSON.stringify({
      modelConfig: { modelTier: 'lite', reasoningLevel: 'deep', reasoningEffort: 'low' },
    }));
    const loop = loopFor(ws);
    loop.modelConfig = { main: 'gemini', effort: 'standard' };
    loop._loadConfig();

    assert.equal(loop.modelConfig.effort, 'lite');
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

  // topology no longer exists. Leaving a stale copy in
  // the file is worse than dropping it: it is a value someone would edit and
  // then be ignored for editing.
  test('a stored topology is dropped rather than written back', () => {
    writeFileSync(paths.configPath(ws), JSON.stringify({ topology: 'single', agentName: 'DCX' }));
    loopFor(ws)._saveConfig();

    const saved = read();
    assert.strictEqual('topology' in saved, false);
    assert.strictEqual(saved.agentName, 'DCX', 'without taking its neighbours with it');
  });

  /*
   * `topology` and `reviewer` are both gone. Duo meant "a second tab reviews",
   * which is one of three roles on one tool now, so a stored duo folds to
   * subagents-on.
   *
   * A stored `single` folds to nothing, and that is the part worth stating:
   * single never meant "no subagents", it meant "no *reviewer*" —
   * `ask_researcher` and `ask_subagent` were offered either way. Reading it as
   * off would take two working tools away from every existing workspace.
   */
  test('a stored duo folds to subagents on', () => {
    writeFileSync(paths.configPath(ws), JSON.stringify({
      topology: 'duo', modelConfig: { main: 'gemini', reviewer: null },
    }));
    const loop = loopFor(ws);
    loop._loadConfig();
    assert.strictEqual(loop.modelConfig.subagents, true);
    assert.strictEqual(loop.subagentsEnabled, true);
  });

  test('a stored reviewer folds to subagents on, whatever it named', () => {
    writeFileSync(paths.configPath(ws), JSON.stringify({
      modelConfig: { main: 'gemini', reviewer: 'chatgpt' },
    }));
    const loop = loopFor(ws);
    loop._loadConfig();
    assert.strictEqual(loop.modelConfig.subagents, true);
    assert.strictEqual(loop.modelConfig.reviewer, undefined, 'the dead key is dropped');
  });

  test('a stored single does not turn subagents off', () => {
    writeFileSync(paths.configPath(ws), JSON.stringify({
      topology: 'single', modelConfig: { main: 'gemini' },
    }));
    const loop = loopFor(ws);
    loop.modelConfig = { main: 'gemini', subagents: true, effort: 'standard' };
    loop._loadConfig();
    assert.strictEqual(loop.subagentsEnabled, true,
      'single meant no reviewer, not no subagents');
  });

  // The negative control. An explicit `false` is a decision someone made and
  // must survive every fold above it.
  test('an explicit off is honoured', () => {
    writeFileSync(paths.configPath(ws), JSON.stringify({
      topology: 'duo', modelConfig: { main: 'gemini', subagents: false },
    }));
    const loop = loopFor(ws);
    loop._loadConfig();
    assert.strictEqual(loop.subagentsEnabled, false);
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
