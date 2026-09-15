/**
 * Aiming an editor, and admitting when you cannot.
 *
 * `openInEditor` branched on `editor === 'code'` — the exact string — while
 * `config.editor` defaults to `process.env.EDITOR`, which is commonly an
 * absolute path. Measured before the fix:
 *
 *     --editor code                 ->  code --goto /path/widget.js:2:1
 *     --editor /usr/local/bin/code  ->  code /path/widget.js       (no line)
 *
 * The line was dropped silently, and the tool reported "Opened widget.js at
 * line 2" either way — so the model was told navigation had happened when it
 * had not, and took its next step believing the user was looking at line 2.
 * That second half is the worse one.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { editorCommand } from '../../../src/mcp/tools/open-in-editor.js';

const FILE = '/w/widget.js';

describe('an editor is recognised by what it is, not how it was spelled', () => {
  for (const spelling of ['code', '/usr/local/bin/code', '/opt/vscode/bin/code']) {
    test(`${spelling} takes --goto`, () => {
      const { command, aimed, name } = editorCommand(spelling, FILE, 2);
      assert.equal(name, 'code');
      assert.equal(aimed, true);
      assert.match(command, /--goto "\/w\/widget\.js:2:1"/);
    });
  }

  test('a Windows path is split even on a POSIX host', () => {
    // `path.basename` is the platform's, so backslashes would survive here and
    // the whole string would read as one filename.
    const { name, aimed } = editorCommand('C:\\Program Files\\Microsoft VS Code\\code.cmd', FILE, 2);
    assert.equal(name, 'code');
    assert.equal(aimed, true);
  });

  test('the forks are aimed the same way', () => {
    for (const fork of ['cursor', 'codium', 'windsurf', 'code-insiders']) {
      assert.equal(editorCommand(fork, FILE, 7).aimed, true, `${fork} lost its line`);
    }
  });

  test('vim and sublime each get their own syntax', () => {
    assert.match(editorCommand('/opt/n/bin/nvim', FILE, 9).command, /\+9 "\/w\/widget\.js"/);
    assert.match(editorCommand('subl', FILE, 9).command, /"\/w\/widget\.js:9"/);
  });
});

describe('an editor that cannot be aimed says so', () => {
  test('no flag is invented for one we do not know', () => {
    const { command, aimed } = editorCommand('nano', FILE, 2);
    assert.equal(aimed, false, 'a made-up flag opens a file called "+2"');
    assert.equal(command, '"nano" "/w/widget.js"');
  });

  test('with no line asked for, nothing was missed', () => {
    assert.equal(editorCommand('code', FILE).aimed, false);
    assert.equal(editorCommand('nano', FILE).aimed, false);
  });
});

describe('the command is quoted', () => {
  test('an editor path containing a space survives', () => {
    const { command } = editorCommand('/Applications/My Editor/bin/code', FILE, 3);
    assert.match(command, /^"\/Applications\/My Editor\/bin\/code" /);
  });
});
