import test from 'node:test';
import assert from 'node:assert/strict';
import { splitTrailingEnter } from '../../src/ui/enter-splitter.js';

test('splitTrailingEnter', async (t) => {
  await t.test('leaves a lone keypress alone', () => {
    assert.deepEqual(splitTrailingEnter('a'), ['a']);
    assert.deepEqual(splitTrailingEnter('\r'), ['\r']);
    assert.deepEqual(splitTrailingEnter(''), ['']);
  });

  await t.test('peels a trailing return off the character it arrived with', () => {
    assert.deepEqual(splitTrailingEnter('i\r'), ['i', '\r']);
    assert.deepEqual(splitTrailingEnter('hello\r'), ['hello', '\r']);
    assert.deepEqual(splitTrailingEnter('hello\n'), ['hello', '\n']);
  });

  await t.test('leaves interior newlines where they are', () => {
    assert.deepEqual(splitTrailingEnter('one\ntwo'), ['one\ntwo']);
    assert.deepEqual(splitTrailingEnter('one\ntwo\r'), ['one\ntwo', '\r']);
  });

  await t.test('never touches a bracketed paste', () => {
    const paste = '\x1b[200~line one\nline two\n\x1b[201~';
    assert.deepEqual(splitTrailingEnter(paste), [paste]);
  });

  await t.test('never touches an escape sequence', () => {
    // Esc+Enter is the terminal asking for a newline, not a submit; splitting
    // it would turn every Shift+Enter fallback into a send.
    assert.deepEqual(splitTrailingEnter('\x1b\r'), ['\x1b\r']);
  });
});
