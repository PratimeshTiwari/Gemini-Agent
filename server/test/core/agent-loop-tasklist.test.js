/**
 * Handing the checklist to the side panel.
 *
 * The terminal reads `.agent/artifacts/task.md` off disk on a timer. A browser
 * page cannot, so the panel was the one surface where the agent's own plan was
 * invisible — and that plan is the half of the feature the user is meant to be
 * watching. The server is the only side that can read the file, so it sends it.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AgentLoop } from '../../src/core/agent-loop.js';
import * as paths from '../../src/core/paths.js';

let ws;
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'tl-')); });
afterEach(() => rmSync(ws, { recursive: true, force: true }));

/** Just enough loop to call `_sendTaskList`, with the panel recorded. */
function loop(taskMd) {
  if (taskMd !== undefined) {
    const file = paths.artifactPath(ws, 'task.md');
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, taskMd);
  }
  const sent = [];
  const l = Object.create(AgentLoop.prototype);
  l.workspace = ws;
  l.callbacks = { sendToPanel: (m) => sent.push(m) };
  return { l, sent };
}

describe('_sendTaskList', () => {
  test('a checklist is sent as items, with the tally', () => {
    const { l, sent } = loop('# Plan\n\n- [x] Read the bridge\n- [ ] Render it\n- [ ] Test it\n');
    l._sendTaskList();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'task_list');
    assert.deepEqual(sent[0].payload.items, [
      { done: true, text: 'Read the bridge' },
      { done: false, text: 'Render it' },
      { done: false, text: 'Test it' },
    ]);
    assert.equal(sent[0].payload.done, 1);
    assert.equal(sent[0].payload.total, 3);
  });

  test('prose around the list is not sent — only the checklist is', () => {
    const { l, sent } = loop('Some preamble the model wrote.\n\n- [ ] The only item\n\nA closing note.\n');
    l._sendTaskList();
    assert.deepEqual(sent[0].payload.items, [{ done: false, text: 'The only item' }]);
  });

  test('`*` bullets and capital X count too', () => {
    const { l, sent } = loop('* [X] one\n* [ ] two\n');
    l._sendTaskList();
    assert.equal(sent[0].payload.done, 1);
    assert.equal(sent[0].payload.total, 2);
  });

  // An empty row reads as "the agent has no plan" when it means "the agent
  // never wrote one".
  test('no file, no message', () => {
    const { l, sent } = loop();
    l._sendTaskList();
    assert.deepEqual(sent, []);
  });

  test('a file with no checklist in it sends nothing', () => {
    const { l, sent } = loop('Just some notes, no boxes.\n');
    l._sendTaskList();
    assert.deepEqual(sent, []);
  });

  test('an empty file sends nothing', () => {
    const { l, sent } = loop('   \n\n');
    l._sendTaskList();
    assert.deepEqual(sent, []);
  });

  // A finished turn must not be disturbed by an unreadable artifact.
  test('no callbacks is not a crash', () => {
    const { l } = loop('- [ ] x\n');
    l.callbacks = null;
    assert.doesNotThrow(() => l._sendTaskList());
  });
});
