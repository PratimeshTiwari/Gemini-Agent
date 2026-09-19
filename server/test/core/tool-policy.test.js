/**
 * The gates, on their own, without a turn around them.
 *
 * These two decisions lived inside `_executeToolCalls`, 487 lines deep in
 * dispatch, and the bug they produced was invisible for exactly that reason:
 * the plan-mode branch named the mutating tools literally, `run_background` was
 * added later and not added there, and so the mode whose status bar reads
 * "plan — every edit needs approval" spawned a detached shell process without
 * asking. Auto mode asked about the same call, through the classifier's
 * "Unknown tool" default. The careful mode was the permissive one.
 *
 * The fix is not "add `run_background` to the list" — it is that there is no
 * list here any more. Both functions read the catalog's own `mutates` and
 * `shell` flags, so the next tool that writes is gated by declaring itself,
 * beside its description, where the person adding it is already typing.
 *
 * `plan-mode-writes.test.js` covers `isAgentArtifact` itself; this covers what
 * the policy does with the answer.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requiresApproval, isBlockedOutright } from '../../src/core/tool-policy.js';
import { MUTATING_TOOLS, SHELL_TOOLS } from '../../src/core/tool-catalog.js';
import * as paths from '../../src/core/paths.js';

const safe = { level: 'safe', reason: '' };
const risky = { level: 'risky', reason: 'writes' };
const critical = { level: 'critical', reason: 'outside the workspace' };

function workspace() {
  const ws = mkdtempSync(join(tmpdir(), 'policy-'));
  mkdirSync(paths.artifactsDir(ws), { recursive: true });
  return ws;
}

describe('plan mode', () => {
  /*
   * The regression, in one line. It is a one-liner because the policy is a
   * function now; when it was a branch inside dispatch, reproducing it needed a
   * loop, an extension and a browser.
   */
  test('run_background is not exempt from approval', () => {
    const ws = workspace();
    assert.equal(
      requiresApproval({ name: 'run_background', args: { command: 'npm run dev' } },
        { mode: 'plan', risk: safe, workspace: ws }),
      true,
      'plan mode spawned a process that outlives the turn without asking',
    );
    rmSync(ws, { recursive: true, force: true });
  });

  /*
   * And the general form of it: the bug was a hand-maintained list, so the
   * assertion is about *every* mutating tool rather than the four that exist
   * today. A fifth added next year fails here if it is somehow exempted.
   */
  test('every mutating tool is gated', () => {
    const ws = workspace();
    for (const name of MUTATING_TOOLS) {
      // A shell tool the classifier calls `safe` is read-only, which is the one
      // documented exemption; give the others a path outside the artifacts dir.
      const risk = SHELL_TOOLS.has(name) ? risky : safe;
      assert.equal(
        requiresApproval({ name, args: { path: join(ws, 'README.md'), command: 'rm -rf x' } },
          { mode: 'plan', risk, workspace: ws }),
        true,
        `${name} mutates and was not gated`,
      );
    }
    rmSync(ws, { recursive: true, force: true });
  });

  test('a read-only tool is not gated', () => {
    const ws = workspace();
    for (const name of ['read_file', 'grep_search', 'find_symbol', 'list_files']) {
      assert.equal(requiresApproval({ name, args: {} }, { mode: 'plan', risk: safe, workspace: ws }),
        false, `${name} asked for approval to read something`);
    }
    rmSync(ws, { recursive: true, force: true });
  });

  /*
   * The exemption that exists, and the one that does not. The system prompt
   * tells the model to keep `task.md` ticked; it cannot do that if every tick
   * needs a keystroke. `README.md` is the case the old `endsWith('.md')` test
   * let through silently.
   */
  test('the agent ticks its own checklist, and nothing else', () => {
    const ws = workspace();
    const ask = (path) =>
      requiresApproval({ name: 'edit_file', args: { path } }, { mode: 'plan', risk: safe, workspace: ws });

    assert.equal(ask(paths.artifactPath(ws, 'task.md')), false, 'ticking task.md needed approval');
    assert.equal(ask('.agent/artifacts/plan.md'), false, 'writing plan.md needed approval');

    assert.equal(ask(join(ws, 'README.md')), true, 'it could rewrite README.md silently');
    assert.equal(ask(join(ws, 'AGENT.md')), true, 'it could rewrite AGENT.md silently');
    assert.equal(ask('/etc/hosts'), true, 'an absolute path escaped plan mode');
    assert.equal(ask('.agent/artifacts/../../../task.md'), true, 'a traversal escaped plan mode');
    rmSync(ws, { recursive: true, force: true });
  });

  // `ls` behind a keystroke is how an approval prompt becomes something people
  // dismiss without reading.
  test('a read-only command runs unattended', () => {
    const ws = workspace();
    assert.equal(
      requiresApproval({ name: 'run_command', args: { command: 'ls' } },
        { mode: 'plan', risk: safe, workspace: ws }),
      false,
    );
    rmSync(ws, { recursive: true, force: true });
  });
});

