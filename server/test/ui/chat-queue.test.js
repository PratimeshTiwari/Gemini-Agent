import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { selectionMarker, selectionBody, drainChatQueue } from '../../src/ui/chat-queue.js';

const freshWorkspace = () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'chatq-'));
  fs.mkdirSync(path.join(ws, '.agent/state'), { recursive: true });
  return ws;
};
const queue = (ws, ...entries) => fs.writeFileSync(
  path.join(ws, '.agent/state/chat-queue.jsonl'),
  entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
);

test('selectionMarker', async (t) => {
  await t.test('is short and reads as a reference', () => {
    assert.equal(selectionMarker({ file: 'src/ui/App.jsx', startLine: 12, endLine: 40 }), '@App.jsx:12-40');
  });

  await t.test('collapses a single line', () => {
    assert.equal(selectionMarker({ file: 'a/b/x.js', startLine: 7, endLine: 7 }), '@x.js:7');
  });
});

test('selectionBody', async (t) => {
  await t.test('gives the model the path, the range and a fenced block', () => {
    const body = selectionBody({ file: 'src/x.js', startLine: 1, endLine: 2, text: 'const a = 1;', language: 'javascript' });
    assert.match(body, /src\/x\.js \(lines 1-2\)/);
    assert.match(body, /```javascript/);
    assert.match(body, /const a = 1;/);
  });

  await t.test('still fences when the language is unknown', () => {
    assert.match(selectionBody({ file: 'x', startLine: 1, endLine: 1, text: 'hi' }), /```\nhi\n```/);
  });
});

test('drainChatQueue', async (t) => {
  await t.test('is empty, not an error, when nothing is queued', () => {
    assert.deepEqual(drainChatQueue(freshWorkspace()), []);
  });

  await t.test('returns each queued selection as an attachment', () => {
    const ws = freshWorkspace();
    queue(ws,
      { file: 'src/a.js', startLine: 1, endLine: 3, text: 'one', language: 'javascript' },
      { file: 'src/b.js', startLine: 9, endLine: 9, text: 'two' });
    const got = drainChatQueue(ws);
    assert.deepEqual(got.map((g) => g.marker), ['@a.js:1-3', '@b.js:9']);
    assert.match(got[0].text, /one/);
  });

  await t.test('clears the queue so a selection attaches once', () => {
    const ws = freshWorkspace();
    queue(ws, { file: 'x.js', startLine: 1, endLine: 1, text: 'only once' });
    assert.equal(drainChatQueue(ws).length, 1);
    assert.deepEqual(drainChatQueue(ws), []);
  });

  await t.test('skips a half-written line rather than losing the whole queue', () => {
    // The companion appends; a read can land mid-write.
    const ws = freshWorkspace();
    fs.writeFileSync(path.join(ws, '.agent/state/chat-queue.jsonl'),
      JSON.stringify({ file: 'good.js', startLine: 1, endLine: 1, text: 'kept' }) + '\n{"file":"trunc');
    const got = drainChatQueue(ws);
    assert.equal(got.length, 1);
    assert.equal(got[0].marker, '@good.js:1');
  });

  await t.test('ignores an entry with no text', () => {
    const ws = freshWorkspace();
    queue(ws, { file: 'empty.js', startLine: 1, endLine: 1 });
    assert.deepEqual(drainChatQueue(ws), []);
  });
});
