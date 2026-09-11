import test from 'node:test';
import assert from 'node:assert/strict';
import { ExtensionLock } from '../../src/bridge/extension-lock.js';

/** A lock with the sends recorded and the watchdog effectively off. */
function lock({ timeoutMs = 60_000 } = {}) {
  const sent = [];
  const stalled = [];
  const l = new ExtensionLock({
    send: (p) => sent.push(p),
    onStall: (m) => stalled.push(m),
    timeoutMs,
  });
  return { l, sent, stalled };
}

const req = (targetModel, id) => ({ targetModel, prompt: id });

test('one in-flight prompt per tab', async (t) => {
  await t.test('the first prompt for a model goes straight out', () => {
    const { l, sent } = lock();
    l.enqueue(req('gemini', 'a'));
    assert.deepEqual(sent.map((p) => p.prompt), ['a']);
    assert.equal(l.isBusy('gemini'), true);
  });

  await t.test('a second prompt for the same tab waits', () => {
    const { l, sent } = lock();
    l.enqueue(req('gemini', 'a'));
    l.enqueue(req('gemini', 'b'));
    assert.deepEqual(sent.map((p) => p.prompt), ['a'], 'one tab, one conversation');

    l.release('gemini');
    assert.deepEqual(sent.map((p) => p.prompt), ['a', 'b']);
  });

  // This is the whole point of the phase: `_executeToolCalls` fans the ask_*
  // calls out with Promise.all, and a single global lock made them strictly
  // serial anyway.
  await t.test('a different model does not wait behind the first', () => {
    const { l, sent } = lock();
    l.enqueue(req('gemini', 'main'));
    l.enqueue(req('chatgpt', 'review'));
    assert.deepEqual(sent.map((p) => p.prompt), ['main', 'review']);
    assert.equal(l.isBusy('gemini'), true);
    assert.equal(l.isBusy('chatgpt'), true);
  });

  await t.test('releasing one lane leaves the other alone', () => {
    const { l } = lock();
    l.enqueue(req('gemini', 'main'));
    l.enqueue(req('chatgpt', 'review'));

    l.release('chatgpt');
    assert.equal(l.isBusy('chatgpt'), false);
    assert.equal(l.isBusy('gemini'), true, 'the main turn is still running');
    assert.equal(l.anyBusy, true);
  });

  await t.test('a model nobody has used is not busy', () => {
    const { l } = lock();
    assert.equal(l.isBusy('chatgpt'), false);
    assert.equal(l.anyBusy, false);
  });

  await t.test('a missing targetModel lands on the default lane', () => {
    const { l, sent } = lock();
    l.enqueue({ prompt: 'a' });
    l.enqueue({ prompt: 'b' });
    assert.deepEqual(sent.map((p) => p.prompt), ['a'], 'still serialised, not dropped');
    assert.equal(l.isBusy('gemini'), true);
  });
});

test('giving up', async (t) => {
  await t.test('abortAll drops what is queued and frees every lane', () => {
    const { l, sent } = lock();
    l.enqueue(req('gemini', 'a'));
    l.enqueue(req('gemini', 'b'));
    l.enqueue(req('chatgpt', 'c'));

    l.abortAll();
    assert.equal(l.anyBusy, false);

    // The queued prompts belonged to the turn that just died; replaying them
    // would send stale work into a fresh conversation.
    l.release('gemini');
    assert.deepEqual(sent.map((p) => p.prompt), ['a', 'c']);
  });

  await t.test('releasing an idle lane is harmless', () => {
    const { l, sent } = lock();
    l.release('gemini');
    l.release('gemini');
    assert.deepEqual(sent, []);
  });
});

test('the stall watchdog is per lane', async (t) => {
  await t.test('a quiet tab is reported by name', async () => {
    const { l, stalled } = lock({ timeoutMs: 5 });
    l.enqueue(req('chatgpt', 'a'));
    await new Promise((r) => setTimeout(r, 25));
    assert.deepEqual(stalled, ['chatgpt']);
  });

  await t.test('a tab that answered in time is not reported', async () => {
    const { l, stalled } = lock({ timeoutMs: 30 });
    l.enqueue(req('gemini', 'a'));
    l.release('gemini');
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(stalled, []);
  });

  await t.test('one lane stalling says nothing about the other', async () => {
    const { l, stalled } = lock({ timeoutMs: 20 });
    l.enqueue(req('gemini', 'a'));
    l.enqueue(req('chatgpt', 'b'));
    l.release('gemini');
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(stalled, ['chatgpt']);
  });
});
