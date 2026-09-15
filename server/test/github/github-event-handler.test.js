/**
 * The orchestrator, pinned before it is split.
 *
 * 357 lines doing four jobs — the work queue, the review task, plan writing and
 * the event wiring — with no tests. Phase 7 pulls those apart, and moving
 * untested code is how behaviour changes without anyone deciding to.
 *
 * These are **characterisation** tests. The poller is stubbed at the seam it
 * already has (an EventEmitter), so nothing here touches the network, and the
 * agent loop is a stub too: `runHeadlessTask` drives a browser tab, which is
 * exactly the dependency the split is meant to make optional.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { GitHubEventHandler } from '../../src/github/github-event-handler.js';

let ws;
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'ghe-')); });
afterEach(() => rmSync(ws, { recursive: true, force: true }));

/** A handler whose poller never polls and whose agent never opens a browser. */
function handler({ analysis = { success: true, result: '# Plan' }, onTask } = {}) {
  const h = new GitHubEventHandler({
    token: 't',
    workspace: ws,
    configOverrides: { repos: ['octo/repo'] },
    agentLoop: {
      workspace: ws,
      runHeadlessTask: async (prompt) => {
        onTask?.(prompt);
        if (analysis instanceof Error) throw analysis;
        return analysis;
      },
    },
  });
  // Nothing in these tests should reach the network.
  h.poller.start = async () => {};
  h.poller.stop = () => {};
  h.poller.pollNow = async () => {};
  return h;
}

const PR = { number: 3, title: 'Add a thing', head_ref: 'feat/x', repo: { full_name: 'octo/repo' }, key: 'octo/repo#3' };
const comment = (over = {}) => ({
  id: 1, body: 'Please rename this variable to something clearer.',
  author: 'alice', created_at: 'x', html_url: 'u', type: 'issue_comment', ...over,
});

/** Let the queue drain — it is kicked off without being awaited. */
const settle = () => new Promise((r) => setTimeout(r, 30));

describe('the work queue', () => {
  test('a comment is analysed and a plan is written', async () => {
    const h = handler();
    const plans = [];
    h.on('plan_generated', (e) => plans.push(e));
    h._enqueueComment({ pr: PR, comment: comment() });
    await settle();
    assert.equal(plans.length, 1);
    assert.ok(plans[0].filePath, 'no file was written');
  });

  test('the same comment is not analysed twice', async () => {
    // The poller re-reports a comment whenever its watermark overlaps, so this
    // is the only thing standing between a re-poll and a duplicate plan.
    const h = handler();
    let runs = 0;
    h.on('processing_started', () => { runs += 1; });
    h._enqueueComment({ pr: PR, comment: comment() });
    await settle();
    h._enqueueComment({ pr: PR, comment: comment() });
    await settle();
    assert.equal(runs, 1);
  });

  test('force re-analyses one that was already seen', async () => {
    const h = handler();
    let runs = 0;
    h.on('processing_started', () => { runs += 1; });
    h._enqueueComment({ pr: PR, comment: comment() });
    await settle();
    h._enqueueComment({ pr: PR, comment: comment(), force: true });
    await settle();
    assert.equal(runs, 2);
  });

  test('one comment at a time, because each one drives a browser tab', async () => {
    const h = handler();
    const order = [];
    h.on('processing_started', (e) => order.push(`start ${e.commentId}`));
    h.on('processing_finished', (e) => order.push(`done ${e.commentId}`));
    h._enqueueComment({ pr: PR, comment: comment({ id: 1 }) });
    h._enqueueComment({ pr: PR, comment: comment({ id: 2 }) });
    await settle();
    assert.equal(order[0], 'start 1');
    assert.equal(order[1], 'done 1', 'two analyses overlapped');
  });

  test('what is being analysed right now is reportable', async () => {
    const h = handler();
    let seen = null;
    h.on('processing_started', () => { seen = h._currentAnalysis; });
    h._enqueueComment({ pr: PR, comment: comment() });
    await settle();
    assert.equal(seen.commentId, 1);
    assert.equal(seen.prNumber, 3);
    assert.equal(h._currentAnalysis, null, 'it was left set after the turn ended');
  });
});

