/**
 * The prompt that answers one PR comment.
 *
 * It was built inline in the middle of the queue drain. Separated because the
 * prompt *is* the contract with the model — the same way a tool's description
 * is — and a contract in the middle of control flow is one nobody reads.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildReviewPrompt, analyseComment, triageComment } from '../../src/github/review-task.js';

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

/**
 * The caller has to be able to tell "the model said this" from "the model
 * never ran".
 *
 * It used to return a string or `null`, and `null` meant four different
 * things. The review was then written either way, under a heading that said a
 * plan had been generated — so a failed analysis was filed away as finished
 * work. Reported plainly: *"plans without AI analysis is completely useless"*,
 * and ten review files in this repo had no analysis section with nothing ever
 * saying so.
 */
describe('analyseComment reports an outcome, not a string-or-null', () => {
  let ws;
  const setup = () => { ws = mkdtempSync(join(tmpdir(), 'rt-')); };
  const teardown = () => rmSync(ws, { recursive: true, force: true });
  const logged = () => {
    const f = join(ws, '.agent', 'logs', 'errors.jsonl');
    return existsSync(f) ? readFileSync(f, 'utf-8').trim().split('\n').length : 0;
  };

  test('a successful analysis comes back, marked as one', async () => {
    setup();
    const out = await analyseComment({
      pr: PR, comment: comment(), workspace: ws,
      ask: async () => ({ success: true, result: '# Plan' }),
    });
    assert.deepEqual(out, { ok: true, text: '# Plan' });
    assert.equal(logged(), 0, 'a success should not be logged as a failure');
    teardown();
  });

  test('a failed analysis says why, and never throws', async () => {
    setup();
    const out = await analyseComment({
      pr: PR, comment: comment(), workspace: ws,
      ask: async () => ({ success: false, error: 'tab timed out' }),
    });
    assert.equal(out.ok, false);
    assert.match(out.error, /tab timed out/);
    assert.equal(logged(), 1);
    teardown();
  });

  test('a thrown analysis is an outcome too', async () => {
    setup();
    const out = await analyseComment({
      pr: PR, comment: comment(), workspace: ws,
      ask: async () => { throw new Error('browser exploded'); },
    });
    assert.equal(out.ok, false);
    assert.match(out.error, /browser exploded/);
    assert.equal(logged(), 1);
    teardown();
  });

  // The loudest of the three, not the quietest: it means the agent loop was
  // never wired to the GitHub handler. It used to return null and log nothing.
  test('with no way to ask, it says so and logs it', async () => {
    setup();
    const out = await analyseComment({ pr: PR, comment: comment(), workspace: ws, ask: null });
    assert.equal(out.ok, false);
    assert.match(out.error, /no agent loop/i);
    assert.equal(logged(), 1, 'the one path that used to fail silently');
    teardown();
  });

  // "Succeeded" with nothing in it is a failure wearing a success's clothes.
  test('an empty result is not a success', async () => {
    setup();
    for (const result of ['', '   ', null, undefined]) {
      const out = await analyseComment({
        pr: PR, comment: comment(), workspace: ws,
        ask: async () => ({ success: true, result }),
      });
      assert.equal(out.ok, false, JSON.stringify(result));
    }
    teardown();
  });
});

/**
 * Whether a comment is worth investigating.
 *
 * Everything that was not an ignored author, an empty body or a configured
 * avoid word went straight to a full analysis — a browser turn with the whole
 * tool set behind it, spent on "LGTM". The alternative considered was keyword
 * matching, which this project deliberately removed once the model took the
 * categorising over.
 *
 * Asking is the third option, and the one the project already chose everywhere
 * else.
 */
