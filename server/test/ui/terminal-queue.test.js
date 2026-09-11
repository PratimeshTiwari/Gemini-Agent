import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { drainTerminalQueue, failureMarker, failureBody } from '../../src/ui/terminal-queue.js';
import * as paths from '../../src/core/paths.js';

function workspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'termq-'));
  fs.mkdirSync(path.join(ws, '.agent'), { recursive: true });
  paths.clearPathCache();
  return ws;
}

const write = (ws, entries) => {
  const file = paths.ensureParent(paths.terminalQueuePath(ws));
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
};

const failure = (over = {}) => ({
  timestamp: Date.now(), command: 'npm test', cwd: '/work', exitCode: 1,
  output: 'FAIL src/a.test.js\n  expected 1 to equal 2', ...over,
});

test('failureMarker', async (t) => {
  await t.test('is short and unmistakably a reference', () => {
    assert.equal(failureMarker(failure()), '@terminal:npm test');
  });

  await t.test('a long command is clipped, not wrapped into the frame', () => {
    const m = failureMarker(failure({ command: 'npm run build -- --verbose '.repeat(10) }));
    assert.ok(m.length <= 51, `${m.length}: ${m}`);
  });

  await t.test('a multi-line command shows only its first line', () => {
    assert.equal(failureMarker(failure({ command: 'npm test \\\n  --watch' })), '@terminal:npm test \\');
  });
});

test('failureBody is what the model actually reads', async (t) => {
  await t.test('carries the command, the exit code and the output', () => {
    const body = failureBody(failure());
    assert.match(body, /exit 1/);
    assert.match(body, /\$ npm test/);
    assert.match(body, /expected 1 to equal 2/);
    assert.match(body, /Working directory: \/work/);
  });

  // A full build log is tens of thousands of characters, and every one of them
  // is typed into a browser chat tab.
  await t.test('a huge log is cut to its tail, where the failure is', () => {
    const body = failureBody(failure({ output: `${'x'.repeat(50000)}\nTHE ACTUAL ERROR` }));
    assert.ok(body.length < 2300, `${body.length} chars`);
    assert.match(body, /THE ACTUAL ERROR/);
  });

  await t.test('no output at all still produces something readable', () => {
    assert.match(failureBody(failure({ output: '' })), /no output captured/);
  });
});

test('drainTerminalQueue', async (t) => {
  t.afterEach(() => { paths.setActiveScope(null); paths.clearPathCache(); });

  await t.test('an empty queue is the normal case, not an error', () => {
    assert.deepEqual(drainTerminalQueue(workspace()), []);
  });

  await t.test('a failure comes back as an attachment', () => {
    const ws = workspace();
    write(ws, [failure()]);
    const [got] = drainTerminalQueue(ws);
    assert.equal(got.command, 'npm test');
    assert.equal(got.exitCode, 1);
    assert.match(got.text, /expected 1 to equal 2/);
  });

  // Offered once. Reading it again would re-suggest a failure the user already
  // decided to ignore.
  await t.test('the queue is cleared on read', () => {
    const ws = workspace();
    write(ws, [failure()]);
    assert.equal(drainTerminalQueue(ws).length, 1);
    assert.equal(drainTerminalQueue(ws).length, 0);
  });

  await t.test('a half-written line from an append in flight is skipped', () => {
    const ws = workspace();
    fs.writeFileSync(paths.ensureParent(paths.terminalQueuePath(ws)),
      `${JSON.stringify(failure())}\n{"command":"broken`);
    assert.equal(drainTerminalQueue(ws).length, 1);
  });

  await t.test('a success that slipped through is ignored', () => {
    const ws = workspace();
    write(ws, [failure({ exitCode: 0 }), failure({ command: 'real failure' })]);
    const got = drainTerminalQueue(ws);
    assert.deepEqual(got.map((g) => g.command), ['real failure']);
  });

  // A broken watcher can fail every second. A hundred markers in the input box
  // is not a useful thing to hand anyone.
  await t.test('a storm is cut to the most recent few', () => {
    const ws = workspace();
    write(ws, Array.from({ length: 50 }, (_, i) => failure({ command: `cmd ${i}` })));
    const got = drainTerminalQueue(ws);
    assert.equal(got.length, 3);
    assert.equal(got[2].command, 'cmd 49', 'and they are the newest');
  });
});
