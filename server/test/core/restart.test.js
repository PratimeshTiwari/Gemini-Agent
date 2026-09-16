/**
 * Handing the workspace over, which two front-ends now share.
 *
 * `/workspace <path>` and the side panel's `⌂` are the same act, and the CLI's
 * version used to be the only one — its validation, supervisor check and
 * handover file lived inside a React hook, where the bridge could not reach
 * them. Sharing the code is the point; these pin what it answers, because the
 * three failure modes are all things a caller has to be able to *say* rather
 * than throw.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { prepareWorkspaceSwitch, leaveWhenIdle, RESTART_EXIT_CODE } from '../../src/core/restart.js';
import { nextWorkspacePath } from '../../src/core/paths.js';

let home, target;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'rst-home-'));
  target = mkdtempSync(join(tmpdir(), 'rst-ws-'));
  process.env.AGENT_CLI_HOME = home;
});
afterEach(() => {
  delete process.env.AGENT_CLI_HOME;
  for (const d of [home, target]) rmSync(d, { recursive: true, force: true });
});

const supervised = { AGENT_CLI_SUPERVISED: '1' };

describe('prepareWorkspaceSwitch', () => {
  test('a usable directory is written out for the supervisor', () => {
    const out = prepareWorkspaceSwitch(target, { env: supervised });
    assert.equal(out.ok, true);
    assert.equal(out.target, target);
    // A file, because the child cannot rewrite its own argv.
    assert.equal(readFileSync(nextWorkspacePath(), 'utf8'), target);
  });

  test('a path that is not there is refused, and nothing is handed over', () => {
    const out = prepareWorkspaceSwitch('/no/such/place', { env: supervised });
    assert.equal(out.ok, false);
    assert.match(out.error, /no such directory/i);
    assert.match(out.error, /no\/such\/place/, 'it should name the path it refused');
    assert.throws(() => readFileSync(nextWorkspacePath(), 'utf8'));
  });

  test('a file is not a workspace', () => {
    const file = join(target, 'a.txt');
    writeFileSync(file, 'x');
    assert.equal(prepareWorkspaceSwitch(file, { env: supervised }).ok, false);
  });

  // Without a supervisor the process would exit and never come back, which is
  // a worse outcome than refusing.
  test('no supervisor means say so rather than exit into nothing', () => {
    const out = prepareWorkspaceSwitch(target, { env: {} });
    assert.equal(out.ok, false);
    assert.match(out.error, /supervisor/);
    assert.match(out.error, /--workspace/, 'it should say how to do it by hand');
  });

  test('~ is expanded, the way the CLI accepts it', () => {
    const out = prepareWorkspaceSwitch('~', { env: supervised });
    assert.equal(out.ok, true);
    assert.ok(!out.target.startsWith('~'));
  });
});

describe('leaveWhenIdle — never out from under a running turn', () => {
  test('an idle agent goes at once', () => {
    let left = null;
    leaveWhenIdle(RESTART_EXIT_CODE, { agentLoop: { isProcessing: false }, exit: (c) => { left = c; } });
    assert.equal(left, RESTART_EXIT_CODE);
  });

  test('a busy agent waits, and announces that it is waiting', async () => {
    const loop = { isProcessing: true };
    let left = null;
    let announced = false;
    leaveWhenIdle(RESTART_EXIT_CODE, { agentLoop: loop, exit: (c) => { left = c; } },
      { announce: () => { announced = true; } });

    assert.equal(left, null, 'it left mid-turn — the reply would never be drawn');
    assert.equal(announced, true);

    loop.isProcessing = false;
    await new Promise((r) => setTimeout(r, 900));
    assert.equal(left, RESTART_EXIT_CODE, 'it never noticed the turn had finished');
  });
});

describe('the restart code has one definition', () => {
  // Read, not imported. `src/index.js` is the bin: importing it *runs* the
  // supervisor, which spawns main.js and never returns — the landmine
  // CLAUDE.md warns about for `node --test src/`, walked into while writing
  // this very test. The source text answers the question without starting a
  // process.
  test('the supervisor imports the constant rather than declaring its own', () => {
    const shim = readFileSync(new URL('../../src/index.js', import.meta.url), 'utf8');
    assert.doesNotMatch(
      shim,
      /^export const RESTART_EXIT_CODE\s*=/m,
      'the shim declared its own copy again — two numbers that must agree',
    );
    assert.match(shim, /RESTART_EXIT_CODE.*from '\.\/core\/restart\.js'/);
  });

  test('it is the value the supervisor actually checks for', () => {
    assert.equal(RESTART_EXIT_CODE, 75);
  });
});
