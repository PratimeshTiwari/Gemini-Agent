import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MemoryManager, parseMemory, renderMemory } from '../../src/context/memory-manager.js';
import { migrateMemory } from '../../src/core/migrate.js';
import { PromptBuilder } from '../../src/core/prompt-builder.js';
import * as paths from '../../src/core/paths.js';

function workspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-'));
  fs.mkdirSync(path.join(ws, '.agent'), { recursive: true });
  paths.clearPathCache();
  return ws;
}

const firstPrompt = (ws) =>
  new PromptBuilder(ws, ws).buildPrompt({ userMessage: 'hi', mode: 'auto', topology: 'single' });

/** The `<memory>` block, not the tool docs that also mention the tag. */
function memoryBlock(prompt) {
  const m = prompt.match(/<system_state[\s\S]*?<memory>\n([\s\S]*?)\n<\/memory>/);
  return m ? m[1] : null;
}

test('memory round-trips through markdown', async (t) => {
  await t.test('bullets in, facts out', () => {
    assert.deepEqual(parseMemory('# Memory\n\n- one\n- two\n'), ['one', 'two']);
  });

  await t.test('hand-edited files are read the way people write them', () => {
    assert.deepEqual(parseMemory('* star\n1. numbered\n  - indented\n'), ['star', 'numbered', 'indented']);
  });

  await t.test('prose around the list is not mistaken for a fact', () => {
    const text = renderMemory(['the only fact']);
    assert.deepEqual(parseMemory(text), ['the only fact']);
  });

  await t.test('what is written can be read back', () => {
    const facts = ['tests run with pnpm', 'src/generated is generated'];
    assert.deepEqual(parseMemory(renderMemory(facts)), facts);
  });
});

test('MemoryManager', async (t) => {
  t.afterEach(() => { paths.setActiveScope(null); paths.clearPathCache(); });

  await t.test('a fact survives to the next instance', () => {
    const ws = workspace();
    new MemoryManager(ws).addMemory('the build is bazel');
    assert.deepEqual(new MemoryManager(ws).getAllMemories(), ['the build is bazel']);
  });

  await t.test('the same fact twice is stored once', () => {
    const ws = workspace();
    const m = new MemoryManager(ws);
    assert.equal(m.addMemory('one thing'), true);
    assert.equal(m.addMemory('One Thing'), false);
    assert.equal(m.getAllMemories().length, 1);
  });

  await t.test('a multi-line fact is flattened to the line the file holds', () => {
    const ws = workspace();
    const m = new MemoryManager(ws);
    m.addMemory('first\n  second');
    assert.deepEqual(m.getAllMemories(), ['first second']);
  });

  // The old signature was 0-based over a list nothing ever displayed, so the
  // model was guessing indices. These are the numbers the prompt shows.
  await t.test('forgetting uses the numbers the prompt shows', () => {
    const ws = workspace();
    const m = new MemoryManager(ws);
    ['a', 'b', 'c'].forEach((f) => m.addMemory(f));
    assert.equal(m.removeMemory(2), true);
    assert.deepEqual(m.getAllMemories(), ['a', 'c']);
  });

  await t.test('an out-of-range number changes nothing', () => {
    const ws = workspace();
    const m = new MemoryManager(ws);
    m.addMemory('only');
    assert.equal(m.removeMemory(0), false);
    assert.equal(m.removeMemory(9), false);
    assert.deepEqual(m.getAllMemories(), ['only']);
  });

  await t.test('nothing is stored while memory is off', () => {
    const ws = workspace();
    const m = new MemoryManager(ws);
    m.memoryEnabled = false;
    assert.equal(m.addMemory('should not stick'), false);
    assert.deepEqual(new MemoryManager(ws).getAllMemories(), []);
  });

  await t.test('the off switch is remembered across restarts', () => {
    const ws = workspace();
    fs.writeFileSync(paths.configPath(ws), JSON.stringify({ memoryEnabled: false }));
    assert.equal(new MemoryManager(ws).isMemoryEnabled(), false);
  });
});

test('memory reaches the model — the half that was missing', async (t) => {
  t.afterEach(() => { paths.setActiveScope(null); paths.clearPathCache(); });

  await t.test('stored facts come back in the prompt, numbered', () => {
    const ws = workspace();
    const m = new MemoryManager(ws);
    m.addMemory('deploys go through argo');
    m.addMemory('the api client is generated');

    assert.equal(memoryBlock(firstPrompt(ws)), '1. deploys go through argo\n2. the api client is generated');
  });

  await t.test('no memory file means no block at all', () => {
    assert.equal(memoryBlock(firstPrompt(workspace())), null);
  });

  await t.test('memory turned off is not recalled', () => {
    const ws = workspace();
    new MemoryManager(ws).addMemory('a secret');
    fs.writeFileSync(paths.configPath(ws), JSON.stringify({ memoryEnabled: false }));
    assert.equal(memoryBlock(firstPrompt(ws)), null);
  });

  // Memory is the one context source that only ever grows, so it is the one
  // that must not grow the prompt with it.
  await t.test('a runaway memory file degrades to a pointer instead of the contents', () => {
    const ws = workspace();
    const m = new MemoryManager(ws);
    for (let i = 0; i < 60; i++) m.addMemory(`fact number ${i} about this project`);

    const block = memoryBlock(firstPrompt(ws));
    assert.ok(block.includes('1. fact number 0 about this project'));
    assert.doesNotMatch(block, /fact number 59/);
    assert.match(block, /more in .*memory\.md/);
    assert.ok(block.length < 4600, `bounded, got ${block.length}`);
  });
});

test('memory.json is converted, not abandoned', async (t) => {
  t.afterEach(() => { paths.setActiveScope(null); paths.clearPathCache(); });

  await t.test('the old array becomes markdown and the json goes', () => {
    const ws = workspace();
    const legacy = path.join(ws, '.agent', 'memory.json');
    fs.writeFileSync(legacy, JSON.stringify(['knows a thing', 'knows another']));

    assert.equal(migrateMemory(ws).length, 1);
    assert.deepEqual(new MemoryManager(ws).getAllMemories(), ['knows a thing', 'knows another']);
    assert.equal(fs.existsSync(legacy), false);
  });

  await t.test('markdown already written is merged, never replaced', () => {
    const ws = workspace();
    new MemoryManager(ws).addMemory('learned since');
    fs.writeFileSync(path.join(ws, '.agent', 'memory.json'), JSON.stringify(['learned before']));

    migrateMemory(ws);
    assert.deepEqual(new MemoryManager(ws).getAllMemories(), ['learned since', 'learned before']);
  });

  await t.test('unreadable json is left alone rather than deleted', () => {
    const ws = workspace();
    const legacy = path.join(ws, '.agent', 'memory.json');
    fs.writeFileSync(legacy, '{ not json');

    assert.deepEqual(migrateMemory(ws), []);
    assert.equal(fs.existsSync(legacy), true);
  });

  await t.test('running twice does nothing the second time', () => {
    const ws = workspace();
    fs.writeFileSync(path.join(ws, '.agent', 'memory.json'), JSON.stringify(['once']));
    migrateMemory(ws);
    assert.deepEqual(migrateMemory(ws), []);
    assert.deepEqual(new MemoryManager(ws).getAllMemories(), ['once']);
  });
});
