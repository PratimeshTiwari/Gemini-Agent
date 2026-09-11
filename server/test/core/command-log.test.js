import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  logCommand, readCommands, listCommandDays, countToday, dayStamp, commandLogPath,
} from '../../src/core/command-log.js';
import * as paths from '../../src/core/paths.js';

function workspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cmdlog-'));
  fs.mkdirSync(path.join(ws, '.agent'), { recursive: true });
  paths.clearPathCache();
  return ws;
}

test('what gets recorded', async (t) => {
  t.afterEach(() => { paths.setActiveScope(null); paths.clearPathCache(); });

  await t.test('a command that ran', () => {
    const ws = workspace();
    logCommand(ws, { command: 'npm test', cwd: ws, outcome: 'ran', exitCode: 0 });

    const [entry] = readCommands(ws);
    assert.equal(entry.command, 'npm test');
    assert.equal(entry.outcome, 'ran');
    assert.equal(entry.exitCode, 0);
    assert.match(entry.at, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(entry.session, 'so a day can be read back session by session');
  });

  // `git push --force` does not fail, so the failure log never sees it. A
  // command that succeeded is exactly the one an audit wants.
  await t.test('success is recorded, not only failure', () => {
    const ws = workspace();
    logCommand(ws, { command: 'git push --force', outcome: 'ran', exitCode: 0 });
    assert.equal(readCommands(ws).length, 1);
  });

  // What the agent *tried* to do is the interesting half.
  await t.test('blocked and rejected commands are kept too', () => {
    const ws = workspace();
    logCommand(ws, { command: 'rm -rf /', outcome: 'blocked', reason: 'outside the workspace' });
    logCommand(ws, { command: 'npm publish', outcome: 'rejected' });

    assert.deepEqual(readCommands(ws).map((e) => e.outcome), ['blocked', 'rejected']);
    assert.match(readCommands(ws)[0].reason, /outside the workspace/);
  });

  await t.test('in the order they were run', () => {
    const ws = workspace();
    for (const c of ['one', 'two', 'three']) logCommand(ws, { command: c, outcome: 'ran' });
    assert.deepEqual(readCommands(ws).map((e) => e.command), ['one', 'two', 'three']);
  });
});

test('a file per day, because that is how people look for it', async (t) => {
  t.afterEach(() => { paths.setActiveScope(null); paths.clearPathCache(); });

  await t.test('today lands in today', () => {
    const ws = workspace();
    logCommand(ws, { command: 'ls', outcome: 'ran' });
    assert.ok(fs.existsSync(commandLogPath(ws, dayStamp())));
  });

  await t.test('days are listed newest first', () => {
    const ws = workspace();
    const dir = paths.ensureDir(path.dirname(commandLogPath(ws)));
    for (const d of ['2026-09-09', '2026-09-11', '2026-09-10']) {
      fs.writeFileSync(path.join(dir, `${d}.jsonl`), JSON.stringify({ command: 'x', outcome: 'ran' }) + '\n');
    }
    assert.deepEqual(listCommandDays(ws), ['2026-09-11', '2026-09-10', '2026-09-09']);
  });

  await t.test('an untouched workspace has no days and no error', () => {
    const ws = workspace();
    assert.deepEqual(listCommandDays(ws), []);
    assert.deepEqual(readCommands(ws), []);
    assert.equal(countToday(ws), 0);
  });

  await t.test('dayStamp is local, not UTC — it is the day you would look under', () => {
    assert.equal(dayStamp(new Date(2026, 8, 11, 23, 30)), '2026-09-11');
  });
});

test('it never gets in the way', async (t) => {
  // A failure to write the audit log must not fail the command, and must
  // certainly not fail the turn.
  await t.test('an unwritable location is swallowed', () => {
    assert.doesNotThrow(() => logCommand('/proc/nonexistent/nope', { command: 'ls', outcome: 'ran' }));
  });

  await t.test('a half-written line from an append in flight is skipped', () => {
    const ws = workspace();
    logCommand(ws, { command: 'good', outcome: 'ran' });
    fs.appendFileSync(commandLogPath(ws), '{"command":"truncated');
    assert.deepEqual(readCommands(ws).map((e) => e.command), ['good']);
  });

  await t.test('a line with no command is not a command', () => {
    const ws = workspace();
    fs.writeFileSync(paths.ensureParent(commandLogPath(ws)), `${JSON.stringify({ at: 'x' })}\n`);
    assert.deepEqual(readCommands(ws), []);
  });
});
