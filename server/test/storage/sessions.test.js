/**
 * Conversations that survive the start of the next one.
 *
 * `--sessions` and `--resume <id>` were in `--help`, parsed into config, and
 * **read by nothing**. Running them started the agent as though the flag were
 * absent — an advertised feature that silently did nothing, which is worse
 * than a missing one because there is no failure to notice.
 *
 * The reason they could not work: `history.jsonl` is a single rolling file and
 * starting without `--continue` wiped it, so there was never anything to list
 * or find. Every conversation was destroyed by the beginning of the next.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionStore } from '../../src/storage/session-store.js';
import { AgentLoop } from '../../src/core/agent-loop.js';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sess-'));
  process.env.AGENT_CLI_HOME = join(dir, 'home');
});
afterEach(() => {
  delete process.env.AGENT_CLI_HOME;
  rmSync(dir, { recursive: true, force: true });
});

const conversation = (store, first = 'walk me through the bridge') => {
  store.saveHistory([
    { role: 'user', content: first, timestamp: 1758000000000 },
    { role: 'assistant', content: 'It types into a tab.', timestamp: 1758000001000 },
  ]);
  return store;
};

describe('rollover — the operation that must happen before a destructive one', () => {
  test('a conversation survives the start of the next', () => {
    const store = conversation(new SessionStore(dir));
    const id = store.rollover();
    store.clear();

    assert.ok(id, 'nothing was filed');
    assert.deepEqual(store.loadHistory(), [], 'the live file should be empty now');
    assert.equal(store.listSessions().length, 1);
  });

  test('the title is the first thing the user said', () => {
    // What a person scanning a list looks for — not a timestamp, and not a
    // summary nobody asked a model to write.
    const store = conversation(new SessionStore(dir), 'why is the poller re-reading comments');
    store.rollover();
    assert.equal(store.listSessions()[0].title, 'why is the poller re-reading comments');
  });

  test('a long first message is cut, not stored whole', () => {
    const store = conversation(new SessionStore(dir), 'x'.repeat(400));
    store.rollover();
    assert.ok(store.listSessions()[0].title.length <= 72);
  });

  test('nothing to file files nothing', () => {
    assert.equal(new SessionStore(dir).rollover(), null);
    assert.deepEqual(new SessionStore(dir).listSessions(), []);
  });

  test('the thread goes with it, because that is what makes resuming honest', () => {
    const store = conversation(new SessionStore(dir));
    store.setThread({ model: 'gemini', id: 'bfaf9b2dad21f688' });
    store.rollover();
    assert.deepEqual(store.listSessions()[0].thread, { model: 'gemini', id: 'bfaf9b2dad21f688' });
  });

  /**
   * Order comes from the index, not from the id.
   *
   * The id carries a millisecond timestamp and reads as though sorting it
   * would order the list. It does not: two sessions filed in the same
   * millisecond fall back to a random suffix, which this test proved by
   * failing. The index is append-only, so its own order is the true one and
   * `listSessions` simply reverses it — which is also correct across
   * processes, where no id scheme would be.
   */
  test('the newest session is first, however close together they were filed', () => {
    const store = new SessionStore(dir);
    for (const first of ['one', 'two', 'three']) {
      conversation(store, first);
      store.rollover();
      store.clear();
    }
    assert.deepEqual(store.listSessions().map((s) => s.title), ['three', 'two', 'one']);
  });

  test('the id still says when, to the millisecond', () => {
    const store = conversation(new SessionStore(dir));
    const id = store.rollover();
    assert.match(id, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}-/);
    // Readable as a date without opening anything, which is the point of
    // putting it in the id at all.
    assert.equal(id.slice(0, 10), new Date().toISOString().slice(0, 10));
  });
});

