/**
 * The one line most people will ever read about the GitHub feature.
 *
 * Decided 2026-09-16: the tab stays for browsing, and each event also arrives
 * in the transcript as one dim row — everything else in this app is a stream
 * and nothing else is a page. These pin the wording and, more importantly,
 * which events earn a row at all.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { githubNoticeRow } from '../../../src/ui/hooks/use-github-tab.js';

const plan = (payload) => ({ type: 'github_plan_generated', payload });

describe('githubNoticeRow', () => {
  test('names who commented, which is what the list is scanned for', () => {
    const row = githubNoticeRow(plan({ prNumber: 42, comment: { author: 'alice' } }));
    assert.equal(row.content, '⌁ PR #42 · @alice commented — ^o to look');
  });

  test('a CI failure says so', () => {
    const row = githubNoticeRow(plan({ prNumber: 7, category: 'ci_failure' }));
    assert.match(row.content, /CI failed/);
  });

  test('no author and no category still reads as something', () => {
    const row = githubNoticeRow(plan({ prNumber: 9 }));
    assert.equal(row.content, '⌁ PR #9 · plan written — ^o to look');
  });

  test('a missing PR number does not render "undefined"', () => {
    const row = githubNoticeRow(plan({ comment: { author: 'bob' } }));
    assert.doesNotMatch(row.content, /undefined/);
    assert.match(row.content, /PR #\?/);
  });

  // Both bracket the same event. Drawing all three would put three lines in
  // the transcript for one comment.
  test('the processing bracket earns no row', () => {
    assert.equal(githubNoticeRow({ type: 'github_processing_started', payload: {} }), null);
    assert.equal(githubNoticeRow({ type: 'github_processing_finished', payload: {} }), null);
    assert.equal(githubNoticeRow({ type: 'github_notification', payload: {} }), null);
  });

  test('rubbish in does not throw', () => {
    assert.equal(githubNoticeRow(undefined), null);
    assert.equal(githubNoticeRow({}), null);
    assert.doesNotThrow(() => githubNoticeRow(plan(undefined)));
  });

  // `system` is what `groupTurns` and `TranscriptTurn` already draw dim and
  // wrapped; a new role would mean teaching both, for one line.
  test('it is a system row, so the transcript already knows how to draw it', () => {
    const row = githubNoticeRow(plan({ prNumber: 1, comment: { author: 'a' } }));
    assert.equal(row.role, 'system');
    assert.equal(row.isLocal, true);
    assert.equal(typeof row.timestamp, 'number');
  });
});

/**
 * The row is drawn in the *live* frame while a turn is in flight, and
 * `TranscriptTurn` draws a system row with `wrap="wrap"`. The single most
 * important rule in `ui/` is that the live frame never outgrows the viewport,
 * and a row that wraps is charged as one and drawn as two — which has been the
 * bug here twice.
 */
describe('githubNoticeRow stays one row', () => {
  const NARROWEST = 60;

  test('the worst case a real payload can produce still fits', () => {
    // GitHub usernames go to 39 characters; PR numbers are unbounded in theory
    // but six digits is already a repo nobody has.
    const row = githubNoticeRow(plan({ prNumber: 123456, comment: { author: 'a'.repeat(39) } }));
    assert.ok(
      row.content.length <= NARROWEST,
      `${row.content.length} columns wraps at ${NARROWEST}:\n${row.content}`,
    );
  });

  test('a capped author is still recognisable', () => {
    const row = githubNoticeRow(plan({ prNumber: 1, comment: { author: 'a-very-long-github-username' } }));
    assert.match(row.content, /@a-very-long-github…/);
    assert.doesNotMatch(row.content, /-…/, 'a cut name should not end on a dangling separator');
  });

  test('an ordinary author is not touched', () => {
    const row = githubNoticeRow(plan({ prNumber: 1, comment: { author: 'alice' } }));
    assert.match(row.content, /@alice commented/);
    assert.doesNotMatch(row.content, /…/);
  });
});
