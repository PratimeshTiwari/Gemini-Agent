import test from 'node:test';
import assert from 'node:assert/strict';
import { ExtensionLock, mainLane, subLane, laneFor } from '../../src/bridge/extension-lock.js';

/** A lock with the sends recorded and the watchdog effectively off. */
function lock({ timeoutMs = 60_000 } = {}) {
  const sent = [];
  const stalled = [];
  const l = new ExtensionLock({
    send: (p) => sent.push(p),
    onStall: (lane, model) => stalled.push({ lane, model }),
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
    // The lane says what to release; the model says what to tell the person.
    assert.deepEqual(stalled, [{ lane: mainLane('chatgpt'), model: 'chatgpt' }]);
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
    assert.deepEqual(stalled, [{ lane: mainLane('chatgpt'), model: 'chatgpt' }]);
  });
});

/**
 * A lane is a tab, not a model.
 *
 * Keying by model was the only safe thing to do while the extension addressed
 * tabs by URL pattern and took whatever was last — two same-model requests
 * raced for one tab and could interleave two prompts into one conversation.
 * Tab identity landed in the extension, so a subagent turn now has its own tab
 * and shares nothing with the user's turn but the site.
 */
test('lanes are tabs', async (t) => {
  const sub = (targetModel, requestId, prompt) =>
    ({ targetModel, requestId, prompt, isSubagent: true });

  await t.test('a subagent turn does not wait behind the user\'s', () => {
    const { l, sent } = lock();
    l.enqueue(req('gemini', 'user'));
    l.enqueue(sub('gemini', 'r1', 'background'));
    assert.deepEqual(sent.map((p) => p.prompt), ['user', 'background'],
      'a GitHub turn queued behind whatever the user was typing');
  });

  await t.test('two subagents on the same model run at once', () => {
    const { l, sent } = lock();
    l.enqueue(sub('gemini', 'r1', 'a'));
    l.enqueue(sub('gemini', 'r2', 'b'));
    assert.deepEqual(sent.map((p) => p.prompt), ['a', 'b'],
      'ask_* is fanned out with Promise.all and was serial anyway');
  });

  await t.test('the user\'s own turns are still one at a time', () => {
    const { l, sent } = lock();
    l.enqueue(req('gemini', 'a'));
    l.enqueue(req('gemini', 'b'));
    assert.deepEqual(sent.map((p) => p.prompt), ['a'], 'one tab, one thread in it');
  });

  await t.test('a subagent with no requestId is serialised, not guessed at', () => {
    // Nothing tells two such turns apart, so sharing the main lane is the only
    // safe reading.
    const { l, sent } = lock();
    l.enqueue(req('gemini', 'user'));
    l.enqueue({ targetModel: 'gemini', isSubagent: true, prompt: 'nameless' });
    assert.deepEqual(sent.map((p) => p.prompt), ['user']);
  });

  await t.test('releasing a sub lane does not free the main one', () => {
    const { l, sent } = lock();
    l.enqueue(req('gemini', 'user1'));
    l.enqueue(req('gemini', 'user2'));
    l.enqueue(sub('gemini', 'r1', 'bg'));
    l.release(subLane('r1'));
    assert.deepEqual(sent.map((p) => p.prompt), ['user1', 'bg'], 'user2 was let out early');
    l.release('gemini');
    assert.deepEqual(sent.map((p) => p.prompt), ['user1', 'bg', 'user2']);
  });

  await t.test('sub lanes are not kept once they go idle', () => {
    const { l } = lock();
    l.enqueue(sub('gemini', 'r1', 'a'));
    assert.equal(l.lanes.has(subLane('r1')), true);
    l.release(subLane('r1'));
    assert.equal(l.lanes.has(subLane('r1')), false,
      'one entry per turn, kept forever, grows for the life of the session');
    // The main lane is the session's, and stays.
    l.enqueue(req('gemini', 'x'));
    l.release('gemini');
    assert.equal(l.lanes.has(mainLane('gemini')), true);
  });

  await t.test('abortAll clears both kinds', () => {
    const { l } = lock();
    l.enqueue(req('gemini', 'a'));
    l.enqueue(sub('gemini', 'r1', 'b'));
    l.abortAll();
    assert.equal(l.anyBusy, false);
    assert.equal(l.lanes.has(subLane('r1')), false);
  });

  await t.test('laneFor names what each payload belongs to', () => {
    assert.equal(laneFor({ targetModel: 'gemini' }), 'main:gemini');
    assert.equal(laneFor({ targetModel: 'chatgpt' }), 'main:chatgpt');
    assert.equal(laneFor({ targetModel: 'gemini', isSubagent: true, requestId: 'r1' }), 'sub:r1');
    assert.equal(laneFor({}), 'main:gemini');
    assert.equal(laneFor(undefined), 'main:gemini');
  });

  await t.test('a bare model name still means that model\'s main lane', () => {
    const { l } = lock();
    l.enqueue(req('chatgpt', 'a'));
    assert.equal(l.isBusy('chatgpt'), true);
    assert.equal(l.isBusy(mainLane('chatgpt')), true);
    l.release('chatgpt');
    assert.equal(l.isBusy('chatgpt'), false);
  });
});