describe('resumeSession', () => {
  test('a past conversation becomes the current one', () => {
    const store = conversation(new SessionStore(dir));
    const id = store.rollover();
    store.clear();

    const turns = store.resumeSession(id);
    assert.equal(turns.length, 2);
    assert.equal(store.loadHistory().length, 2, 'it was not made current');
  });

  // A resumed session with no thread would always be treated as needing a
  // replay: safe, and wrong.
  test('its thread comes back too', () => {
    const store = conversation(new SessionStore(dir));
    store.setThread({ model: 'gemini', id: 'abc123' });
    const id = store.rollover();
    store.clear();
    store.setThread({ model: 'gemini', id: 'something-else' });

    store.resumeSession(id);
    assert.deepEqual(store.getThread(), { model: 'gemini', id: 'abc123' });
  });

  test('an id that does not exist is null, and destroys nothing', () => {
    const store = conversation(new SessionStore(dir));
    assert.equal(store.resumeSession('no-such-session'), null);
    assert.equal(store.resumeSession(''), null);
    assert.equal(store.resumeSession(undefined), null);
    assert.equal(store.loadHistory().length, 2, 'it destroyed the live conversation');
  });
});

describe('both copies, because the home one exists to survive a wiped .agent/', () => {
  test('an archived session is written next to both histories', () => {
    const store = conversation(new SessionStore(dir));
    const id = store.rollover();
    assert.ok(existsSync(store._archivedFile(store.localFile, id)), 'missing beside the workspace copy');
    assert.ok(existsSync(store._archivedFile(store.homeFile, id)), 'missing beside the home copy');
  });

  test('a workspace whose .agent was wiped still lists its sessions', () => {
    const store = conversation(new SessionStore(dir));
    const id = store.rollover();
    rmSync(join(dir, '.agent'), { recursive: true, force: true });

    const fresh = new SessionStore(dir);
    assert.equal(fresh.listSessions().length, 1, 'the durable copy did not survive');
    assert.equal(fresh.resumeSession(id)?.length, 2);
  });
});

/**
 * The wiring, not just the store.
 *
 * The store tests above all pass with the rollover removed from the agent
 * loop, because they exercise `SessionStore` directly. The fault being fixed
 * lives in the *caller*: starting without `--continue` called `clear()` and
 * nothing else, so every conversation was destroyed by the start of the next
 * one and there was never anything for `--sessions` to list.
 */
describe('starting the agent', () => {
  const start = (opts) => new AgentLoop({
    workspace: dir, mcpServer: {}, promptBuilder: {}, diffEngine: {}, riskClassifier: {}, ...opts,
  });

  test('a fresh start files the previous conversation instead of wiping it', () => {
    conversation(new SessionStore(dir), 'the earlier conversation');
    start({});

    const store = new SessionStore(dir);
    assert.deepEqual(store.loadHistory(), [], 'it should start clean');
    assert.equal(store.listSessions().length, 1, 'the previous conversation was destroyed');
    assert.equal(store.listSessions()[0].title, 'the earlier conversation');
  });

  test('--continue leaves the conversation alone and files nothing', () => {
    conversation(new SessionStore(dir));
    start({ continueSession: true });

    const store = new SessionStore(dir);
    assert.equal(store.loadHistory().length, 2, 'it cleared a session it was asked to continue');
    assert.deepEqual(store.listSessions(), [], 'nothing should have been filed');
  });

  test('--resume makes that conversation the current one', () => {
    const store = conversation(new SessionStore(dir), 'the one to come back to');
    const id = store.rollover();
    store.clear();
    conversation(store, 'something else entirely');

    start({ resumeSessionId: id });
    const after = new SessionStore(dir).loadHistory();
    assert.equal(after.length, 2);
    assert.equal(after[0].content, 'the one to come back to');
  });

  test('--resume with a bad id changes nothing rather than wiping', () => {
    conversation(new SessionStore(dir), 'still here');
    start({ resumeSessionId: 'no-such-session' });
    assert.equal(new SessionStore(dir).loadHistory()[0].content, 'still here');
  });

  test('a first ever run files nothing', () => {
    start({});
    assert.deepEqual(new SessionStore(dir).listSessions(), []);
  });
});
