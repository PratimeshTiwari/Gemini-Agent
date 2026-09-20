/**
 * Recovering from a dependency the code imports and the tree does not have.
 *
 * Two halves, and they fail in opposite directions.
 *
 * **The detector** must say yes to a missing *package* and no to a missing
 * *file*. A false negative costs a fatal error the user has to fix by hand,
 * which is exactly where this started. A false positive is worse: `npm i`
 * cannot conjure a file, so it burns a restart to change nothing — and because
 * the attempt is recorded, it also burns the one attempt a genuine missing
 * package would have had. Every shape asserted below was **probed against real
 * Node and real tsx** on 2026-09-20 rather than recalled; the table in
 * `dep-recovery.js` is that probe's output.
 *
 * **The bound** must hold across processes. The recovery installs and exits
 * asking to be restarted, so the process that finds out whether it worked is
 * not the one that tried — nothing in memory survives, and a marker that is not
 * honoured is a boot loop with no UI up to stop it from.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  missingPackage, packageFromSpecifier, installRoot,
  readAttempt, recordAttempt, clearAttempt,
  recoverMissingDependency, explainFailure, installDependencies,
} from '../../src/core/dep-recovery.js';
import { depRecoveryPath } from '../../src/core/paths.js';

/** The error Node/tsx actually hands us, not a hand-rolled approximation. */
const err = (code, message) => Object.assign(new Error(message), { code });

// ── The detector ─────────────────────────────────────────────────────

describe('missingPackage — the shapes that really occur', () => {
  test('ESM names the package, and reduces a subpath for us', () => {
    // Measured: `figlet/lib/x.js` is reported as 'figlet' by Node itself.
    assert.equal(
      missingPackage(err('ERR_MODULE_NOT_FOUND',
        "Cannot find package 'figlet' imported from /repo/server/src/ui/App.jsx")),
      'figlet',
    );
    assert.equal(
      missingPackage(err('ERR_MODULE_NOT_FOUND',
        "Cannot find package '@scope/thing' imported from /repo/x.js")),
      '@scope/thing',
    );
  });

  test('the exact error the owner reported is recognised', () => {
    // From the report: this is the whole reason the module exists.
    assert.equal(
      missingPackage(err('ERR_MODULE_NOT_FOUND',
        "Cannot find package 'figlet' imported from server/src/ui/App.jsx")),
      'figlet',
    );
  });

  test('tsx reports the same package in the CJS shape, and it counts too', () => {
    // The agent runs under tsx, and a missing package imported from a .jsx
    // file arrives as MODULE_NOT_FOUND with no "imported from" at all.
    // Handling only the ESM code would miss the path this project mostly hits.
    assert.equal(
      missingPackage(err('MODULE_NOT_FOUND',
        "Cannot find module 'figlet'\nRequire stack:\n- /repo/server/src/ui/App.jsx")),
      'figlet',
    );
  });

  test('tsx does NOT reduce a subpath, so this must', () => {
    assert.equal(missingPackage(err('MODULE_NOT_FOUND', "Cannot find module 'figlet/lib/x.js'")), 'figlet');
    assert.equal(missingPackage(err('MODULE_NOT_FOUND', "Cannot find module '@scope/thing/sub'")), '@scope/thing');
  });

  test('a missing FILE is not a missing package, in either loader', () => {
    // ESM: Node has already resolved './nope.js' to an absolute path, and says
    // "module" rather than "package". `npm i` cannot create it.
    assert.equal(
      missingPackage(err('ERR_MODULE_NOT_FOUND',
        "Cannot find module '/repo/server/src/nope.js' imported from /repo/server/src/main.js")),
      null,
    );
    // tsx: the specifier arrives as written, so the prefix is the evidence.
    assert.equal(missingPackage(err('MODULE_NOT_FOUND', "Cannot find module './missing-sibling.js'")), null);
    assert.equal(missingPackage(err('MODULE_NOT_FOUND', "Cannot find module '../missing-up.js'")), null);
  });

  test('a builtin typo carries its own code and is left alone', () => {
    assert.equal(missingPackage(err('ERR_UNKNOWN_BUILTIN_MODULE', 'No such built-in module: node:nope')), null);
  });

  test('the error CODE is the gate, not the wording of the message', () => {
    // Found by a negative control: every other case here has a message that
    // fails the pattern too, so deleting the code check broke nothing and the
    // gate was untested. A module-shaped sentence inside an unrelated error is
    // what tells the two apart.
    assert.equal(
      missingPackage(err('ERR_INVALID_ARG_TYPE', "Cannot find module 'figlet' was reported downstream")),
      null,
    );
    assert.equal(missingPackage(Object.assign(new Error("Cannot find module 'figlet'"), {})), null,
      'an error with no code at all is not a resolution failure');
  });

  test('anything that is not a resolution failure is not this', () => {
    // The negative control that matters: `main().catch` sees every startup
    // failure, and all but one of them must fall through to the old message.
    assert.equal(missingPackage(err('EADDRINUSE', 'listen EADDRINUSE: address already in use :::7777')), null);
    assert.equal(missingPackage(new TypeError('x is not a function')), null);
    assert.equal(missingPackage(err('MODULE_NOT_FOUND', 'something else entirely')), null);
    assert.equal(missingPackage(null), null);
    assert.equal(missingPackage(undefined), null);
    assert.equal(missingPackage({}), null);
  });
});

