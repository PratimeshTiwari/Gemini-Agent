import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DiffEngine } from '../../src/core/diff-engine.js';

/** A workspace with one file in it. Nothing here touches the real tree. */
function workspace(files = { 'src/app.js': 'const a = 1;\nconst b = 2;\n' }) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(ws, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return ws;
}

const read = (ws, rel) => fs.readFileSync(path.join(ws, rel), 'utf8');
const edit = (oldText, newText) => [{ oldText, newText }];

test('generateDiff proposes without touching anything', async (t) => {
  await t.test('the file on disk is unchanged until it is accepted', () => {
    const ws = workspace();
    const engine = new DiffEngine(ws);
    engine.generateDiff('src/app.js', edit('const a = 1;', 'const a = 99;'));

    assert.equal(read(ws, 'src/app.js'), 'const a = 1;\nconst b = 2;\n');
    assert.equal(engine.getPendingDiffs().length, 1);
  });

  await t.test('a new file is reported as new', () => {
    const engine = new DiffEngine(workspace());
    const diff = engine.generateDiff('fresh.js', [{ newText: 'hello\n' }]);
    assert.equal(diff.isNewFile, true);
  });

  // The model routinely quotes code back with the indentation slightly off.
  await t.test('whitespace-fuzzy matching finds a target that was reindented', () => {
    const ws = workspace({ 'a.js': 'function x() {\n    return 1;\n}\n' });
    const engine = new DiffEngine(ws);
    const diff = engine.generateDiff('a.js', edit('function x() {\n  return 1;\n}', 'function x() {\n  return 2;\n}'));
    assert.ok(diff.patch.includes('return 2'));
  });

  await t.test('a target that is not there throws, and nothing is written', () => {
    const ws = workspace();
    const engine = new DiffEngine(ws);
    assert.throws(() => engine.generateDiff('src/app.js', edit('nonexistent', 'x')), /not found/i);
    assert.equal(read(ws, 'src/app.js'), 'const a = 1;\nconst b = 2;\n');
  });
});

test('acceptDiff writes, and leaves a way back', async (t) => {
  await t.test('the file gets the new content', () => {
    const ws = workspace();
    const engine = new DiffEngine(ws);
    const diff = engine.generateDiff('src/app.js', edit('const a = 1;', 'const a = 99;'));
    engine.acceptDiff(diff.id);

    assert.equal(read(ws, 'src/app.js'), 'const a = 99;\nconst b = 2;\n');
    assert.equal(engine.getPendingDiffs().length, 0);
  });

  await t.test('the original is backed up first', () => {
    const ws = workspace();
    const engine = new DiffEngine(ws);
    const diff = engine.generateDiff('src/app.js', edit('const a = 1;', 'const a = 99;'));
    engine.acceptDiff(diff.id);

    const backups = fs.readdirSync(path.join(ws, '.agent', 'backups', 'src'));
    assert.equal(backups.length, 1);
    assert.match(backups[0], /^app\.js\.\d+\.bak$/);
    assert.equal(fs.readFileSync(path.join(ws, '.agent', 'backups', 'src', backups[0]), 'utf8'),
      'const a = 1;\nconst b = 2;\n');
  });

  // The write goes to `<file>.tmp.<n>` and is renamed, so a crash mid-write
  // cannot leave a half-file. The temp must not survive either.
  await t.test('the atomic write leaves no temp file behind', () => {
    const ws = workspace();
    const engine = new DiffEngine(ws);
    const diff = engine.generateDiff('src/app.js', edit('const a = 1;', 'const a = 99;'));
    engine.acceptDiff(diff.id);

    assert.deepEqual(fs.readdirSync(path.join(ws, 'src')), ['app.js']);
  });

  await t.test('a new file and its parent directories are created', () => {
    const ws = workspace();
    const engine = new DiffEngine(ws);
    const diff = engine.generateDiff('deep/nested/new.js', [{ newText: 'export {};\n' }]);
    engine.acceptDiff(diff.id);
    assert.equal(read(ws, 'deep/nested/new.js'), 'export {};\n');
  });

  await t.test('accepting twice is refused rather than applied twice', () => {
    const ws = workspace();
    const engine = new DiffEngine(ws);
    const diff = engine.generateDiff('src/app.js', edit('const a = 1;', 'const a = 99;'));
    engine.acceptDiff(diff.id);
    assert.throws(() => engine.acceptDiff(diff.id), /not found|already/i);
  });

  await t.test('an unknown diff id throws instead of writing somewhere', () => {
    assert.throws(() => new DiffEngine(workspace()).acceptDiff('nope'), /not found/i);
  });
});

