/**
 * Whether the model actually remembers a session.
 *
 * `history.jsonl` is the *human's* record — it is never replayed into a
 * browser tab, so restoring it tells the model nothing. The model's memory is
 * the chat thread, and Gemini puts that thread's identity in the URL:
 *
 *     https://gemini.google.com/app/bfaf9b2dad21f688
 *
 * Which is the only way to tell, from outside, whether resuming a session can
 * simply carry on or has to explain what happened first. Getting that wrong in
 * the silent direction produces an agent answering confidently about a
 * conversation it never had.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { threadFromUrl, sameThread, planResume } from '../../src/core/chat-thread.js';

const GEM = 'https://gemini.google.com/app/bfaf9b2dad21f688';

describe('threadFromUrl', () => {
  test('a Gemini conversation', () => {
    assert.deepEqual(threadFromUrl(GEM), { model: 'gemini', id: 'bfaf9b2dad21f688' });
  });

  // ChatGPT was removed. A URL we no longer bridge is not a thread, and
  // saying so is what keeps `planResume` honest about the sessions below.
  test('a ChatGPT conversation is no longer a thread', () => {
    assert.equal(threadFromUrl('https://chatgpt.com/c/abc-123'), null);
  });

  // Not a failure. A chat only gets an id once it has something to identify,
  // so a session captured before its first reply genuinely has no thread.
  test('a brand-new chat has no id yet, and that is an answer', () => {
    assert.equal(threadFromUrl('https://gemini.google.com/app'), null);
    assert.equal(threadFromUrl('https://gemini.google.com/app/'), null);
  });

  test('query strings and fragments do not become part of the id', () => {
    assert.equal(threadFromUrl(`${GEM}?hl=en`).id, 'bfaf9b2dad21f688');
    assert.equal(threadFromUrl(`${GEM}#top`).id, 'bfaf9b2dad21f688');
  });

  test('a lookalike host is not a conversation', () => {
    assert.equal(threadFromUrl('https://gemini.google.com.evil.test/app/abc'), null);
    assert.equal(threadFromUrl('https://example.com/app/abc'), null);
  });

  test('rubbish in, null out', () => {
    for (const v of [null, undefined, '', 42, {}]) assert.equal(threadFromUrl(v), null);
  });
});

describe('planResume — three outcomes, because they are three promises', () => {
  const was = threadFromUrl(GEM);

  test('the same conversation can simply carry on', () => {
    const plan = planResume(was, threadFromUrl(GEM));
    assert.equal(plan.action, 'continue');
    assert.match(plan.reason, /remembers/);
  });

  test('a different conversation needs telling what happened', () => {
    const plan = planResume(was, threadFromUrl('https://gemini.google.com/app/999aaa'));
    assert.equal(plan.action, 'replay');
    assert.match(plan.reason, /different conversation/);
  });

  test('a fresh chat remembers nothing', () => {
    const plan = planResume(was, threadFromUrl('https://gemini.google.com/app'));
    assert.equal(plan.action, 'replay');
  });

  test('a session that never had a thread can only be viewed', () => {
    assert.equal(planResume(null, threadFromUrl(GEM)).action, 'view');
  });

  /*
   * Sessions filed before ChatGPT was removed still carry a ChatGPT thread.
   * They need no migration: the models differ, so this resolves to `replay`,
   * which is the truth — the conversation exists, and nothing here can reopen
   * it. Pinned because "no migration needed" is a claim, not an observation.
   */
  test('a stored ChatGPT session degrades to replay, not continue', () => {
    const old = { model: 'chatgpt', id: 'abc-123' };
    assert.equal(planResume(old, threadFromUrl(GEM)).action, 'replay');
    assert.equal(planResume(old, null).action, 'replay');
    assert.equal(sameThread(old, threadFromUrl(GEM)), false);
  });

  // "We cannot tell" is handled as "no". Telling the model what happened when
  // it already knew costs a summary; the other way round costs the truth.
  test('unknown on either side is never `continue`', () => {
    assert.notEqual(planResume(was, null).action, 'continue');
    assert.notEqual(planResume(null, null).action, 'continue');
    assert.equal(sameThread(was, null), false);
    assert.equal(sameThread(null, was), false);
  });

  test('the same id on a different site is a different conversation', () => {
    assert.equal(sameThread(
      { model: 'gemini', id: 'abc' },
      { model: 'chatgpt', id: 'abc' },
    ), false);
  });
});
