/**
 * A notice raised outside a turn has to land somewhere.
 *
 * `_notify` sends `type: 'status'`, and every front-end reads that as the label
 * on the **spinner** — which only exists while a turn is running. The CLI
 * registers its callbacks per-submit, so between turns nothing was listening at
 * all, and the background set broadcasts to the extension and the side panel
 * only.
 *
 * That is not cosmetic. `/effort` runs outside a turn, so
 * *"✓ Browser model is now 3.1 Pro"* — the confirmation that the model switch
 * **worked** — was invisible in the terminal for the entire time that feature
 * was being debugged. So was every connect-time row, `extension_stale`
 * included, which is why a stale build could run unnoticed. Both were reported
 * as the feature not working; both were the screen having no way to say so.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop } from '../../src/core/agent-loop.js';

const notify = AgentLoop.prototype._notify;
const setNoticeSink = AgentLoop.prototype.setNoticeSink;

/** Just the fields `_notify` touches. */
function loop({ processing = false, callbacks = null, background = null } = {}) {
  const l = {
    isProcessing: processing,
    callbacks,
    _backgroundCallbacks: background,
    rows: [],
  };
  setNoticeSink.call(l, (text) => l.rows.push(text));
  return l;
}

const sink = (l) => l.rows;

test('outside a turn it becomes a row, because nothing else draws it', () => {
  const l = loop({ processing: false });
  notify.call(l, '✓ Browser model is now 3.1 Pro');

  assert.deepEqual(sink(l), ['✓ Browser model is now 3.1 Pro']);
});

/*
 * During a turn the spinner is on screen and carries this already. Appending a
 * row as well would print every status line twice, including the per-tool
 * "Running read_file…" chatter that fires several times a turn.
 */
test('during a turn it does not, because the spinner already has it', () => {
  const l = loop({ processing: true });
  notify.call(l, 'Running read_file...');

  assert.deepEqual(sink(l), [], 'every status line would be printed twice');
});

test('the panel and the extension still get it either way', () => {
  const sent = [];
  const l = loop({ processing: false, background: { sendToPanel: (m) => sent.push(m) } });
  notify.call(l, 'hello');

  assert.equal(sent.length, 1, 'the side panel stopped being told');
  assert.equal(sent[0].type, 'status');
  assert.equal(sent[0].payload.message, 'hello');
  assert.deepEqual(sink(l), ['hello'], 'and the terminal was told as well');
});

/*
 * The loop runs headless too — batch tasks, and the side panel as the only
 * front-end. Neither registers a sink, and `_notify` must not care.
 */
test('with no sink registered it is a no-op, not a crash', () => {
  const l = { isProcessing: false, callbacks: null, _backgroundCallbacks: null };
  assert.doesNotThrow(() => notify.call(l, 'nobody is listening'));
});

test('and unregistering stops it, so a torn-down UI is not written to', () => {
  const l = loop({ processing: false });
  setNoticeSink.call(l, null);
  notify.call(l, 'after unmount');

  assert.deepEqual(sink(l), []);
});

// Anything that is not callable is the same as nothing, rather than something
// that throws on the next notice — this is set from a React effect, where a
// stale value is an ordinary hazard.
test('a non-function sink is refused rather than stored', () => {
  const l = loop({ processing: false });
  setNoticeSink.call(l, 'not a function');
  assert.doesNotThrow(() => notify.call(l, 'x'));
});

/*
 * The negative control. Without it this file passes against a `_notify` that
 * sends nothing anywhere — which would be a far worse bug than the one it
 * covers, since the side panel is a supported surface.
 */
test('a notice with a live turn still reaches the front-end', () => {
  const sent = [];
  const l = loop({ processing: true, callbacks: { sendToPanel: (m) => sent.push(m) } });
  notify.call(l, 'mid-turn');

  assert.equal(sent.length, 1, 'the live turn stopped receiving status updates');
});
