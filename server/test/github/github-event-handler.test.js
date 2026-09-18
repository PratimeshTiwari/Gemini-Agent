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
import { mkdtempSync, rmSync, readFileSync } from 'fs';
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

  /**
   * A thumbs-up costs a *triage* turn, not an analysis.
   *
   * This test used to assert the opposite and call it the design: "a reaction
   * comment spends a full browser turn… `avoidWords` is the lever". The
   * alternative considered at the time was keyword matching, which this
   * project had deliberately removed once the model took the categorising
   * over — so the choice looked like ceremony or regression.
   *
   * There is a third option, and it is the same one the project already chose
   * everywhere else: **ask**. One short exchange, no tools, and the judgement a
   * person makes reading the comment.
   */
  test('a reaction is triaged away instead of investigated', async () => {
    const prompts = [];
    const h = handler({
      onTask: (p) => prompts.push(p),
      analysis: { success: true, result: 'SKIP - a thumbs up, nothing requested' },
    });
    h._enqueueComment({ pr: PR, comment: comment({ body: '👍' }) });
    await settle();

    assert.equal(prompts.length, 1, 'it went on to a full analysis anyway');
    assert.match(prompts[0], /REVIEW or the word SKIP/, 'that turn was not the triage');
  });

  test('a real question survives triage and is analysed', async () => {
    const prompts = [];
    const h = handler({
      onTask: (p) => prompts.push(p),
      analysis: { success: true, result: 'REVIEW - asks why the merge is not complete' },
    });
    h._enqueueComment({ pr: PR, comment: comment({ body: 'why is the merge not complete?' }) });
    await settle();

    assert.equal(prompts.length, 2, 'triage then analysis');
    assert.match(prompts[1], /consolidated markdown plan/, 'the second turn should be the analysis');
  });

  // Silence is not consent. If the bridge is down, triage cannot run and
  // neither can the analysis — proceeding leaves one failure to report instead
  // of quietly dropping a reviewer's question.
  test('an unanswerable triage reviews rather than skips', async () => {
    const prompts = [];
    const h = handler({
      onTask: (p) => prompts.push(p),
      analysis: { success: false, error: 'no tab' },
    });
    h._enqueueComment({ pr: PR, comment: comment() });
    await settle();
    assert.equal(prompts.length, 2, 'a failed triage silently dropped the comment');
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

/**
 * A review without an analysis is not a plan.
 *
 * It was written anyway, on the reasoning that the comment and its
 * classification are worth keeping even when the browser turn fell over. What
 * that produced was a file of generic instructions — "read the reviewer
 * question", "formulate a response" — under a heading saying a plan had been
 * generated, and a notification that reads as success.
 *
 * Reported plainly: *"plans without AI analysis is completely useless"*. Worse
 * than useless, because it hid the failure: ten review files in this repo have
 * no analysis section and nothing ever said so.
 */
describe('an unanalysed comment is not reported as a plan', () => {
  const failing = (error = 'tab timed out') => {
    const h = new GitHubEventHandler({
      token: 't', workspace: ws, configOverrides: { repos: ['octo/repo'] },
      agentLoop: { workspace: ws, runHeadlessTask: async () => ({ success: false, error }) },
    });
    h.poller.start = async () => {}; h.poller.stop = () => {}; h.poller.pollNow = async () => {};
    return h;
  };

  test('the notification says the analysis did not run, and why', async () => {
    const h = failing('no Gemini tab');
    const notes = [];
    h.on('notification', (n) => notes.push(n));
    h._enqueueComment({ pr: PR, comment: comment() });
    await settle();

    assert.equal(notes.length, 1);
    assert.match(notes[0].message, /analysis did not run/i);
    assert.match(notes[0].message, /no Gemini tab/, 'it should name the reason');
    assert.equal(notes[0].category, 'analysis_failed');
  });

  test('the file says what it is, rather than looking like a plan', async () => {
    const h = failing();
    const plans = [];
    h.on('plan_generated', (e) => plans.push(e));
    h._enqueueComment({ pr: PR, comment: comment() });
    await settle();

    // The record is still kept — that half of the original reasoning was right.
    assert.equal(plans.length, 1);
    assert.equal(plans[0].analysed, false);
    const body = readFileSync(plans[0].filePath, 'utf-8');
    assert.match(body, /Analysis did not run/i);
    assert.match(body, /not a plan/i);
    assert.match(body, /tab timed out/);
  });

  test('a successful analysis still reads as a plan', async () => {
    const h = handler({ analysis: { success: true, result: '## Findings\nthe branch diverged' } });
    const notes = [];
    const plans = [];
    h.on('notification', (n) => notes.push(n));
    h.on('plan_generated', (e) => plans.push(e));
    h._enqueueComment({ pr: PR, comment: comment() });
    await settle();

    assert.equal(plans[0].analysed, true);
    assert.doesNotMatch(notes[0].message, /did not run/i);
    assert.match(readFileSync(plans[0].filePath, 'utf-8'), /AI Context Analysis/);
  });

  // The count is what a person checks to see whether the agent is doing
  // anything; counting templates makes it say yes while nothing is happening.
  test('an unanalysed comment is not counted as a plan generated', async () => {
    const h = failing();
    h._enqueueComment({ pr: PR, comment: comment() });
    await settle();
    assert.equal(h.getStatus().totalPlansGenerated, 0);
    assert.equal(h.getStatus().totalCommentsProcessed, 1, 'it was still processed');
  });
});

/**
 * Asking for an analysis that never ran.
 *
 * Enter on a row used to always open the file, and a comment whose analysis
 * failed has a file anyway — a placeholder saying so. Opening that was the
 * whole interaction, with no way to ask for the thing you actually wanted.
 * Reported as "this useless file got opened only".
 *
 * The row carries what the key needs to decide: whether there is an analysis
 * in it, and enough of the PR to run one.
 */
describe('a row knows whether it was analysed', () => {
  test('a failed analysis marks the row, and carries the PR', async () => {
    const h = handler({ analysis: { success: false, error: 'no tab' } });
    const plans = [];
    h.on('plan_generated', (e) => plans.push(e));
    h._enqueueComment({ pr: PR, comment: comment() });
    await settle();

    assert.equal(plans[0].analysed, false);
    assert.equal(plans[0].pr.number, PR.number, 'no PR, nothing to re-run with');
    assert.ok(plans[0].comment.id);
  });

  test('a successful one is marked too', async () => {
    const h = handler({ analysis: { success: true, result: 'REVIEW - go\n## Findings\nx' } });
    const plans = [];
    h.on('plan_generated', (e) => plans.push(e));
    h._enqueueComment({ pr: PR, comment: comment() });
    await settle();
    assert.equal(plans[0].analysed, true);
  });

  /**
   * The queue remembers what it has seen, so a re-run has to say `force` —
   * without it the second attempt is treated as a duplicate and does nothing
   * at all, which would look exactly like the key not working.
   */
  test('re-queueing without force does nothing, with force it runs again', async () => {
    const h = handler({ analysis: { success: false, error: 'no tab' } });
    let runs = 0;
    h.on('processing_started', () => { runs += 1; });

    h._enqueueComment({ pr: PR, comment: comment() });
    await settle();
    assert.equal(runs, 1);

    h._enqueueComment({ pr: PR, comment: comment() });
    await settle();
    assert.equal(runs, 1, 'a duplicate should still be ignored');

    h._enqueueComment({ pr: PR, comment: comment(), force: true });
    await settle();
    assert.equal(runs, 2, 'asking again explicitly must re-run it');
  });
});

/**
 * The path the ⏎ key takes, which nothing above covers.
 *
 * Every test in this file enqueues through `_enqueueComment`. The GitHub tab
 * does not: it calls `forceAnalyzeComment`, which does three things first —
 * refuse a duplicate in flight, delete the stale review, and clear the dedup
 * memory. That third line referenced `_processedCommentIds`, a field that
 * stopped existing when dedup moved into `WorkQueue`, so the method threw
 * before it ever reached the enqueue and the UI's `.catch(() => {})` ate it.
 * Pressing ⏎ on a comment did nothing, for every comment, silently.
 */
describe('forceAnalyzeComment — the UI entry point', () => {
  test('analyses a comment that has never been seen', async () => {
    const h = handler();
    const plans = [];
    h.on('plan_generated', (e) => plans.push(e));
    const r = await h.forceAnalyzeComment(PR, comment());
    assert.deepEqual(r, { queued: true });
    await settle();
    assert.equal(plans.length, 1, 'the analysis never ran');
  });

  test('re-analyses one the queue has already done', async () => {
    const h = handler();
    let runs = 0;
    h.on('processing_started', () => { runs += 1; });
    h._enqueueComment({ pr: PR, comment: comment() });
    await settle();
    await h.forceAnalyzeComment(PR, comment());
    await settle();
    assert.equal(runs, 2);
  });

  test('and the queue no longer believes it is done', async () => {
    // Deleting the review file while the queue still holds the id is a state
    // where nothing on disk agrees with what the queue thinks it handled.
    const h = handler();
    h._enqueueComment({ pr: PR, comment: comment() });
    await settle();
    assert.equal(h._queue.done.has(1), true);
    h._queue.current = null;
    await h.forceAnalyzeComment(PR, comment());
    assert.equal(h._queue.done.has(1), true, 'the re-run re-marks it');
  });

  test('refuses while that same comment is in flight', async () => {
    const h = handler();
    let release;
    h.agentLoop.runHeadlessTask = () => new Promise((r) => { release = r; });
    h._enqueueComment({ pr: PR, comment: comment() });
    await settle();
    const r = await h.forceAnalyzeComment(PR, comment());
    assert.deepEqual(r, { skipped: true, reason: 'processing' });
    release({ success: true, result: '# Plan' });
  });
});
