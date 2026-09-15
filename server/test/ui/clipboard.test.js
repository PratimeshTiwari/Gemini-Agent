/**
 * The clipboard, and refusing to pretend.
 *
 * Same rule as `folder-picker.js`: a chord that silently does nothing is worse
 * than no chord, because people press it twice and conclude the tool is broken.
 * So `canCopy()` is a fact about this machine, and `ctrl+y` says so when the
 * answer is no rather than appearing to work.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { clipboardCommand, canCopy, copyToClipboard, writeThrough } from '../../src/ui/clipboard.js';

describe('clipboardCommand — what this machine can do', () => {
  test('it answers with a command or with null, never a guess', () => {
    const target = clipboardCommand();
    if (target === null) {
      assert.equal(canCopy(), false);
      return;
    }
    assert.equal(typeof target.cmd, 'string');
    assert.ok(Array.isArray(target.args));
    assert.equal(canCopy(), true);
  });

  test('macOS is answered without probing PATH', { skip: process.platform !== 'darwin' }, () => {
    assert.deepEqual(clipboardCommand(), { cmd: 'pbcopy', args: [] });
  });
});

describe('writeThrough — a failed copy is a false, not a crash', () => {
  // Deliberately NOT against the real clipboard. Running the tests must not
  // overwrite what the person running them had copied — which on this app could
  // be an image they were about to attach with `/paste-image`.
  const sink = { cmd: 'cat', args: [] };

  test('text goes through a pipe, so length and quoting cannot bite', async () => {
    // Longer than any platform's argv limit, and containing everything that
    // would have to be escaped if this were built into a shell string.
    const nasty = `${'x'.repeat(200_000)}\n$(rm -rf /) \`backtick\` 'quote' "double" \\ | ; &`;
    assert.equal(await writeThrough(sink, nasty), true);
  });

  test('an empty string is a copy, not an error', async () => {
    assert.equal(await writeThrough(sink, ''), true);
  });

  test('null and undefined do not throw', async () => {
    assert.equal(await writeThrough(sink, undefined), true);
    assert.equal(await writeThrough(sink, null), true);
  });

  test('a command that is not there resolves false', async () => {
    assert.equal(await writeThrough({ cmd: 'no-such-clipboard-helper', args: [] }, 'x'), false);
  });

  test('a command that fails resolves false', async () => {
    assert.equal(await writeThrough({ cmd: 'false', args: [] }, 'x'), false);
  });

  test('copyToClipboard refuses rather than throws when there is no helper', async () => {
    // Not exercised against a real helper here, for the same reason as above:
    // calling it on macOS would put "x" on the tester's clipboard. The path
    // that matters is the one with nothing to call.
    if (canCopy()) return;
    assert.equal(await copyToClipboard('x'), false);
  });
});
