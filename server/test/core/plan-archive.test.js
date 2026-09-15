import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { listPlans, stampOf, titleOf } from '../../src/core/plan-archive.js';
import * as paths from '../../src/core/paths.js';

function workspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'plans-'));
  fs.mkdirSync(path.join(ws, '.agent'), { recursive: true });
  paths.clearPathCache();
  return ws;
}

const write = (ws, name, body) => {
  const dir = paths.ensureDir(paths.planArchiveDir(ws));
  fs.writeFileSync(path.join(dir, name), body);
};

test('stampOf', async (t) => {
  await t.test('reads the archive timestamp back out of the filename', () => {
    assert.deepEqual(stampOf('2026-09-10T14-32-05-plan.md'), new Date('2026-09-10T14:32:05'));
  });

  await t.test('a name that is not ours has no stamp, rather than a wrong one', () => {
    for (const name of ['plan.md', 'notes-2026.md', '', '2026-13-99T99-99-99-plan.md']) {
      assert.equal(stampOf(name), null, name);
    }
  });
});

test('titleOf', async (t) => {
  await t.test('the first heading is what the plan is about', () => {
    assert.equal(titleOf('# Split the bridge in two\n\nbody'), 'Split the bridge in two');
  });

  await t.test('finds it past front matter and blank lines', () => {
    assert.equal(titleOf('\n\n_generated_\n\n## Fix the watchdog\n'), 'Fix the watchdog');
  });

  await t.test('a plan with no heading gets no invented one', () => {
    assert.equal(titleOf('just prose, no heading'), '');
    assert.equal(titleOf(''), '');
    assert.equal(titleOf(null), '');
  });

  await t.test('a very long heading is clipped rather than allowed to wrap the row', () => {
    assert.ok(titleOf(`# ${'x'.repeat(200)}`).length <= 70);
  });
});

test('listPlans', async (t) => {
  t.afterEach(() => { paths.setActiveScope(null); paths.clearPathCache(); });

  await t.test('an empty archive is empty, not an error', () => {
    assert.deepEqual(listPlans(workspace()), []);
  });

  await t.test('newest first, because that is the one you usually want', () => {
    const ws = workspace();
    write(ws, '2026-09-08T09-00-00-plan.md', '# Oldest');
    write(ws, '2026-09-10T14-32-05-plan.md', '# Newest');
    write(ws, '2026-09-09T11-15-00-plan.md', '# Middle');

    assert.deepEqual(listPlans(ws).map((p) => p.title), ['Newest', 'Middle', 'Oldest']);
  });

  await t.test('each entry carries what the picker draws', () => {
    const ws = workspace();
    write(ws, '2026-09-10T14-32-05-plan.md', '# Split the bridge\n\nbody');

    const [plan] = listPlans(ws);
    assert.equal(plan.title, 'Split the bridge');
    assert.equal(plan.name, '2026-09-10T14-32-05-plan.md');
    assert.ok(plan.path.endsWith(plan.name));
    assert.ok(plan.bytes > 0);
    assert.deepEqual(plan.when, new Date('2026-09-10T14:32:05'));
  });

  await t.test('a file dropped in by hand sorts last instead of breaking the order', () => {
    const ws = workspace();
    write(ws, 'my-notes.md', '# Hand written');
    write(ws, '2026-09-10T14-32-05-plan.md', '# Archived');

    assert.deepEqual(listPlans(ws).map((p) => p.title), ['Archived', 'Hand written']);
  });

  await t.test('non-markdown in the folder is ignored', () => {
    const ws = workspace();
    write(ws, '2026-09-10T14-32-05-plan.md', '# Real');
    write(ws, '.DS_Store', 'junk');
    assert.equal(listPlans(ws).length, 1);
  });
});
