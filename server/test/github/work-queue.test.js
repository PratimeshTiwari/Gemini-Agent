/**
 * One at a time, never twice, with a pause — and nothing about GitHub in it.
 *
 * Extracted from `github-event-handler.js`, which did four jobs and called
 * itself glue. Each of the three rules is paid for by something real: every
 * item drives a browser tab, the poller re-reports a comment whenever its
 * watermark overlaps a poll, and consecutive analyses inside a few seconds is
 * what a rate limit looks like from the other side.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { WorkQueue } from '../../src/github/work-queue.js';

/** A queue whose cooldown is a recorded call rather than a real wait. */
function queue({ run, ...over } = {}) {
  const ran = [];
  const scheduled = [];
  const q = new WorkQueue({
    identify: (item) => item.id,
    run: run || (async (item) => { ran.push(item.id); }),
    // The cooldown is fired by hand, so a 30-second pause costs nothing here.
    schedule: (ms, fn) => scheduled.push({ ms, fn }),
    ...over,
  });
  return { q, ran, scheduled, tick: () => scheduled.shift()?.fn() };
}

const settle = () => new Promise((r) => setTimeout(r, 5));

describe('one at a time', () => {
  test('the first item starts immediately', async () => {
    const { q, ran } = queue();
    q.add({ id: 1 });
    await settle();
    assert.deepEqual(ran, [1]);
  });

  test('the second waits for the first to finish', async () => {
    let release;
    const { q, ran, scheduled, tick } = queue({
      run: async (item) => { ran.push(item.id); await new Promise((r) => { release = r; }); },
    });
    q.add({ id: 1 });
    q.add({ id: 2 });
    await settle();
    assert.deepEqual(ran, [1], 'two analyses overlapped, in two browser tabs');
    release();
    await settle();
    assert.equal(scheduled.length, 1, 'the next one started with no cooldown');
    tick();
    await settle();
    assert.deepEqual(ran, [1, 2]);
  });

  test('the cooldown is only paid when something is waiting', async () => {
    const { q, scheduled } = queue();
    q.add({ id: 1 });
    await settle();
    assert.equal(scheduled.length, 0, 'an idle queue slept for 30 seconds');
  });
});

describe('never twice', () => {
  test('an item already done is refused', async () => {
    const { q, ran } = queue();
    assert.equal(q.add({ id: 1 }), true);
    await settle();
    assert.equal(q.add({ id: 1 }), false);
    await settle();
    assert.deepEqual(ran, [1]);
  });

  test('an item already queued is refused', async () => {
    let release;
    const { q } = queue({ run: async () => { await new Promise((r) => { release = r; }); } });
    q.add({ id: 1 });
    await settle();
    assert.equal(q.add({ id: 2 }), true);
    assert.equal(q.add({ id: 2 }), false, 'the same comment was queued twice');
    release();
  });

  test('force runs it again', async () => {
    const { q, ran } = queue();
    q.add({ id: 1 });
    await settle();
    assert.equal(q.add({ id: 1 }, { force: true }), true);
    await settle();
    assert.deepEqual(ran, [1, 1]);
  });

  test('identity is the caller\'s, not the object\'s', async () => {
    // The poller returns a fresh object for the same comment on every poll, so
    // identity has to be a field rather than the reference.
    const { q, ran } = queue();
    q.add({ id: 7, seen: 1 });
    await settle();
    assert.equal(q.add({ id: 7, seen: 2 }), false);
    assert.deepEqual(ran, [7]);
  });
});

describe('a failure must not wedge it', () => {
  test('a thrown run is caught, not left as an unhandled rejection', async () => {
    // `_drain` is started without being awaited — it has to be, or `add` would
    // block on a browser turn — so an escaping throw is an unhandled rejection,
    // which Node may answer by taking the CLI down.
    const seen = [];
    const { q, ran } = queue({
      run: async (item) => { ran.push(item.id); if (item.id === 1) throw new Error('browser exploded'); },
      onError: (err, item) => seen.push([err.message, item.id]),
    });
    q.add({ id: 1 });
    q.add({ id: 2 });
    await settle();
    assert.deepEqual(seen, [['browser exploded', 1]]);
    assert.equal(q.busy, false, 'the lock was held for the rest of the session');
  });

  test('and the queue drains after it', async () => {
    const { q, ran, tick } = queue({
      run: async (item) => { ran.push(item.id); if (item.id === 1) throw new Error('boom'); },
      onError: () => {},
    });
    q.add({ id: 1 });
    q.add({ id: 2 });
    await settle();
    tick();
    await settle();
    assert.deepEqual(ran, [1, 2], 'every later comment queued behind a failed one');
  });
});

describe('what it reports', () => {
  test('the item in flight is readable, and cleared after', async () => {
    let release;
    const started = [];
    const { q } = queue({
      run: async () => { started.push(q.current); await new Promise((r) => { release = r; }); },
    });
    q.add({ id: 1 });
    await settle();
    assert.equal(started[0].id, 1);
    release();
    await settle();
    assert.equal(q.current, null, 'it was left set after the turn ended');
  });

  test('onStart and onFinish bracket the run', async () => {
    const order = [];
    const { q } = queue({
      run: async (i) => { order.push(`run ${i.id}`); },
      onStart: (i) => order.push(`start ${i.id}`),
      onFinish: (i) => order.push(`finish ${i.id}`),
    });
    q.add({ id: 1 });
    await settle();
    assert.deepEqual(order, ['start 1', 'run 1', 'finish 1']);
  });

  test('length counts what is waiting, not what is running', async () => {
    let release;
    const { q } = queue({ run: async () => { await new Promise((r) => { release = r; }); } });
    q.add({ id: 1 });
    q.add({ id: 2 });
    await settle();
    assert.equal(q.length, 1);
    release();
  });
});
