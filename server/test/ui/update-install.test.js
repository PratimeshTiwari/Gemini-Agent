/**
 * `/update` installs what it pulled, and does not restart into a tree it knows
 * is out of sync.
 *
 * The gap this closes, from the other direction to `core/dep-recovery.js`: a
 * pull that changes `package.json` leaves new code against an old
 * `node_modules`, and the next start dies with the fatal `Cannot find package`
 * the owner reported. `/update` used to print `npm install` and refuse to
 * restart, which is safe and is half a job — the tree stays out of sync until
 * someone runs it by hand.
 *
 * **Pinned as source assertions**, because the handler is an inline block in a
 * hook and `/update` is one of the five commands `slash-command-smoke` will not
 * drive: it runs `git pull` against the real remote. So there is no test that
 * executes this path at all, which is precisely the `find_symbol` shape this
 * repo has been bitten by — 1,474 green tests around a tool that threw on
 * every call. The behaviours below are the ones whose regression reads as
 * tidying in a diff.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../src/ui/hooks/use-slash-commands.js', import.meta.url), 'utf8');

/** The `/update` handler, from the pull to the restart. */
const handler = (() => {
  const start = src.indexOf('const outcome = await pullUpdate(');
  const end = src.indexOf("if (command === 'open')", start);
  assert.ok(start > 0 && end > start, 'the /update handler moved; this fixture is stale');
  return src.slice(start, end);
})();

describe('/update runs the install rather than printing it', () => {
  test('a pull that moved package.json installs', () => {
    assert.match(handler, /if \(outcome\.install\)/,
      'nothing branches on the pull having changed dependencies');
    assert.match(handler, /installDependencies\(/,
      '/update is back to telling the user to run npm install by hand');
  });

  test('the install is piped, never inherited', () => {
    // npm's progress written straight to a terminal holding a live Ink frame
    // is a frame regression — the one failure class the harness exists for.
    assert.match(handler, /installDependencies\([^)]*stdio: 'pipe'/,
      "npm's output would be written over the live frame");
    assert.doesNotMatch(handler, /stdio: 'inherit'/,
      'inherit belongs on the startup path, where there is no UI to corrupt');
  });

  test('it says what it is doing before it waits', () => {
    // A bare half-minute with nothing on screen reads as a hang, and a spinner
    // is not available: SLOW_COMMANDS is keyed on the first word, and
    // `/update` on its own answers instantly, so raising one would strand the
    // row `local-command-spinner` pins.
    const announce = handler.indexOf('installing them now');
    const install = handler.indexOf('installDependencies(');
    assert.ok(announce > 0, 'the wait is unannounced');
    assert.ok(announce < install, 'the announcement must come before the install, not after it');
  });
});

describe('the restart gate', () => {
  test('a failed install does not restart', () => {
    // The regression that matters. Restarting into a tree we have just been
    // told is out of sync is exactly the reported crash, manufactured by the
    // updater instead of by a branch switch.
    assert.match(handler, /installed\?\.ok === true/,
      'the gate no longer requires the install to have succeeded');
    assert.doesNotMatch(handler, /AGENT_CLI_SUPERVISED && !outcome\.install\)/,
      'the gate is back to refusing every install rather than only failed ones');
  });

  test('what it says and what it does are the same condition', () => {
    // These were two copies of one expression, which is the drift this repo
    // keeps finding. One `willRestart`, read twice.
    assert.equal((handler.match(/willRestart/g) || []).length, 3,
      'willRestart should be declared once and read by both the message and the exit');
    assert.match(handler, /if \(willRestart\) \{/,
      'the exit no longer reads the same flag the message does');
  });

  test('a successful install still restarts, or the pull never takes effect', () => {
    // The negative control for the test above: a gate that refuses everything
    // would satisfy "does not restart on failure" and be useless.
    assert.match(handler, /!outcome\.install \|\| installed\?\.ok === true/,
      'a clean install must still reach the restart');
  });
});