// The tools take absolute paths, so this is reachable. `relative(workspace, p)`
// gave `../../../tmp/x` and `resolve(backupDir, that)` put the backup outside
// the backup directory entirely — with workspace /a/b/c, a backup of /tmp/x
// landed at /a/b/tmp/x.bak.
test('backups cannot escape the backup directory', async (t) => {
  await t.test('a file outside the workspace is backed up under _external/', () => {
    const ws = workspace();
    const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'other-')), 'conf.txt');
    fs.writeFileSync(outside, 'original\n');

    const engine = new DiffEngine(ws);
    const diff = engine.generateDiff(outside, edit('original', 'changed'));
    engine.acceptDiff(diff.id);

    assert.equal(fs.readFileSync(outside, 'utf8'), 'changed\n');
    const root = path.join(ws, '.agent', 'backups');
    const found = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        e.isDirectory() ? walk(full) : found.push(full);
      }
    };
    walk(root);
    assert.equal(found.length, 1);
    assert.ok(found[0].startsWith(path.join(root, '_external')), found[0]);
  });

  await t.test('the name never resolves above the backup directory', () => {
    const engine = new DiffEngine('/a/b/c');
    for (const p of ['/tmp/x', '/etc/hosts', '/a/b/other/f.js']) {
      const name = engine._backupName(p);
      assert.ok(!name.startsWith('..'), `${p} -> ${name}`);
      assert.ok(!path.isAbsolute(name), `${p} -> ${name}`);
    }
  });
});

test('rejectDiff and undo', async (t) => {
  await t.test('rejecting leaves the file exactly as it was', () => {
    const ws = workspace();
    const engine = new DiffEngine(ws);
    const diff = engine.generateDiff('src/app.js', edit('const a = 1;', 'const a = 99;'));
    engine.rejectDiff(diff.id);

    assert.equal(read(ws, 'src/app.js'), 'const a = 1;\nconst b = 2;\n');
    assert.equal(engine.getPendingDiffs().length, 0);
  });

  await t.test('undo puts the original content back', () => {
    const ws = workspace();
    const engine = new DiffEngine(ws);
    const diff = engine.generateDiff('src/app.js', edit('const a = 1;', 'const a = 99;'));
    engine.acceptDiff(diff.id);
    const result = engine.undo();

    assert.equal(result.success, true);
    assert.equal(read(ws, 'src/app.js'), 'const a = 1;\nconst b = 2;\n');
  });

  await t.test('undo walks back one edit at a time, newest first', () => {
    const ws = workspace();
    const engine = new DiffEngine(ws);
    engine.acceptDiff(engine.generateDiff('src/app.js', edit('const a = 1;', 'const a = 2;')).id);
    engine.acceptDiff(engine.generateDiff('src/app.js', edit('const b = 2;', 'const b = 3;')).id);

    engine.undo();
    assert.equal(read(ws, 'src/app.js'), 'const a = 2;\nconst b = 2;\n');
    engine.undo();
    assert.equal(read(ws, 'src/app.js'), 'const a = 1;\nconst b = 2;\n');
  });

  await t.test('undo with nothing to undo says so rather than throwing', () => {
    assert.deepEqual(new DiffEngine(workspace()).undo(),
      { success: false, message: 'Nothing to undo' });
  });

  // Deliberate: a created file is emptied rather than deleted, because deleting
  // something the user may have since edited is worse than leaving it empty.
  await t.test('undoing a created file empties it rather than deleting it', () => {
    const ws = workspace();
    const engine = new DiffEngine(ws);
    engine.acceptDiff(engine.generateDiff('new.js', [{ newText: 'hello\n' }]).id);
    engine.undo();

    assert.equal(fs.existsSync(path.join(ws, 'new.js')), true);
    assert.equal(read(ws, 'new.js'), '');
  });
});

test('per-hunk approval', async (t) => {
  const multi = () => workspace({ 'm.js': ['one', 'two', 'three', 'four', 'five',
    'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'].join('\n') + '\n' });

  await t.test('rejecting every hunk writes nothing', () => {
    const ws = multi();
    const engine = new DiffEngine(ws);
    const before = read(ws, 'm.js');
    const diff = engine.generateDiff('m.js', [
      { oldText: 'one', newText: 'ONE' },
      { oldText: 'twelve', newText: 'TWELVE' },
    ]);
    for (const h of diff.hunks) engine.respondToHunk(diff.id, h.id, false);

    assert.equal(read(ws, 'm.js'), before);
    assert.equal(engine.getPendingDiffs().length, 0);
  });

  await t.test('accepting every hunk writes the whole change', () => {
    const ws = multi();
    const engine = new DiffEngine(ws);
    const diff = engine.generateDiff('m.js', [
      { oldText: 'one', newText: 'ONE' },
      { oldText: 'twelve', newText: 'TWELVE' },
    ]);
    for (const h of diff.hunks) engine.respondToHunk(diff.id, h.id, true);

    assert.match(read(ws, 'm.js'), /ONE/);
    assert.match(read(ws, 'm.js'), /TWELVE/);
  });

  await t.test('an unknown hunk throws', () => {
    const ws = multi();
    const engine = new DiffEngine(ws);
    const diff = engine.generateDiff('m.js', [{ oldText: 'one', newText: 'ONE' }]);
    assert.throws(() => engine.respondToHunk(diff.id, 'nope', true), /not found/i);
  });
});
