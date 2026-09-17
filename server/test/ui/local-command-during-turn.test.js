/**
 * A local command must not tell the UI that a running turn has finished.
 *
 * `handleSubmit` used to `setIsProcessing(true)` and `setActiveToolCalls([])`
 * before looking at what was submitted, and every slash handler ends with
 * `setIsProcessing(false)`. So typing anything beginning with `/` while the
 * agent was mid-turn wiped the live turn's tool rows and then declared the
 * turn over — while the loop carried on working.
 *
 * Reported exactly that way: `/efforttt` typed during a turn, and the CLI
 * "stopped responding and did not output the result". It had not stopped.
 * Gemini ran the tool calls and produced the answer; the terminal was left
 * with no spinner, no rows and no reason to think anything was still running.
 *
 * This is a source assertion because the behaviour needs a live turn to
 * observe, which needs the fake extension under a pty — and because the
 * regression is invisible in review: moving two `set…` calls back above the
 * branch reads as tidying. Same reasoning as `startup-order.test.js`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../../src/ui/App.jsx'), 'utf8');

/** The body of handleSubmit, without comments — a grep matches prose otherwise. */
function submitBody() {
  const start = src.indexOf('const handleSubmit = async (query) =>');
  assert.ok(start > -1, 'handleSubmit should still exist');
  const end = src.indexOf('\n  };', start);
  return src.slice(start, end)
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

test('the slash branch is reached before the turn state is reset', () => {
  // Measured from after the `:stop` handler, which legitimately clears the
  // same state and sits above the branch. My first version of this assertion
  // matched that occurrence and failed against correct code.
  const body = submitBody();
  const afterStop = body.indexOf('Agent forcefully stopped');
  assert.ok(afterStop > -1, ':stop should still be handled first');

  const rest = body.slice(afterStop);
  const branch = rest.indexOf("query.startsWith('/')");
  const reset = rest.indexOf('setActiveToolCalls([])');

  assert.ok(branch > -1 && reset > -1);
  assert.ok(
    branch < reset,
    'setActiveToolCalls([]) must not run before the slash branch — that is what '
    + 'wiped the live turn\'s rows for a purely local command',
  );
});

test('a busy loop gets a no-op setIsProcessing', () => {
  const body = submitBody();
  assert.match(
    body,
    /setIsProcessing:\s*turnInFlight\s*\?\s*\(\)\s*=>\s*\{\}\s*:\s*setIsProcessing/,
    'the slash handlers each call setIsProcessing(false); while the loop is busy '
    + 'that is a lie about a turn still in flight',
  );
});

test('whether a turn is in flight is read from the loop, not from React state', () => {
  // `isProcessing` in React is the UI's belief and is set true by this very
  // function. `agentLoop.isProcessing` is the loop's own truth.
  const body = submitBody();
  assert.match(body, /const turnInFlight = Boolean\(agentLoop\.isProcessing\)/);
});