describe('auto mode', () => {
  test('it asks about risky and nothing else', () => {
    const ws = workspace();
    const ask = (risk) =>
      requiresApproval({ name: 'run_command', args: { command: 'x' } }, { mode: 'auto', risk, workspace: ws });

    assert.equal(ask(risky), true);
    assert.equal(ask(safe), false, 'auto mode that asks about safe commands is not auto mode');
    // `critical` never reaches a prompt — `isBlockedOutright` has it first — so
    // the answer here is "no prompt", not "prompt".
    assert.equal(ask(critical), false);
    rmSync(ws, { recursive: true, force: true });
  });

  /*
   * Writes in auto mode are not gated here on purpose: `edit_file` and
   * `create_file` go through the diff engine, which shows the hunks and asks
   * per hunk. Gating them here too would ask twice for one edit.
   */
  test('an edit is left to the diff engine', () => {
    const ws = workspace();
    assert.equal(
      requiresApproval({ name: 'edit_file', args: { path: join(ws, 'a.js') } },
        { mode: 'auto', risk: safe, workspace: ws }),
      false,
    );
    rmSync(ws, { recursive: true, force: true });
  });
});

describe('blocked outright', () => {
  test('a critical command is refused, in either mode', () => {
    for (const name of SHELL_TOOLS) {
      assert.equal(isBlockedOutright({ name }, critical), true, `${name} critical was not blocked`);
    }
  });

  // The negative controls. A block that fires on everything is not a block.
  test('nothing else is', () => {
    assert.equal(isBlockedOutright({ name: 'run_command' }, risky), false);
    assert.equal(isBlockedOutright({ name: 'run_command' }, safe), false);
    assert.equal(isBlockedOutright({ name: 'edit_file' }, critical), false,
      'a write was refused outright instead of going to the diff engine');
    assert.equal(isBlockedOutright({ name: 'read_file' }, critical), false);
  });
});

describe('it fails closed on nonsense', () => {
  /*
   * The call comes out of `JSON.parse` on text a model wrote, so the arguments
   * can be anything at all. Neither function may throw — an exception here
   * takes the turn with it — and an unrecognisable call must not come back
   * "no approval needed".
   */
  test('a malformed call does not throw', () => {
    const ws = workspace();
    for (const call of [undefined, null, {}, { name: null }, { name: 'edit_file' }]) {
      assert.doesNotThrow(() => requiresApproval(call, { mode: 'plan', risk: safe, workspace: ws }));
      assert.doesNotThrow(() => isBlockedOutright(call, critical));
    }
    rmSync(ws, { recursive: true, force: true });
  });

  test('an edit with no path still needs approval', () => {
    const ws = workspace();
    assert.equal(
      requiresApproval({ name: 'edit_file', args: {} }, { mode: 'plan', risk: safe, workspace: ws }),
      true,
      'a missing path was read as an exempt artifact',
    );
    rmSync(ws, { recursive: true, force: true });
  });

  test('a missing risk verdict is not treated as permission', () => {
    const ws = workspace();
    assert.equal(
      requiresApproval({ name: 'run_command', args: { command: 'x' } },
        { mode: 'plan', risk: undefined, workspace: ws }),
      true,
    );
    assert.equal(isBlockedOutright({ name: 'run_command' }, undefined), false);
    rmSync(ws, { recursive: true, force: true });
  });
});
