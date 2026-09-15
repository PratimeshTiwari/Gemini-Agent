/**
 * The prompt that answers one PR comment.
 *
 * It was built inline in the middle of the queue drain. Separated because the
 * prompt *is* the contract with the model — the same way a tool's description
 * is — and a contract in the middle of control flow is one nobody reads.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildReviewPrompt, analyseComment } from '../../src/github/review-task.js';

const PR = { number: 3, title: 'Add a thing', head_ref: 'feat/x' };
const comment = (over = {}) => ({ author: 'alice', body: 'Please rename this.', ...over });

describe('buildReviewPrompt', () => {
  test('it carries the PR and the comment', () => {
    const p = buildReviewPrompt({ pr: PR, comment: comment() });
    assert.match(p, /number="3"/);
    assert.match(p, /title="Add a thing"/);
    assert.match(p, /branch="feat\/x"/);
    assert.match(p, /Please rename this\./);
    assert.match(p, /author="alice"/);
  });

  test('a missing branch is named, not blank', () => {
    const p = buildReviewPrompt({ pr: { ...PR, head_ref: undefined }, comment: comment() });
    assert.match(p, /branch="unknown"/);
  });

  test('it forbids switching branches, because the user may have unsaved work', () => {
    assert.match(buildReviewPrompt({ pr: PR, comment: comment() }), /Do NOT run `git checkout`/);
  });

  test('an inline comment brings its file and diff', () => {
    const p = buildReviewPrompt({
      pr: PR,
      comment: comment({ path: 'src/a.js', line: 12, diff_hunk: '@@ -1 +1 @@' }),
    });
    assert.match(p, /<file_context path="src\/a\.js" line="12" \/>/);
    assert.match(p, /```diff\n@@ -1 \+1 @@/);
  });

  test('an issue comment brings neither, rather than empty tags', () => {
    // Empty tags are noise the model reads past on every turn.
    const p = buildReviewPrompt({ pr: PR, comment: comment() });
    assert.ok(!p.includes('<file_context'));
    assert.ok(!p.includes('<diff_context'));
  });

  test('a file with no line number omits the line attribute', () => {
    const p = buildReviewPrompt({ pr: PR, comment: comment({ path: 'src/a.js' }) });
    assert.match(p, /<file_context path="src\/a\.js" \/>/);
  });
});

describe('analyseComment — a failure must still leave a review on disk', () => {
  let ws;
  const setup = () => { ws = mkdtempSync(join(tmpdir(), 'rt-')); };
  const teardown = () => rmSync(ws, { recursive: true, force: true });

  test('a successful analysis comes back', async () => {
    setup();
    const out = await analyseComment({
      pr: PR, comment: comment(), workspace: ws,
      ask: async () => ({ success: true, result: '# Plan' }),
    });
    assert.equal(out, '# Plan');
    teardown();
  });

  test('a failed analysis is null, not a throw', async () => {
    setup();
    const out = await analyseComment({
      pr: PR, comment: comment(), workspace: ws,
      ask: async () => ({ success: false, error: 'tab timed out' }),
    });
    assert.equal(out, null, 'a flaky tab would lose the record of the comment');
    teardown();
  });

  test('a thrown analysis is null, not a throw', async () => {
    setup();
    const out = await analyseComment({
      pr: PR, comment: comment(), workspace: ws,
      ask: async () => { throw new Error('browser exploded'); },
    });
    assert.equal(out, null);
    teardown();
  });

  test('with no way to ask, it is null and nothing is attempted', async () => {
    setup();
    assert.equal(await analyseComment({ pr: PR, comment: comment(), workspace: ws, ask: null }), null);
    teardown();
  });
});