describe('what counts as noise, which is narrower than it looks', () => {
  test('an empty comment costs no turn', async () => {
    let tasks = 0;
    const h = handler({ onTask: () => { tasks += 1; } });
    h._enqueueComment({ pr: PR, comment: comment({ body: '   ' }) });
    await settle();
    assert.equal(tasks, 0);
  });

  test('an ignored author costs no turn', async () => {
    let tasks = 0;
    const h = handler({ onTask: () => { tasks += 1; } });
    // `ignoreAuthors` defaults to the bot list in github-config.
    h.config.ignoreAuthors = ['noisybot'];
    h._enqueueComment({ pr: PR, comment: comment({ author: 'noisybot' }) });
    await settle();
    assert.equal(tasks, 0);
  });

  test('a thumbs-up DOES open a browser tab, and that is the design', async () => {
    // The classifier stopped categorising by keyword when the AI took that
    // over, so "noise" now means only: ignored author, empty body, or a
    // configured avoid word. Everything else is `requires_review`.
    //
    // Characterised rather than fixed. It is a real cost — a reaction comment
    // spends a full browser turn — but the alternative is keyword matching,
    // which is what was deliberately removed. `avoidWords` is the lever.
    let tasks = 0;
    const h = handler({ onTask: () => { tasks += 1; } });
    h._enqueueComment({ pr: PR, comment: comment({ body: '👍' }) });
    await settle();
    assert.equal(tasks, 1);
  });

  test('an avoid word is the configured way to stop that', async () => {
    let tasks = 0;
    const h = handler({ onTask: () => { tasks += 1; } });
    h.config.avoidWords = ['lgtm'];
    h._enqueueComment({ pr: PR, comment: comment({ body: 'LGTM, nice work' }) });
    await settle();
    assert.equal(tasks, 0);
  });
});

describe('a failed analysis still produces a plan', () => {
  test('the plan is written without the AI section', async () => {
    // The classification and the comment are worth keeping even when the
    // browser turn failed — otherwise a flaky tab loses the record entirely.
    const h = handler({ analysis: { success: false, error: 'tab timed out' } });
    const plans = [];
    h.on('plan_generated', (e) => plans.push(e));
    h._enqueueComment({ pr: PR, comment: comment() });
    await settle();
    assert.equal(plans.length, 1);
  });

  test('a thrown analysis does not wedge the queue', async () => {
    const h = handler({ analysis: new Error('browser exploded') });
    const finished = [];
    h.on('processing_finished', (e) => finished.push(e.commentId));
    h._enqueueComment({ pr: PR, comment: comment() });
    await settle();
    assert.deepEqual(finished, [1], 'the queue never drained again');
    assert.equal(h._isProcessingComment, false, 'the lock was held forever');
  });
});

describe('the prompt handed to the browser', () => {
  test('it carries the PR, the comment, and a do-not-checkout rule', async () => {
    let prompt = '';
    const h = handler({ onTask: (p) => { prompt = p; } });
    h._enqueueComment({ pr: PR, comment: comment() });
    await settle();
    assert.match(prompt, /Add a thing/);
    assert.match(prompt, /number="3"/);
    assert.match(prompt, /rename this variable/);
    assert.match(prompt, /Do NOT run .git checkout./, 'the user may have unsaved work');
  });

  test('a review comment adds its file and diff', async () => {
    let prompt = '';
    const h = handler({ onTask: (p) => { prompt = p; } });
    h._enqueueComment({
      pr: PR,
      comment: comment({ type: 'review_comment', path: 'src/a.js', line: 12, diff_hunk: '@@ -1 +1 @@' }),
    });
    await settle();
    assert.match(prompt, /path="src\/a\.js"/);
    assert.match(prompt, /line="12"/);
    assert.match(prompt, /@@ -1 \+1 @@/);
  });

  test('an issue comment adds neither', async () => {
    let prompt = '';
    const h = handler({ onTask: (p) => { prompt = p; } });
    h._enqueueComment({ pr: PR, comment: comment() });
    await settle();
    assert.ok(!prompt.includes('<file_context'));
    assert.ok(!prompt.includes('<diff_context'));
  });
});

describe('status', () => {
  test('the counters are spread, not nested under `stats`', async () => {
    const h = handler();
    assert.equal(h.getStatus().totalPlansGenerated, 0);
    h._enqueueComment({ pr: PR, comment: comment() });
    await settle();
    assert.equal(h.getStatus().totalPlansGenerated, 1);
    assert.equal(h.getStatus().totalCommentsProcessed, 1);
  });

  test('it does not report which repos are watched', () => {
    // Worth writing down: `this.config.repos` is the one thing a person asks
    // this screen for first, and it is the field that is not on it.
    const h = handler();
    assert.equal(h.getStatus().repos, undefined);
    assert.deepEqual(h.config.repos, ['octo/repo'], 'it is known, just not reported');
  });

  test('the poller identity is reported, because the wrong account reads as zero PRs', () => {
    const h = handler();
    const s = h.getStatus();
    assert.ok('username' in s);
    assert.ok('tokenExpiry' in s);
  });
});
