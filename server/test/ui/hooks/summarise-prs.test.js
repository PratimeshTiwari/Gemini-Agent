/**
 * What the agent knows about each PR, folded out of the events it has seen.
 *
 * This is the one piece of real logic on the GitHub tab — everything else is a
 * fetch or a keypress — and both list levels are drawn from it: the PR rows
 * show its counts, and the comment rows join against its `plans` map to decide
 * whether `⏎` opens an analysis or goes and makes one.
 *
 * It replaced a screen that kept its own separate activity feed. The feed and
 * the PR explorer showed overlapping things, and the feed was what you landed
 * on — empty on a fresh session even with open PRs sitting right there.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { summarisePrs } from '../../../src/ui/hooks/use-github-tab.js';

/** A `github_plan_generated` event as the bridge broadcasts it. */
function planEvent({ id = 'e1', pr = 16, comment = 1, analysed = true, at = 1000, title } = {}) {
  return {
    id,
    type: 'github_plan_generated',
    timestamp: at,
    payload: {
      prNumber: pr,
      prTitle: title ?? `PR ${pr}`,
      analysed,
      filePath: `/ws/.agent/github-reviews/PR-${pr}/comment-${comment}.md`,
      comment: comment == null ? undefined : { id: comment, author: 'someone', body: 'hi' },
      pr: { number: pr, title: title ?? `PR ${pr}` },
    },
  };
}

describe('summarisePrs', () => {
  test('an empty history summarises to nothing', () => {
    assert.equal(summarisePrs([]).size, 0);
    assert.equal(summarisePrs(undefined).size, 0);
  });

  test('ignores events that are not plans', () => {
    const out = summarisePrs([
      { id: 'n', type: 'github_notification', payload: { message: 'polling' } },
      planEvent({ pr: 16 }),
    ]);
    assert.deepEqual([...out.keys()], [16]);
    assert.equal(out.get(16).comments, 1);
  });

  test('counts comments and the ones with no analysis in them', () => {
    const out = summarisePrs([
      planEvent({ id: 'a', pr: 16, comment: 1, analysed: true }),
      planEvent({ id: 'b', pr: 16, comment: 2, analysed: false }),
      planEvent({ id: 'c', pr: 16, comment: 3, analysed: false }),
    ]);
    assert.equal(out.get(16).comments, 3);
    assert.equal(out.get(16).notAnalysed, 2);
  });

  test('re-analysing a comment replaces it rather than counting twice', () => {
    // The bug this keying exists for: pressing ⏎ on an unanalysed comment
    // emits a second plan_generated for the *same* comment. A running total
    // would say "2 comments" for a PR with one, and would keep the stale
    // `analysed: false` alongside the fresh `true` — so the row would still
    // show ⚠ after the analysis it just ran had succeeded.
    const out = summarisePrs([
      planEvent({ id: 'a', pr: 16, comment: 1, analysed: false, at: 1 }),
      planEvent({ id: 'b', pr: 16, comment: 1, analysed: true, at: 2 }),
    ]);
    assert.equal(out.get(16).comments, 1, 'the same comment counted twice');
    assert.equal(out.get(16).notAnalysed, 0, 'the stale failure outlived the retry');
  });

  test('a CI-failure plan has no comment and is still counted', () => {
    const out = summarisePrs([
      { id: 'ci1', type: 'github_plan_generated', timestamp: 5,
        payload: { prNumber: 16, prTitle: 'PR 16', analysed: true, filePath: '/x.md' } },
      { id: 'ci2', type: 'github_plan_generated', timestamp: 6,
        payload: { prNumber: 16, prTitle: 'PR 16', analysed: true, filePath: '/y.md' } },
    ]);
    // Two distinct CI reports, not one overwriting the other on a null key.
    assert.equal(out.get(16).comments, 2);
  });

  test('keeps the newest timestamp, which is what the list is ordered by', () => {
    const out = summarisePrs([
      planEvent({ id: 'a', pr: 16, comment: 1, at: 500 }),
      planEvent({ id: 'b', pr: 16, comment: 2, at: 100 }),
    ]);
    assert.equal(out.get(16).lastAt, 500);
  });

  test('separates PRs, and carries enough of each to draw a row', () => {
    const out = summarisePrs([
      planEvent({ id: 'a', pr: 16, comment: 1, title: 'sixteen' }),
      planEvent({ id: 'b', pr: 15, comment: 9, title: 'fifteen', analysed: false }),
    ]);
    assert.equal(out.size, 2);
    assert.equal(out.get(16).title, 'sixteen');
    assert.equal(out.get(15).notAnalysed, 1);
    assert.equal(out.get(15).pr.number, 15, 'the PR object is needed to re-queue a comment');
  });

  test('an event with no PR number is dropped rather than bucketed under undefined', () => {
    const out = summarisePrs([
      { id: 'x', type: 'github_plan_generated', timestamp: 1, payload: { analysed: true } },
      planEvent({ pr: 16 }),
    ]);
    assert.deepEqual([...out.keys()], [16]);
  });

  test('the plans map is keyed by comment id, which is what the rows join on', () => {
    const out = summarisePrs([planEvent({ pr: 16, comment: 42 })]);
    const plan = out.get(16).plans.get(42);
    assert.ok(plan, 'a comment row could not find its analysis');
    assert.match(plan.payload.filePath, /comment-42\.md$/);
  });
});
