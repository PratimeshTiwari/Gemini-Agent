/**
 * `/open` has to open what is there, and say so when nothing is.
 *
 * Reported from use: `/open plan.md` answered
 * `Opened /Users/…/Gemini-Agent/plan.md in antigravity-ide.` for a file that
 * did not exist. It ran the editor and reported success whenever the *editor
 * process* exited 0 — and an editor handed a missing path opens an empty
 * buffer and exits 0. So a typo reported success and created a new empty file
 * named after the typo.
 *
 * The same fault is already described in a comment at that call site, one
 * level up: the old version reported "Opened <path>" whatever happened, so
 * `code` not being installed read exactly like success. That was fixed for the
 * editor and not for the file.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { resolveOpenTarget } from '../../src/ui/hooks/use-slash-commands.js';

describe('resolveOpenTarget', () => {
  let ws;
  const setup = () => {
    ws = mkdtempSync(join(tmpdir(), 'open-'));
    writeFileSync(join(ws, 'real.md'), '# here');
    mkdirSync(join(ws, 'sub'));
    return ws;
  };

  test('a file that is there resolves and exists', () => {
    const w = setup();
    const r = resolveOpenTarget(w, 'real.md');
    assert.equal(r.abs, join(w, 'real.md'));
    assert.equal(r.exists, true);
    rmSync(w, { recursive: true, force: true });
  });

  // The reported bug. Without this the command reports success on a typo.
  test('a file that is not there is reported missing, not opened', () => {
    const w = setup();
    assert.equal(resolveOpenTarget(w, 'plan.md').exists, false);
    assert.equal(resolveOpenTarget(w, 'plna.md').exists, false);
    rmSync(w, { recursive: true, force: true });
  });

  // Opening a directory is a normal thing to want, and every editor here does
  // it. Treating it as missing would be a second wrong answer.
  test('a directory counts as existing', () => {
    const w = setup();
    assert.equal(resolveOpenTarget(w, 'sub').exists, true);
    assert.equal(resolveOpenTarget(w, '.').exists, true);
    rmSync(w, { recursive: true, force: true });
  });

  test('an absolute path is left alone', () => {
    const w = setup();
    const r = resolveOpenTarget('/somewhere/else', join(w, 'real.md'));
    assert.equal(r.abs, join(w, 'real.md'));
    assert.equal(r.exists, true);
    rmSync(w, { recursive: true, force: true });
  });

  /*
   * `~` is the shell's, and nothing expands it before this runs — so without
   * handling it here, `/open ~/notes.md` resolves to a literal directory
   * called `~` inside the workspace and reports it missing, which is true but
   * for the wrong reason and unfixable by the user.
   */
  test('~ is expanded, because no shell did it for us', () => {
    const w = setup();
    assert.equal(resolveOpenTarget(w, '~').abs, homedir());
    assert.ok(resolveOpenTarget(w, '~/x.md').abs.startsWith(homedir()));
    assert.ok(!resolveOpenTarget(w, '~/x.md').abs.includes('~'));
    rmSync(w, { recursive: true, force: true });
  });

  test('.. is resolved rather than left in the path', () => {
    const w = setup();
    assert.ok(!resolveOpenTarget(w, 'sub/../real.md').abs.includes('..'));
    assert.equal(resolveOpenTarget(w, 'sub/../real.md').exists, true);
    rmSync(w, { recursive: true, force: true });
  });

  test('empty and nullish targets do not throw', () => {
    const w = setup();
    for (const bad of ['', '   ', null, undefined]) {
      assert.doesNotThrow(() => resolveOpenTarget(w, bad));
    }
    rmSync(w, { recursive: true, force: true });
  });
});
