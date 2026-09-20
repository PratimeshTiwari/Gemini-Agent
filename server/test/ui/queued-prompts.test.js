/**
 * Prompts typed during a turn: queued, shown, and reclaimable.
 *
 * `AgentLoop.handleUserMessage` returns early when busy, pushing only a
 * transient status line the thinking cycle paints over — so the message was
 * discarded, after `handleSubmit` had already echoed it and cleared the box.
 * Reported as four prompts typed, one reply. `queuedUserMessage` existed on
 * the loop as a field and was never read or written.
 *
 * These are source assertions: the behaviour needs a live turn under the pty
 * harness, where it is verified end to end (marker renders, up-arrow returns
 * the text to the box, and the reclaimed prompt is never answered). What is
 * pinned here is the reasoning that is easy to undo in a refactor.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const app = readFileSync(join(here, '../../src/ui/App.jsx'), 'utf8');
const keys = readFileSync(join(here, '../../src/ui/hooks/use-key-bindings.js'), 'utf8');

test('busy is read from the loop, not from React state', () => {
  // React's `isProcessing` is set by handleSubmit itself, so asking it whether
  // a turn is running answers a question about this function, not the agent.
  const submit = app.slice(app.indexOf('const handleSubmit'));
  assert.match(submit.slice(0, 4000), /if \(agentLoop\.isProcessing\) \{\s*\n\s*setQueued/);
});

test('draining waits for the loop, a closed diff prompt and no open menu', () => {
  // The two isProcessing flags disagree during an approval; draining then
  // would inject a prompt into a turn parked on a decision.
  const drain = app.slice(app.indexOf('Send the next queued prompt'));
  for (const guard of ['agentLoop.isProcessing', 'diffRequest', 'activeMenu']) {
    assert.ok(drain.slice(0, 900).includes(guard), `drain must be gated on ${guard}`);
  }
});

test('stopping clears the queue', () => {
  // Otherwise a stop is followed immediately by the next queued prompt.
  const stop = app.slice(app.indexOf('Agent forcefully stopped') - 2000,
    app.indexOf('Agent forcefully stopped') + 500);
  assert.match(stop, /setQueued\(\[\]\)/);
});

test('up-arrow only reclaims a queued prompt when the box is empty', () => {
  // Half a typed sentence must not be replaced by something queued earlier.
  assert.match(keys, /queued\.length > 0 && input === ''/);
});

test('reclaiming removes it from the queue', () => {
  // Otherwise the prompt is both in the box and still due to be sent.
  const block = keys.slice(keys.indexOf("queued.length > 0 && input === ''"));
  assert.match(block.slice(0, 400), /setQueued\(\(q\) => q\.slice\(0, -1\)\)/);
});
