import test from 'node:test';
import assert from 'node:assert/strict';
import { extractHotkeys, HOTKEYS } from '../../src/ui/hotkeys.js';

const CTRL_E = '\x05';
const CTRL_O = '\x0f';
const CTRL_T = '\x14';

test('extractHotkeys', async (t) => {
  await t.test('passes ordinary typing straight through', () => {
    const r = extractHotkeys('hello');
    assert.equal(r.text, 'hello');
    assert.deepEqual(r.hotkeys, []);
  });

  await t.test('removes a chord so the text field never sees it', () => {
    // This is the bug: ink-text-input types any key it does not recognise, so
    // a ctrl+e that reaches Ink leaves a stray "e" in the prompt.
    const r = extractHotkeys(CTRL_E);
    assert.equal(r.text, '');
    assert.deepEqual(r.hotkeys, ['expand']);
  });

  await t.test('removes a chord that arrived glued to typed text', () => {
    const r = extractHotkeys(`ab${CTRL_T}cd`);
    assert.equal(r.text, 'abcd');
    assert.deepEqual(r.hotkeys, ['terminal']);
  });

  await t.test('reports several chords in order', () => {
    const r = extractHotkeys(`${CTRL_O}x${CTRL_E}`);
    assert.equal(r.text, 'x');
    assert.deepEqual(r.hotkeys, ['tabs', 'expand']);
  });

  await t.test('leaves ctrl+c alone — Ink owns exiting', () => {
    const r = extractHotkeys('\x03');
    assert.equal(r.text, '\x03');
    assert.deepEqual(r.hotkeys, []);
  });

  await t.test('never strips inside a bracketed paste', () => {
    // A pasted file can legitimately contain 0x05; removing it would corrupt
    // the paste and fire a phantom shortcut.
    const paste = `\x1b[200~before${CTRL_E}after\x1b[201~`;
    const r = extractHotkeys(paste);
    assert.equal(r.text, paste);
    assert.deepEqual(r.hotkeys, []);
  });

  await t.test('keeps paste state across chunks', () => {
    const a = extractHotkeys(`\x1b[200~line one${CTRL_E}`);
    assert.equal(a.state.inPaste, true);
    assert.deepEqual(a.hotkeys, []);
    assert.equal(a.text, `\x1b[200~line one${CTRL_E}`);

    const b = extractHotkeys(`still pasting${CTRL_O}\x1b[201~${CTRL_T}`, a.state);
    assert.equal(b.state.inPaste, false);
    assert.deepEqual(b.hotkeys, ['terminal']);
    assert.equal(b.text, `still pasting${CTRL_O}\x1b[201~`);
  });

  await t.test('every mapped chord is a single control byte', () => {
    for (const key of Object.keys(HOTKEYS)) {
      assert.equal(key.length, 1);
      assert.ok(key.charCodeAt(0) < 32, `${JSON.stringify(key)} is not a control byte`);
    }
  });
});
