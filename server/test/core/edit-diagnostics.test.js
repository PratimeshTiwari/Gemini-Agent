/**
 * The Problems panel, attached to the edit that may have caused it.
 *
 * `get_diagnostics` has been named in the per-turn anchor on every single turn
 * and called **zero times in 41 sessions**. That is not forgetting — the model
 * is told it exists more often than almost anything else. It is that a tool
 * answers a question the model has to think to ask, and "did my edit just break
 * something?" is one it does not think to ask precisely when it matters.
 *
 * Cursor's answer is not a tool: after an edit it passes the file through the
 * linter and puts the result in the **edit's own tool result**.
 *
 * The timing is the whole difficulty. The companion debounces
 * `onDidChangeDiagnostics` by 1,500ms — deliberately, because it fires
 * continuously while a project indexes — so reading the file the instant an edit
 * lands returns the state *before* the edit. Reporting that as "no new problems"
 * is a confident lie about the one thing this exists to check.
 *
 * Every test here writes its own `diagnostics.json`. The first probe of this
 * module used the live one and appeared to show a bug that did not exist: the
 * companion rewrote the file mid-poll, which is the panel catching up and
 * exactly what the code is waiting for.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { diagnosticsAfterEdit } from '../../src/core/edit-diagnostics.js';

const FILE = 'server/src/thing.js';

function workspace(t, panel) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (panel !== undefined) {
    fs.mkdirSync(path.join(dir, '.agent', 'state'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.agent', 'state', 'diagnostics.json'),
      JSON.stringify(panel),
    );
  }
  return dir;
}

const problem = (over) => ({
  file: FILE, line: 12, column: 3, severity: 'error',
  message: 'x is not defined', source: 'ts', ...over,
});

test('it refuses to claim what it cannot know', async (t) => {
  await t.test('no companion at all costs nothing and says nothing', async (t2) => {
    const ws = workspace(t2, undefined);
    assert.equal(await diagnosticsAfterEdit(ws, FILE, Date.now(), { timeoutMs: 50 }), null);
  });

  /*
   * The case the debounce creates, and the reason this is not a plain read.
   * Silence is the honest answer to "the panel has not looked yet"; "no errors"
   * would be a claim about a file it has not seen since the edit.
   */
  await t.test('a panel older than the edit is silent, not reassuring', async (t2) => {
    const ws = workspace(t2, { timestamp: 1000, problems: [] });
    const out = await diagnosticsAfterEdit(ws, FILE, 5000, { timeoutMs: 120 });
    assert.equal(out, null);
  });

  await t.test('an unreadable panel is silent', async (t2) => {
    const ws = workspace(t2, { timestamp: 9000, problems: [] });
    fs.writeFileSync(path.join(ws, '.agent', 'state', 'diagnostics.json'), '{ broken');
    assert.equal(await diagnosticsAfterEdit(ws, FILE, 1000, { timeoutMs: 120 }), null);
  });

  // It waits for evidence rather than for a duration: the panel catching up
  // mid-poll is the normal case, not a race.
  await t.test('it waits for the panel to catch up, then reports', async (t2) => {
    const ws = workspace(t2, { timestamp: 1000, problems: [] });
    const target = path.join(ws, '.agent', 'state', 'diagnostics.json');
    setTimeout(() => fs.writeFileSync(target, JSON.stringify({
      timestamp: 9000, problems: [problem()],
    })), 60);
    const out = await diagnosticsAfterEdit(ws, FILE, 5000, { timeoutMs: 2000 });
    assert.ok(out, 'gave up before the debounce could fire');
    assert.match(out, /x is not defined/);
  });
});

test('what it reports once the panel is current', async (t) => {
  const fresh = (problems) => ({ timestamp: 9000, problems });

  await t.test('errors and warnings for this file', async (t2) => {
    const ws = workspace(t2, fresh([
      problem(),
      problem({ severity: 'warning', line: 40, message: 'unused import' }),
    ]));
    const out = await diagnosticsAfterEdit(ws, FILE, 1000, { timeoutMs: 120 });
    assert.match(out, /error .*thing\.js:12:3 — x is not defined \(ts\)/);
    assert.match(out, /warning .*:40/);
  });

  /*
   * Hints are not findings. A real Problems panel on this repo is mostly
   * `'req' is declared but its value is never read` — true, harmless, and seven
   * of them in one file. Feeding that back after every edit trains the model to
   * ignore the block, and then the one time it says `error` it is ignored too.
   */
  await t.test('hints are filtered out', async (t2) => {
    const ws = workspace(t2, fresh([
      problem({ severity: 'hint', message: "'req' is declared but its value is never read." }),
      problem({ severity: 'information', message: 'consider const' }),
    ]));
    const out = await diagnosticsAfterEdit(ws, FILE, 1000, { timeoutMs: 120 });
    assert.match(out, /No errors or warnings/);
    assert.doesNotMatch(out, /never read/);
  });

  await t.test('another file’s problems are not this edit’s', async (t2) => {
    const ws = workspace(t2, fresh([problem({ file: 'server/src/other.js' })]));
    const out = await diagnosticsAfterEdit(ws, FILE, 1000, { timeoutMs: 120 });
    assert.match(out, /No errors or warnings/);
    assert.doesNotMatch(out, /other\.js/);
  });

  // The model writes one spelling and the panel another. The same file twice is
  // not two files.
  await t.test('./ and absolute spellings are the same file', async (t2) => {
    for (const spelling of [`./${FILE}`, `/Users/x/repo/${FILE}`]) {
      const ws = workspace(t2, fresh([problem({ file: spelling })]));
      const out = await diagnosticsAfterEdit(ws, FILE, 1000, { timeoutMs: 120 });
      assert.match(out, /x is not defined/, `missed under spelling ${spelling}`);
    }
  });

  await t.test('a clean file says so, which is the useful half', async (t2) => {
    const ws = workspace(t2, fresh([]));
    const out = await diagnosticsAfterEdit(ws, FILE, 1000, { timeoutMs: 120 });
    assert.match(out, /No errors or warnings after this edit/);
  });

  await t.test('a flood is capped rather than pasted whole', async (t2) => {
    const many = Array.from({ length: 40 }, (_, i) => problem({ line: i + 1 }));
    const ws = workspace(t2, fresh(many));
    const out = await diagnosticsAfterEdit(ws, FILE, 1000, { timeoutMs: 120 });
    assert.match(out, /… 20 more/);
    assert.ok(out.split('\n').length < 26, 'the whole panel went into the prompt');
  });
});

test('the loop attaches it only to an edit that landed', () => {
  const src = fs.readFileSync(
    new URL('../../src/core/agent-loop.js', import.meta.url), 'utf8',
  );
  assert.match(src, /diagnosticsAfterEdit\(this\.workspace, call\.args\?\.path, editedAt\)/);
  // A rejected diff changed nothing, so attaching problems to it would read as
  // the rejection having caused them.
  assert.match(src, /const applied = toolResults\[i\]\?\.result\?\.status === 'applied'/);
  const i = src.indexOf('diagnosticsAfterEdit(this.workspace');
  assert.ok(src.lastIndexOf('if (applied)', i) !== -1, 'attached without checking it applied');
});