describe('triageComment', () => {
  let ws;
  const setup = () => { ws = mkdtempSync(join(tmpdir(), 'tri-')); };
  const teardown = () => rmSync(ws, { recursive: true, force: true });
  const say = (result) => async () => ({ success: true, result });
  const run = (ask) => triageComment({ pr: PR, comment: comment(), ask, workspace: ws });

  test('a question is reviewed, with the model\'s reason', async () => {
    setup();
    const out = await run(say('REVIEW - asks why the merge is not complete'));
    assert.equal(out.review, true);
    assert.match(out.reason, /merge is not complete/);
    teardown();
  });

  test('an approval is skipped', async () => {
    setup();
    const out = await run(say('SKIP - approval with no request'));
    assert.equal(out.review, false);
    assert.match(out.reason, /approval/);
    teardown();
  });

  // A model that ignores the format and explains itself still gets read.
  test('the verdict is found even when it is not the first word', async () => {
    setup();
    assert.equal((await run(say('I think this is SKIP — just a thumbs up'))).review, false);
    assert.equal((await run(say('Answer: REVIEW. It asks about the build.'))).review, true);
    teardown();
  });

  /**
   * Every uncertain path reviews. Dropping a reviewer's question is far worse
   * than spending a turn on "LGTM", and if the bridge is down then triage and
   * the analysis fail together — one failure to report, not a second that
   * silently loses comments.
   */
  test('nothing unparseable, failed or unanswerable is ever skipped', async () => {
    setup();
    const cases = {
      'no verdict in the text': say('hmm, hard to say'),
      'an empty answer': say('   '),
      'a failed turn': async () => ({ success: false, error: 'no tab' }),
      'a thrown turn': async () => { throw new Error('browser exploded'); },
      'no way to ask at all': null,
    };
    for (const [name, ask] of Object.entries(cases)) {
      const out = await triageComment({ pr: PR, comment: comment(), ask, workspace: ws });
      assert.equal(out.review, true, name);
      assert.ok(out.reason, `${name}: it should say why`);
    }
    teardown();
  });

  test('the prompt asks for one word and forbids tools', async () => {
    setup();
    let prompt = '';
    await run(async (p) => { prompt = p; return { success: true, result: 'SKIP - x' }; });
    assert.match(prompt, /REVIEW or the word SKIP/);
    assert.match(prompt, /no tool calls/i, 'a triage that uses tools is not cheap');
    assert.match(prompt, /LGTM/, 'it should say what does not need investigating');
    teardown();
  });

  test('the comment itself reaches the prompt', async () => {
    setup();
    let prompt = '';
    await triageComment({
      pr: PR,
      comment: comment({ body: 'why is the merge not complete?', path: 'src/a.js' }),
      ask: async (p) => { prompt = p; return { success: true, result: 'REVIEW - x' }; },
      workspace: ws,
    });
    assert.match(prompt, /why is the merge not complete\?/);
    assert.match(prompt, /path="src\/a\.js"/);
    teardown();
  });
});

/**
 * The analysis carries the same discipline the pro effort ladder does.
 *
 * Asked for directly: a task list and a review, "as we have done with the pro
 * model effort". The parallel is exact — a plan nobody checked is a guess in a
 * nicer format, and the anti-hallucination rules already demand citations
 * without ever making the model *account* for them.
 *
 * Adapted rather than copied: this produces a plan document, not code changes,
 * so the checklist is the plan's own action items and the review is about what
 * was read and cited.
 */
describe('the review prompt asks for a checklist and a review', () => {
  const prompt = buildReviewPrompt({ pr: PR, comment: comment() });

  test('action items are a checklist, not prose', () => {
    assert.match(prompt, /checklist/i);
    assert.match(prompt, /- \[ \]/, 'it should show the shape it wants');
    assert.match(prompt, /one verifiable outcome/i);
  });

  test('there is a review phase before the output', () => {
    assert.match(prompt, /Phase 5/);
    assert.match(prompt, /REVIEW WHAT YOU WROTE/i);
  });

  test('it demands evidence rather than reassurance', () => {
    assert.match(prompt, /not a verdict|not checked/i);
    assert.match(prompt, /grepped but never read|never read is not a file/i);
  });

  // Silence reads as "all of it is confirmed", which is how a guess gets filed
  // as an investigation.
  test('it has to say what it did not verify', () => {
    assert.match(prompt, /Unverified/);
    assert.match(prompt, /Callers checked/);
  });

  test('the closing block has a fixed shape', () => {
    assert.match(prompt, /🔎 Review/);
    assert.match(prompt, /- Read:/);
    assert.match(prompt, /- Cited:/);
  });

  // The triage is one short exchange with no tools; the analysis is many turns
  // with all of them. Loading the heavy prompt into triage would undo that.
  test('none of this weight reaches the triage', async () => {
    let triagePrompt = '';
    await triageComment({
      pr: PR, comment: comment(),
      ask: async (p) => { triagePrompt = p; return { success: true, result: 'SKIP - x' }; },
      workspace: tmpdir(),
    });
    assert.doesNotMatch(triagePrompt, /INVESTIGATION PROTOCOL/);
    assert.doesNotMatch(triagePrompt, /Phase 5/);
    assert.ok(triagePrompt.length < 1500,
      `triage prompt is ${triagePrompt.length} chars — it is meant to be the cheap one`);
  });
});
