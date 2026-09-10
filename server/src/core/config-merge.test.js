import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AgentLoop } from './agent-loop.js';
import * as paths from './paths.js';

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
    loop.topology = 'duo';
    loop.modelConfig = { effort: 'standard' };
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
      topology: 'single',
    }, null, 2));

    loopFor(ws)._saveConfig();

    const saved = read();
    assert.strictEqual(saved.agentName, 'DCX', 'the banner name must survive');
    assert.deepStrictEqual(saved.somethingFuture, { keep: true });
    assert.strictEqual(saved.topology, 'duo', 'and owned keys still win');
  });

  test('a missing config is created rather than refused', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'cfg2-'));
    loopFor(fresh)._saveConfig();
    assert.strictEqual(JSON.parse(readFileSync(paths.configPath(fresh), 'utf8')).topology, 'duo');
    rmSync(fresh, { recursive: true, force: true });
  });

  test('an unparseable config does not block the save', () => {
    writeFileSync(paths.configPath(ws), '{ this is not json');
    loopFor(ws)._saveConfig();
    assert.strictEqual(read().topology, 'duo');
  });

  test('a config that is an array, not an object, is discarded safely', () => {
    writeFileSync(paths.configPath(ws), '["nope"]');
    loopFor(ws)._saveConfig();
    assert.strictEqual(read().topology, 'duo');
  });
});