describe('packageFromSpecifier — the exclusions, on their own', () => {
  test('a plain package, scoped or not', () => {
    assert.equal(packageFromSpecifier('figlet'), 'figlet');
    assert.equal(packageFromSpecifier('@scope/thing'), '@scope/thing');
    assert.equal(packageFromSpecifier('acorn-walk'), 'acorn-walk');
  });

  test('paths of every spelling are refused', () => {
    for (const spec of ['./x.js', '../x.js', '/abs/x.js', '~/x.js', 'C:\\repo\\x.js', 'C:/repo/x.js']) {
      assert.equal(packageFromSpecifier(spec), null, `${spec} is a path, not a package`);
    }
  });

  test('a URL is refused, including node: and file:', () => {
    for (const spec of ['node:fs', 'file:///repo/x.js', 'https://example.com/x.js', 'data:text/javascript,0']) {
      assert.equal(packageFromSpecifier(spec), null, `${spec} is not installable`);
    }
  });

  test('anything that is not a legal package name is refused rather than guessed', () => {
    // Fail closed: handing `npm` a guess is worse than leaving it to the user.
    for (const spec of ['', 'UPPER', 'has space', '@', '@scope', '.hidden']) {
      assert.equal(packageFromSpecifier(spec), null, `${JSON.stringify(spec)} should not reach npm`);
    }
  });
});

// ── Where the install has to run ─────────────────────────────────────

describe('installRoot — the lockfile decides, not the nearest package.json', () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dep-root-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test('a workspace member resolves to the root that holds the lockfile', () => {
    // This repo's shape exactly: one lockfile at the top, and a package.json
    // in `server/` that is a workspace *member*. Installing from the member
    // would resolve a different tree from the one the lockfile describes.
    writeFileSync(join(root, 'package.json'), '{"workspaces":["server"]}');
    writeFileSync(join(root, 'package-lock.json'), '{}');
    mkdirSync(join(root, 'server', 'src', 'core'), { recursive: true });
    writeFileSync(join(root, 'server', 'package.json'), '{}');

    assert.equal(installRoot(join(root, 'server', 'src', 'core')), root);
    assert.equal(installRoot(join(root, 'server')), root);
  });

  test('with no lockfile anywhere it falls back to the nearest package.json', () => {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{}');
    assert.equal(installRoot(join(root, 'src')), root);
  });

  test('the nearest package.json loses to a lockfile further up', () => {
    // The negative control for the test above: without this, "nearest
    // package.json" and "lockfile" agree in every fixture and the rule is
    // untested.
    writeFileSync(join(root, 'package-lock.json'), '{}');
    writeFileSync(join(root, 'package.json'), '{}');
    mkdirSync(join(root, 'inner', 'deep'), { recursive: true });
    writeFileSync(join(root, 'inner', 'package.json'), '{}');
    assert.equal(installRoot(join(root, 'inner', 'deep')), root);
  });

  test('nothing to install from is null, not a guess', () => {
    mkdirSync(join(root, 'bare'), { recursive: true });
    // A temp dir has no package.json above it on any machine this runs on.
    assert.equal(installRoot(join(root, 'bare')), null);
  });
});

// ── The marker, and the bound it enforces ────────────────────────────

describe('the attempt marker', () => {
  let home;
  let saved;

  beforeEach(() => {
    saved = process.env.AGENT_CLI_HOME;
    home = mkdtempSync(join(tmpdir(), 'dep-home-'));
    process.env.AGENT_CLI_HOME = home;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.AGENT_CLI_HOME;
    else process.env.AGENT_CLI_HOME = saved;
    rmSync(home, { recursive: true, force: true });
  });

  test('no marker is a successful answer, not a failure to read', () => {
    // These must not be confused: absent means "go ahead", unreadable means
    // "do not". Collapsing them into one falsy value is how fail-closed stops
    // being fail-closed.
    const seen = readAttempt();
    assert.equal(seen.ok, true);
    assert.equal(seen.attempt, null);
  });

  test('it round-trips, and names the package for the message', () => {
    assert.equal(recordAttempt('figlet', '/repo'), true);
    const seen = readAttempt();
    assert.equal(seen.ok, true);
    assert.equal(seen.attempt.package, 'figlet');
    assert.equal(seen.attempt.root, '/repo');
    assert.ok(Number.isFinite(seen.attempt.at));
  });

  test('a corrupt marker reads as "could not tell", which blocks the attempt', () => {
    writeFileSync(depRecoveryPath(), 'not json at all');
    assert.equal(readAttempt().ok, false);
  });

  test('clearing it lets the next genuine occurrence have its own attempt', () => {
    recordAttempt('figlet', '/repo');
    assert.equal(clearAttempt(), true);
    assert.equal(readAttempt().attempt, null);
    // Clearing what is not there is not an error — it runs on every good boot.
    assert.equal(clearAttempt(), true);
  });
});

