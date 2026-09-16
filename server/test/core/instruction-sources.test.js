import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describeInstructionSources } from '../../src/core/instruction-sources.js';

let ws;
before(() => {
  ws = mkdtempSync(join(tmpdir(), 'src-'));
  mkdirSync(join(ws, '.agent', 'skills'), { recursive: true });
});
after(() => rmSync(ws, { recursive: true, force: true }));

/** Just enough AgentLoop for the report to read. */
const loop = (over = {}) => ({
  workspace: ws,
  skillFolders: [],
  memoryManager: { getAllMemories: () => [], isMemoryEnabled: () => true },
  promptBuilder: { lastAgentMdFiles: [] },
  ...over,
});

const find = (rows, group) => rows.filter((r) => r.group === group);

describe('describeInstructionSources — show the walk', () => {
  test('before the first prompt it says so rather than guessing', () => {
    const rows = describeInstructionSources(loop({ promptBuilder: {} }));
    assert.equal(find(rows, 'AGENT.md')[0].state, 'pending');
  });

  test('no AGENT.md anywhere is reported as absent, not as an error', () => {
    const rows = describeInstructionSources(loop());
    assert.equal(find(rows, 'AGENT.md')[0].state, 'absent');
  });

  /**
   * The finding this whole track came from: the stock template is not empty, so
   * it loads, and it is sent as the project's context with nobody able to see it.
   */
  test('an unedited template is named as one', () => {
    const rows = describeInstructionSources(loop({
      promptBuilder: { lastAgentMdFiles: [
        { path: join(ws, 'AGENT.md'), bytes: 740, state: 'template' },
      ] },
    }));
    const row = find(rows, 'AGENT.md')[0];
    assert.equal(row.state, 'template');
    assert.match(row.detail, /unedited template/);
    assert.match(row.detail, /sent as your project context/);
  });

  test('an unreadable file is reported, not silently dropped', () => {
    const rows = describeInstructionSources(loop({
      promptBuilder: { lastAgentMdFiles: [
        { path: join(ws, 'AGENT.md'), bytes: 0, state: 'unreadable', detail: 'EACCES' },
      ] },
    }));
    assert.equal(find(rows, 'AGENT.md')[0].state, 'unreadable');
    assert.match(find(rows, 'AGENT.md')[0].detail, /EACCES/);
  });

  test('memory reports its count, and says when it is switched off', () => {
    writeFileSync(join(ws, '.agent', 'memory.md'), '- one\n- two\n');
    const on = describeInstructionSources(loop({
      memoryManager: { getAllMemories: () => ['a', 'b'], isMemoryEnabled: () => true },
    }));
    assert.equal(find(on, 'memory')[0].state, 'loaded');
    assert.match(find(on, 'memory')[0].detail, /2 facts/);

    const off = describeInstructionSources(loop({
      memoryManager: { getAllMemories: () => ['a'], isMemoryEnabled: () => false },
    }));
    assert.equal(find(off, 'memory')[0].state, 'off');
  });

  /**
   * `/skills dir add` validates once, at the door. Nothing re-checks, so a
   * folder that is later deleted contributes nothing and said nothing.
   */
  test('a configured skill folder that has gone is flagged', () => {
    const rows = describeInstructionSources(loop({ skillFolders: ['/no/such/place'] }));
    const gone = find(rows, 'skills').find((r) => r.label.includes('/no/such/place'));
    assert.ok(gone, 'the missing folder must appear');
    assert.equal(gone.state, 'missing');
    assert.match(gone.detail, /not there any more/);
  });

  test('the walked directories that do not exist are not listed as problems', () => {
    // Every level between the code and the root is a candidate; most are absent
    // by design, and listing them would bury the one that matters.
    const rows = describeInstructionSources(loop());
    assert.equal(find(rows, 'skills').filter((r) => r.state === 'missing').length, 0);
  });

  test('paths are shortened against the workspace', () => {
    const rows = describeInstructionSources(loop({
      promptBuilder: { lastAgentMdFiles: [{ path: join(ws, 'AGENT.md'), bytes: 10, state: 'loaded' }] },
    }));
    assert.equal(find(rows, 'AGENT.md')[0].label, 'AGENT.md');
  });

  test('no agent loop is an empty report, not a throw', () => {
    assert.deepEqual(describeInstructionSources(null), []);
  });
});
