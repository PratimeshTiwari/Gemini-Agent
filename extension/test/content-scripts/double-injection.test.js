/**
 * The bridge has to survive being injected twice.
 *
 * Every constant in `gemini-bridge.js` used to be declared at the top level of
 * the content-script world — and that world **outlives** the script that
 * created it. So injecting a second copy into a tab that already had one threw
 *
 *     Uncaught SyntaxError: Identifier 'RESPONSE_IDLE_TIMEOUT' has already
 *     been declared
 *
 * on line one, and the fresh copy never evaluated at all.
 *
 * Which disabled the repair that needed it most. `sendWithRepairs`'s `reinject`
 * stage exists for exactly one case — a content script orphaned by an extension
 * reload, which `CLAUDE.md` calls "the commonest cause by far" — and that is
 * precisely the case where a copy is already in the page to collide with. The
 * stage silently did nothing and `waitForBridge` then burned its whole budget
 * waiting for a script that had failed to load. The only evidence was an entry
 * on `chrome://extensions`, seen twice.
 *
 * A duplicate lexical declaration is raised when the *second* script is
 * instantiated, before any of its statements run — which is why this can be
 * checked in an empty context with nothing stubbed. Both runs failing the same
 * way on a missing global is the pass: it means the second script got as far as
 * executing, rather than being rejected outright.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const BRIDGE = resolve(here, '../../content-scripts/gemini-bridge.js');

/**
 * Evaluate `src` in `ctx` and report how it ended, by **name**.
 *
 * Not `instanceof`. A `vm` context is a separate realm with its own
 * `SyntaxError`, so `err instanceof SyntaxError` is false for every error
 * thrown in there — which made the first version of the assertion below pass
 * against anything at all, including the unfixed bridge. The name crosses
 * realms; the constructor does not.
 */
function run(src, ctx) {
  try {
    vm.runInContext(src, ctx);
    return null;
  } catch (err) {
    return { name: err?.constructor?.name, message: String(err?.message || '') };
  }
}

describe('injecting the bridge twice', () => {
  test('does not collide on a re-declared constant', () => {
    const src = readFileSync(BRIDGE, 'utf8');
    const ctx = vm.createContext({});

    const first = run(src, ctx);
    const second = run(src, ctx);

    // Neither run can complete — there is no `window` and no `chrome` here —
    // and that is deliberate: stubbing enough of Chrome to run the whole file
    // would test the stubs. What matters is that the *second* run fails the
    // same way as the first, rather than being refused before it starts.
    assert.equal(second?.name, first?.name,
      'the second injection failed differently from the first');
    assert.notEqual(second?.name, 'SyntaxError',
      `a second injection is rejected outright: ${second?.message}`);
    assert.doesNotMatch(second?.message ?? '', /already been declared/);
  });

  /*
   * The negative control, and this file is worth very little without it: the
   * assertion above passes trivially against anything that happens not to use a
   * top-level `const`. This is the shape the bridge had, and it must still
   * collide — otherwise the test is agreeing with itself.
   */
  test('and the shape it used to have still would', () => {
    const ctx = vm.createContext({});
    const unwrapped = 'const RESPONSE_IDLE_TIMEOUT = 15000;\nchrome.runtime.connect();';

    run(unwrapped, ctx);
    const second = run(unwrapped, ctx);

    assert.equal(second?.name, 'SyntaxError', 'the control did not reproduce the bug');
    assert.match(second.message, /already been declared/);
  });

  // The other half of the repair. Scoping lets the new copy load; this is what
  // lets it *replace* the old one, whose MutationObservers and timers are still
  // running in the page with nothing to tell them to stop.
  test('a fresh copy can stop the one it replaces', () => {
    const src = readFileSync(BRIDGE, 'utf8');
    assert.match(src, /window\.__agentBridgeStop\?\.\(\)/,
      'nothing tells the previous copy to stop');
    assert.match(src, /window\.__agentBridgeStop = invalidate/,
      'nothing offers a way for the next copy to stop this one');
    assert.ok(
      src.indexOf('window.__agentBridgeStop?.()') < src.indexOf('window.__agentBridgeStop = invalidate'),
      'the handle is overwritten before the old copy is stopped, so it can never be reached',
    );
  });
});