// ── The whole recovery ───────────────────────────────────────────────

describe('recoverMissingDependency', () => {
  let home;
  let root;
  let saved;

  beforeEach(() => {
    saved = process.env.AGENT_CLI_HOME;
    home = mkdtempSync(join(tmpdir(), 'dep-home-'));
    process.env.AGENT_CLI_HOME = home;
    root = mkdtempSync(join(tmpdir(), 'dep-root-'));
    writeFileSync(join(root, 'package.json'), '{}');
    writeFileSync(join(root, 'package-lock.json'), '{}');
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.AGENT_CLI_HOME;
    else process.env.AGENT_CLI_HOME = saved;
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  const fatal = () => err('ERR_MODULE_NOT_FOUND',
    "Cannot find package 'figlet' imported from server/src/ui/App.jsx");

  test('installs once and asks for a restart', async () => {
    const calls = [];
    const out = await recoverMissingDependency(fatal(), {
      from: root,
      install: async (dir, opts) => { calls.push([dir, opts]); return { ok: true }; },
    });

    assert.equal(out.ok, true);
    assert.equal(out.package, 'figlet');
    assert.equal(out.restart, true);
    assert.deepEqual(calls.map((c) => c[0]), [root], 'installs at the lockfile root, once');
  });

  test('the second time is refused, because the first did not fix it', async () => {
    // The whole bound. The real second attempt happens in a different process,
    // which is why the marker is on disk and why this is asserted through it
    // rather than through a flag.
    let installs = 0;
    const run = () => recoverMissingDependency(fatal(), {
      from: root,
      install: async () => { installs += 1; return { ok: true }; },
    });

    assert.equal((await run()).ok, true);
    const second = await run();
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'already-tried');
    assert.equal(installs, 1, 'a boot loop is exactly one install too many');
  });

  test('the marker is written BEFORE the install, so a killed install still counts', async () => {
    // Writing it afterwards would mean an install that crashes half-way leaves
    // no record, and the next boot tries again — the loop this prevents.
    const out = await recoverMissingDependency(fatal(), {
      from: root,
      install: async () => { throw new Error('killed'); },
    }).catch((e) => e);

    assert.ok(out instanceof Error, 'a throwing installer is not swallowed here');
    assert.equal(readAttempt().attempt?.package, 'figlet', 'the attempt was recorded first');
  });

  test('announce fires once, before the install, and only when one happens', async () => {
    // The ordering is the point: with stdio 'inherit' npm streams live, so a
    // message printed after the install lands under its log.
    const order = [];
    await recoverMissingDependency(fatal(), {
      from: root,
      announce: (info) => order.push(`announce:${info.package}:${info.root}`),
      install: async () => { order.push('install'); return { ok: true }; },
    });
    assert.deepEqual(order, [`announce:figlet:${root}`, 'install']);
  });

  test('announce does not fire when no install is attempted', async () => {
    for (const bad of [err('EADDRINUSE', 'listen EADDRINUSE'),
      err('MODULE_NOT_FOUND', "Cannot find module './gone.js'")]) {
      let announced = 0;
      await recoverMissingDependency(bad, {
        from: root,
        announce: () => { announced += 1; },
        install: async () => ({ ok: true }),
      });
      assert.equal(announced, 0, 'nothing to announce when nothing is installed');
    }
  });

  test('a throwing announce does not fail the recovery', async () => {
    // A message is not worth losing the repair over.
    const out = await recoverMissingDependency(fatal(), {
      from: root,
      announce: () => { throw new Error('terminal gone'); },
      install: async () => ({ ok: true }),
    });
    assert.equal(out.ok, true);
  });

  test('a failed install says so and does not ask for a restart', async () => {
    const out = await recoverMissingDependency(fatal(), {
      from: root,
      install: async () => ({ ok: false, error: 'npm ERR! 404 Not Found' }),
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'install-failed');
    assert.equal(out.restart, undefined);
    assert.match(explainFailure(out), /404 Not Found/);
  });

  test('an unrelated startup failure is left entirely alone', async () => {
    let installs = 0;
    const out = await recoverMissingDependency(err('EADDRINUSE', 'listen EADDRINUSE'), {
      from: root,
      install: async () => { installs += 1; return { ok: true }; },
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'not-a-missing-package');
    assert.equal(installs, 0);
    assert.equal(explainFailure(out), null, 'nothing to add to the ordinary fatal message');
    assert.equal(existsSync(depRecoveryPath()), false, 'and no attempt is recorded');
  });

  test('a missing file is refused before anything is installed or recorded', async () => {
    let installs = 0;
    const out = await recoverMissingDependency(
      err('MODULE_NOT_FOUND', "Cannot find module './gone.js'"),
      { from: root, install: async () => { installs += 1; return { ok: true }; } },
    );
    assert.equal(out.reason, 'not-a-missing-package');
    assert.equal(installs, 0);
    assert.equal(existsSync(depRecoveryPath()), false);
  });

  test('no install root means no install', async () => {
    let installs = 0;
    const bare = mkdtempSync(join(tmpdir(), 'dep-bare-'));
    try {
      const out = await recoverMissingDependency(fatal(), {
        from: bare,
        install: async () => { installs += 1; return { ok: true }; },
      });
      assert.equal(out.reason, 'no-install-root');
      assert.equal(installs, 0);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  test('a marker that cannot be WRITTEN fails closed too', async (t) => {
    // The other half of fail-closed, and the one coverage showed nothing
    // reached: the read succeeds (there is no marker) and the write does not,
    // so without this branch the attempt would proceed unrecorded — which is
    // the boot loop, because the next process would find no marker either.
    chmodSync(home, 0o500);
    try {
      // Skip rather than assert nothing if this ran as root, where the mode
      // is advisory and the write would succeed.
      let writable = true;
      try { writeFileSync(join(home, '.probe'), 'x'); } catch { writable = false; }
      if (writable) { t.skip('home directory is writable despite mode 0500'); return; }

      let installs = 0;
      const out = await recoverMissingDependency(fatal(), {
        from: root,
        install: async () => { installs += 1; return { ok: true }; },
      });
      assert.equal(out.reason, 'marker-unwritable');
      assert.equal(installs, 0);
      assert.match(explainFailure(out), /boot loop/);
    } finally {
      chmodSync(home, 0o700);
    }
  });

  test('an unreadable marker fails closed — no install at all', async () => {
    writeFileSync(depRecoveryPath(), '{ broken');
    let installs = 0;
    const out = await recoverMissingDependency(fatal(), {
      from: root,
      install: async () => { installs += 1; return { ok: true }; },
    });
    assert.equal(out.reason, 'marker-unreadable');
    assert.equal(installs, 0, 'one manual npm i is cheaper than an unbounded loop');
    assert.match(explainFailure(out), /boot loop/);
  });
});

describe('explainFailure — each reason calls for a different next move', () => {
  test('every reason the recovery can return has something to say', () => {
    for (const reason of ['already-tried', 'install-failed', 'marker-unreadable',
      'marker-unwritable', 'no-install-root']) {
      const text = explainFailure({ reason, package: 'figlet', root: '/repo', error: 'x' });
      assert.ok(text && text.length > 0, `${reason} has no explanation`);
    }
  });

  test('"already tried" says a reinstall is not the fix, which is the useful part', () => {
    const text = explainFailure({ reason: 'already-tried', package: 'figlet', root: '/repo' });
    assert.match(text, /still missing/);
    assert.match(text, /npm install/);
  });

  test('an unknown reason adds nothing rather than inventing advice', () => {
    assert.equal(explainFailure({ reason: 'something-new' }), null);
    assert.equal(explainFailure(undefined), null);
  });
});

// ── The installer itself ─────────────────────────────────────────────

describe('installDependencies', () => {
  test('a hung install is killed and reported rather than waited on forever', async () => {
    // A registry that never answers must not become an agent that never
    // starts. The margin here is enormous on purpose — 1ms against a process
    // spawn that cannot complete in under a hundred — so this asserts which
    // branch fires, not how fast the machine is.
    const dir = mkdtempSync(join(tmpdir(), 'dep-hang-'));
    writeFileSync(join(dir, 'package.json'), '{"name":"x","version":"1.0.0"}');
    try {
      const out = await installDependencies(dir, { timeout: 1 });
      assert.equal(out.ok, false);
      assert.match(out.error, /did not finish within/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a command that cannot run is reported, not thrown', async () => {
    // The real npm is not run here — this is about the failure path being an
    // answer rather than an exception, because every caller is already on one.
    const out = await installDependencies(join(tmpdir(), 'definitely-not-a-directory-xyz'), {
      timeout: 5000,
    });
    assert.equal(out.ok, false);
    assert.ok(typeof out.error === 'string' && out.error.length > 0);
  });
});
