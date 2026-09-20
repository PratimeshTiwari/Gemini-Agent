/**
 * The startup migration, which moves the user's data.
 *
 * `migrate-reviews.test.js` covered one narrow rename. The rest of
 * `migrate.js` — 355 lines that `renameSync` a person's config, their
 * instructions, their backups and their logs into a new layout, on startup,
 * before anything is on screen — sat at **46% line coverage** and had no test
 * of its own.
 *
 * That combination is the one this repo has been bitten by before: `diff-engine.js`
 * was 358 lines with no tests and turned out to be writing backups outside the
 * backup directory. Nothing was wrong here — all four claims below were probed
 * against the real code first and all four held — so this is the probe made
 * permanent rather than a bug report. The failure it guards against is silent
 * and unrecoverable: a migration that clobbers is a migration that has already
 * destroyed the thing it overwrote by the time anyone notices.
 *
 * The legacy layout is taken from `migrateWorkspace`'s own plan, not invented.
 * A first attempt used `.gemini/sessions/`, which never existed — sessions
 * lived in the *home* directory and `migrateHome` handles them — and that
 * fixture made correct code look broken.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateWorkspace } from '../../src/core/migrate.js';
import * as paths from '../../src/core/paths.js';

/** The pre-`.agent/` layout, as `migrateWorkspace`'s plan describes it. */
function legacyWorkspace() {
  const ws = fs.mkdtempSync(join(tmpdir(), 'mig-'));
  fs.mkdirSync(join(ws, '.gemini'), { recursive: true });
  fs.writeFileSync(join(ws, '.gemini', 'rules.md'), 'MY PRECIOUS RULES');
  fs.writeFileSync(join(ws, '.gemini', 'config.json'), '{"agentName":"bob"}');
  fs.writeFileSync(join(ws, '.gemini', 'task.md'), '- [x] a task');
  fs.mkdirSync(join(ws, '.gemini-agent', 'backups'), { recursive: true });
  fs.writeFileSync(join(ws, '.gemini-agent', 'backups', 'x.bak'), 'a backup');
  fs.writeFileSync(join(ws, 'agent.log'), 'log line');
  return ws;
}

const read = (...p) => fs.readFileSync(join(...p), 'utf8');
const gone = (...p) => !fs.existsSync(join(...p));

describe('it moves the old layout into .agent/', () => {
  test('everything arrives where paths.js says it lives', () => {
    const ws = legacyWorkspace();
    const result = migrateWorkspace(ws);

    assert.equal(result.migrated, true);
    assert.equal(read(paths.configPath(ws)), '{"agentName":"bob"}');
    assert.equal(read(paths.artifactPath(ws, 'task.md')), '- [x] a task');
    assert.equal(read(paths.backupsDir(ws), 'x.bak'), 'a backup');
    assert.equal(read(paths.logPath(ws)), 'log line');
    fs.rmSync(ws, { recursive: true, force: true });
  });

  /*
   * Moved, not copied. A copy leaves the old tree behind, and the next version
   * of the agent that looks for `.gemini/` finds a stale config that nobody has
   * edited in months and is no longer the truth.
   */
  test('the old files are gone, not duplicated', () => {
    const ws = legacyWorkspace();
    migrateWorkspace(ws);

    assert.ok(gone(ws, '.gemini', 'config.json'), '.gemini/config.json was copied, not moved');
    assert.ok(gone(ws, '.gemini', 'task.md'));
    assert.ok(gone(ws, 'agent.log'), 'the root log was left behind');
    fs.rmSync(ws, { recursive: true, force: true });
  });

  /*
   * `rules.md` was the old instruction surface and `AGENT.md` is the only one
   * now. This is the single move that writes into the user's *tracked* tree
   * rather than into `.agent/`, which is why the clobber rule below matters
   * more here than anywhere else.
   */
  test('rules.md becomes AGENT.md', () => {
    const ws = legacyWorkspace();
    migrateWorkspace(ws);

    assert.equal(read(ws, 'AGENT.md'), 'MY PRECIOUS RULES');
    fs.rmSync(ws, { recursive: true, force: true });
  });
});

describe('it never clobbers', () => {
  /*
   * The one that would be unrecoverable. `AGENT.md` is the file this project
   * promises "can always be trusted to say what the human wrote", it is usually
   * tracked in git, and `renameSync` over it destroys it with no backup and no
   * prompt — on startup, before the first frame.
   */
  test('a human-written AGENT.md survives, and the legacy file stays put', () => {
    const ws = legacyWorkspace();
    fs.writeFileSync(join(ws, 'AGENT.md'), 'THE HUMAN WROTE THIS');

    migrateWorkspace(ws);

    assert.equal(read(ws, 'AGENT.md'), 'THE HUMAN WROTE THIS');
    // And it is not thrown away either: refusing to move must not mean deleting.
    assert.equal(read(ws, '.gemini', 'rules.md'), 'MY PRECIOUS RULES',
      'it declined to clobber and destroyed the source instead');
    fs.rmSync(ws, { recursive: true, force: true });
  });

  test('an existing .agent/ file is left alone', () => {
    const ws = legacyWorkspace();
    fs.mkdirSync(paths.artifactsDir(ws), { recursive: true });
    fs.writeFileSync(paths.artifactPath(ws, 'task.md'), '- [ ] the current one');

    migrateWorkspace(ws);

    assert.equal(read(paths.artifactPath(ws, 'task.md')), '- [ ] the current one');
    fs.rmSync(ws, { recursive: true, force: true });
  });
});

describe('it runs once', () => {
  test('a second run moves nothing and changes nothing', () => {
    const ws = legacyWorkspace();
    migrateWorkspace(ws);

    const snapshot = fs.readdirSync(paths.agentDir(ws)).sort().join(',');
    const second = migrateWorkspace(ws);

    assert.equal(second.items.length, 0, 'the migration ran twice');
    assert.equal(fs.readdirSync(paths.agentDir(ws)).sort().join(','), snapshot);
    fs.rmSync(ws, { recursive: true, force: true });
  });

  /*
   * The guard that makes that true: an existing `.agent/` means this workspace
   * has already been through it, whatever else is lying around. Without it, a
   * legacy directory someone kept for reference would be re-migrated over live
   * state on every launch.
   */
  test('an existing .agent/ stops it before it starts', () => {
    const ws = legacyWorkspace();
    fs.mkdirSync(paths.agentDir(ws), { recursive: true });

    const result = migrateWorkspace(ws);

    assert.equal(result.migrated, false);
    assert.equal(read(ws, '.gemini', 'config.json'), '{"agentName":"bob"}',
      'it migrated over a workspace that was already on the new layout');
    fs.rmSync(ws, { recursive: true, force: true });
  });

  // And the control: a workspace with nothing legacy in it is not touched, and
  // does not get an empty `.agent/` built for it as a side effect.
  test('a clean workspace is left completely alone', () => {
    const ws = fs.mkdtempSync(join(tmpdir(), 'mig-'));
    fs.writeFileSync(join(ws, 'index.js'), 'console.log(1)');

    const result = migrateWorkspace(ws);

    assert.equal(result.migrated, false);
    assert.deepEqual(fs.readdirSync(ws), ['index.js']);
    fs.rmSync(ws, { recursive: true, force: true });
  });
});
