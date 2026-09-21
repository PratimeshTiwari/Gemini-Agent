/**
 * Which editor is hosting this terminal.
 *
 * Reported from use: `/open agent.md` from a terminal inside Antigravity opened
 * the file in **RStudio**. Nothing was misconfigured — every step behaved as
 * designed and the answer was still wrong:
 *
 *   1. `EDITOR` unset, so the hardcoded `'code'` was used.
 *   2. `code` is not on PATH — installing a VS Code *fork* does not put it there.
 *   3. The fallback `open <file>` asks macOS for the default app for `.md`.
 *
 * None of them asked the question that matters, which the terminal answers
 * plainly: `TERM_PROGRAM=vscode`, and `VSCODE_GIT_ASKPASS_NODE` pointing into
 * the app bundle that launched it.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { hostEditor } from '../../src/core/host-editor.js';

let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'host-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Build a fake app bundle with a launcher where the platform keeps it. */
function bundle({ shape = 'mac', name = 'antigravity-ide' } = {}) {
  const app = join(root, 'Antigravity IDE.app');
  const bin = shape === 'mac'
    ? join(app, 'Contents', 'Resources', 'app', 'bin')
    : join(app, 'bin');
  mkdirSync(bin, { recursive: true });
  const launcher = join(bin, name);
  writeFileSync(launcher, '#!/bin/sh\n');
  chmodSync(launcher, 0o755);

  const helper = join(app, 'Contents', 'Frameworks', 'Helper.app', 'Contents', 'MacOS');
  mkdirSync(helper, { recursive: true });
  return { launcher, askpassNode: join(helper, 'Helper') };
}

describe('hostEditor — a fact, or null', () => {
  test('a VS Code fork is found from the app bundle that launched the terminal', () => {
    const { launcher, askpassNode } = bundle();
    assert.equal(hostEditor({ TERM_PROGRAM: 'vscode', VSCODE_GIT_ASKPASS_NODE: askpassNode }), launcher);
  });

  test('the Linux layout is found too', () => {
    const { launcher, askpassNode } = bundle({ shape: 'linux', name: 'code' });
    assert.equal(hostEditor({ TERM_PROGRAM: 'vscode', VSCODE_GIT_ASKPASS_NODE: askpassNode }), launcher);
  });

  test('VSCODE_GIT_ASKPASS_MAIN works when NODE is absent', () => {
    const { launcher, askpassNode } = bundle();
    assert.equal(hostEditor({ TERM_PROGRAM: 'vscode', VSCODE_GIT_ASKPASS_MAIN: askpassNode }), launcher);
  });

  test('a plain terminal is null, not a guess', () => {
    // A wrong guess here opens the wrong application, which is the bug.
    assert.equal(hostEditor({ TERM_PROGRAM: 'Apple_Terminal' }), null);
    assert.equal(hostEditor({}), null);
  });

  test('vscode with no askpass anchor is null', () => {
    assert.equal(hostEditor({ TERM_PROGRAM: 'vscode' }), null);
  });

  test('an app with no launcher where it should be is null', () => {
    const helper = join(root, 'Empty.app', 'Contents', 'Frameworks', 'H.app', 'Contents', 'MacOS');
    mkdirSync(helper, { recursive: true });
    assert.equal(hostEditor({ TERM_PROGRAM: 'vscode', VSCODE_GIT_ASKPASS_NODE: join(helper, 'H') }), null);
  });

  test('a non-executable file is not a launcher', () => {
    const app = join(root, 'X.app');
    const bin = join(app, 'Contents', 'Resources', 'app', 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'notes.txt'), 'hello');       // readable, not runnable
    const helper = join(app, 'Contents', 'MacOS');
    mkdirSync(helper, { recursive: true });
    assert.equal(hostEditor({ TERM_PROGRAM: 'vscode', VSCODE_GIT_ASKPASS_NODE: join(helper, 'H') }), null);
  });
});

