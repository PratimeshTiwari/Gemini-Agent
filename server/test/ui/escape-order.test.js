/**
 * Escape must clear the line before it is allowed to kill a turn.
 *
 * The order inside the escape branch was: close the slash palette, else stop
 * the running turn, else tidy up. Stopping the turn was therefore the
 * *fallback*, and reaching it took nothing more than having text in the box
 * that the palette did not recognise — `//effort` does not match
 * `/^\/[a-z-]*$/`, and `/efforttt` matches the shape but no command, so
 * `slashOpen` is false for both.
 *
 * Reported twice, once per spelling: typed a command, changed their mind,
 * pressed escape, and the reply the browser was still producing was thrown
 * away. Nothing in the UI said the turn had been cancelled rather than hung.
 *
 * A source assertion, for the same two reasons as
 * `local-command-during-turn.test.js`: observing it needs a live turn under a
 * pty with a fake extension, and the regression is invisible in review —
 * moving one `if` above another reads as tidying.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../../src/ui/hooks/use-key-bindings.js'), 'utf8');

/** The escape branch, stripped of comments — a grep matches prose otherwise. */
function escapeBody() {
  const start = src.indexOf('if (key.escape) {');
  assert.ok(start > -1, 'the escape branch should still exist');
  const end = src.indexOf('\n    }', start);
  assert.ok(end > start, 'could not find the end of the escape branch');
  return src.slice(start, end)
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

test('a non-empty input is cleared before the turn is stopped', () => {
  const body = escapeBody();
  const clears = body.indexOf('if (input)');
  const stops = body.indexOf(":stop");
  assert.ok(clears > -1, 'escape no longer clears a non-empty input');
  assert.ok(stops > -1, 'escape no longer stops a running turn');
  assert.ok(
    clears < stops,
    'escape stops the turn before clearing the line — text in the box would cancel a turn',
  );
});

test('the palette is still closed first of all', () => {
  const body = escapeBody();
  assert.ok(body.indexOf('if (slashOpen)') < body.indexOf('if (input)'));
});

test('stopping a turn is still one key away from an empty prompt', () => {
  // The interrupt did not become two keys — it became "escape on an empty
  // line", which is the state you are in when the thing you want to stop is
  // the turn and not what you were typing.
  assert.ok(/if \(isProcessing\) \{\s*handleSubmit\(':stop'\);/.test(escapeBody()));
});

test('`input` is a binding this hook actually receives', () => {
  // It was already in the parameter list, read only by the history keys. A
  // guard on a name that is not destructured throws at the first keypress.
  const params = src.slice(src.indexOf('export function useKeyBindings({'), src.indexOf('}) {'));
  assert.match(params, /\binput,/);
});
