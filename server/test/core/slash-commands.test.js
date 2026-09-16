/**
 * Every command the switch handles is one the UI will forward.
 *
 * `/name` shipped fully implemented and answered "No such command: /name".
 * The UI decided what to forward from a **hand-written array** — a fourth list
 * in a project that had already been bitten three times by lists that have to
 * agree with something else, and the fourth was found the same way as the
 * others: by a person typing the thing and being told it did not exist.
 *
 * The array is gone; `AGENT_COMMANDS` is exported from the module that handles
 * them. This checks it against the `case` labels in the switch, so adding one
 * and forgetting the other fails here rather than in front of someone.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'fs';
import { AGENT_COMMANDS } from '../../src/core/slash-commands.js';
import { SLASH_COMMANDS } from '../../src/ui/constants.js';

/** The `case 'x':` labels in the switch, read from the shipped source. */
function casesInSwitch() {
  const src = readFileSync(new URL('../../src/core/slash-commands.js', import.meta.url), 'utf8');
  return new Set([...src.matchAll(/^\s{4}case '([a-z-]+)':/gm)].map((m) => m[1]));
}

describe('the switch and the forwarding set agree', () => {
  test('every case is forwarded', () => {
    const missing = [...casesInSwitch()].filter((c) => !AGENT_COMMANDS.has(c));
    assert.deepEqual(missing, [],
      `handled but never forwarded — these answer "No such command": ${missing.join(', ')}`);
  });

  test('nothing is forwarded that the switch cannot handle', () => {
    // The other direction: a name in the set with no case falls through to the
    // switch's default and reports itself, which is confusing rather than fatal.
    const cases = casesInSwitch();
    // `workspace` is handled in the UI layer before it ever reaches the switch.
    const uiHandled = new Set(['workspace']);
    const orphans = [...AGENT_COMMANDS].filter((c) => !cases.has(c) && !uiHandled.has(c));
    assert.deepEqual(orphans, [], `forwarded with no handler: ${orphans.join(', ')}`);
  });

  test('/name in particular, since that is the one that shipped broken', () => {
    assert.ok(AGENT_COMMANDS.has('name'));
    assert.ok(casesInSwitch().has('name'));
  });
});

describe('the palette and the handlers agree', () => {
  /**
   * Derived from both sources, never listed here.
   *
   * The first version of this test hand-maintained the UI-handled names, which
   * would have been a *fifth* list that has to agree with something else — in
   * a test written to catch exactly that. It immediately reported `/new` as a
   * ghost, and `/new` is handled at `use-slash-commands.js:360`.
   */
  function uiHandled() {
    const src = readFileSync(new URL('../../src/ui/hooks/use-slash-commands.js', import.meta.url), 'utf8');
    return new Set([...src.matchAll(/command === '([a-z-]+)'/g)].map((m) => m[1]));
  }

  test('every command in the palette can actually be run', () => {
    // A palette entry that answers "No such command" is worse than a missing
    // one: it was advertised.
    const cases = casesInSwitch();
    const ui = uiHandled();
    const ghosts = SLASH_COMMANDS
      .map((c) => c.name)
      .filter((n) => !cases.has(n) && !AGENT_COMMANDS.has(n) && !ui.has(n));
    assert.deepEqual(ghosts, [], `advertised with no handler: ${ghosts.join(', ')}`);
  });

  test('the derivation is not vacuously empty', () => {
    // If either regex stops matching, every check above passes for nothing.
    assert.ok(casesInSwitch().size >= 10, 'the switch parse found almost nothing');
    assert.ok(uiHandled().size >= 10, 'the UI parse found almost nothing');
  });
});
