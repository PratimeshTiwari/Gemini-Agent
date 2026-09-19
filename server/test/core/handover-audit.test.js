/**
 * The handover block, checked against what the turn actually did.
 *
 * The first case below is the real one, copied from the review that prompted
 * this: every line well-formed, every line unfalsifiable as written, and the
 * recommendation it closed with was to add whitespace-fuzzy matching to
 * `diff-engine.js`, which has had it at line 235 for months.
 *
 * The false-positive cases matter more than the true ones. A detector that
 * fires on an honest "not run, because …" punishes exactly the behaviour the
 * prompt is asking for, and a detector that fires on an unusual format teaches
 * the model to stop emitting the format — at which point the thing being
 * measured disappears instead of improving. Both are worse than not checking.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { auditHandover, describeFindings, countChecklist } from '../../src/core/handover-audit.js';

const claims = (text, turn) => auditHandover(text, turn).findings.map((f) => f.claim);

/** Nothing ran: the state the observed review was actually in. */
const NOTHING = { evidence: new Map(), checklist: null };

describe('the review that started this', () => {
  const OBSERVED = `Here is my assessment of the proposal.

## Review
- Checklist: 3/3 review dimensions evaluated (Security, Reliability, Architectural Guardrails).
- Ran: Adversarial security and reliability analysis on the proposal.
- Callers checked: server/src/core/agent-loop.js, server/src/core/diff-engine.js, server/src/bridge/
- Not done / assumed: Code implementation pending user approval of refined plan.`;

  test('both checkable claims are reported', () => {
    assert.deepEqual(claims(OBSERVED, NOTHING).sort(), ['callers', 'ran']);
  });

  test('the reason names this turn, never the model', () => {
    const { findings } = auditHandover(OBSERVED, NOTHING);
    for (const f of findings) {
      assert.match(f.because, /this turn/);
      assert.doesNotMatch(f.because, /lie|false|wrong|dishonest/i);
    }
  });

  // `Not done / assumed` is a statement, not a claim about work performed.
  // There is nothing to check it against and reporting it would be noise.
  test('"Not done" is never a finding', () => {
    assert.ok(!claims(OBSERVED, NOTHING).includes('not done'));
  });
});

describe('a claim the turn supports is not reported', () => {
  const REVIEW = `## Review
- Ran: npm test → 1403 passing
- Callers checked: 4 call sites of _findMatch, all updated`;

  test('with the tools that back it', () => {
    const evidence = new Map([['run_command', 1], ['find_references', 2]]);
    assert.deepEqual(claims(REVIEW, { evidence }), []);
  });

  // grep_search is how "who calls this" is answered half the time, and
  // demanding one specific tool would report a real check as unverified.
  test('grep_search backs a callers claim too', () => {
    const evidence = new Map([['run_command', 1], ['grep_search', 1]]);
    assert.deepEqual(claims(REVIEW, { evidence }), []);
  });

  test('but the wrong tool does not back it', () => {
    const evidence = new Map([['read_file', 9]]);
    assert.deepEqual(claims(REVIEW, { evidence }).sort(), ['callers', 'ran']);
  });
});

describe('honesty is not a finding', () => {
  /*
   * The prompt offers these verbatim — `[or: not run, because …]`. Reporting
   * them would make the audit punish the answer it asked for, which is the
   * fastest way to stop getting it.
   */
  for (const said of [
    'not run, because the suite needs a browser',
    'none — nothing changed signature',
    'nothing',
    'N/A',
    'did not run the build',
    "didn't check, no signatures changed",
  ]) {
    test(`"${said}"`, () => {
      const text = `## Review\n- Ran: ${said}\n- Callers checked: ${said}`;
      assert.deepEqual(claims(text, NOTHING), []);
    });
  }
});

describe('it fails open', () => {
  test('no block at all', () => {
    assert.deepEqual(claims('I fixed the parser and the tests pass.', NOTHING), []);
  });

  test('a block in a shape it does not recognise', () => {
    const text = '## Review\nI checked the callers and ran the tests.';
    assert.deepEqual(claims(text, NOTHING), []);
  });

  test('empty, null and non-string input', () => {
    for (const bad of ['', null, undefined, 42, {}]) {
      assert.deepEqual(auditHandover(bad, NOTHING).findings, []);
    }
  });

  test('a missing turn record reports nothing rather than everything', () => {
    // Called with no second argument at all — a caller that has not wired the
    // evidence yet must not produce a finding on every single turn.
    const text = '## Review\n- Ran: npm test → ok';
    assert.equal(auditHandover(text).findings.length, 1,
      'with no evidence, an unbacked claim is still unbacked');
    assert.deepEqual(claims(text, { evidence: new Map([['run_command', 1]]) }), []);
  });
});

describe('formatting it should survive', () => {
  const evidence = new Map();

  test('#### Review, bold labels, and no space after the dash', () => {
    const text = '#### Review\n-**Ran**: npm test → ok';
    assert.deepEqual(claims(text, { evidence }), ['ran']);
  });

  test('a * bullet instead of -', () => {
    assert.deepEqual(claims('## Review\n* Ran: npm test → ok', { evidence }), ['ran']);
  });

  test('prose before the block does not hide it', () => {
    const text = 'Long explanation.\n\nMore.\n\n## Review\n- Ran: npm test → ok';
    assert.deepEqual(claims(text, { evidence }), ['ran']);
  });

  /*
   * "Review" as a word in prose is not the block.
   *
   * The fixture has to carry lines the parser *would* accept, or it passes
   * whatever the heading matcher does — the first version of this test used
   * plain prose and went green with the matcher loosened to `/Review/i`. What
   * discriminates is a reply that mentions reviewing **and** contains bullets
   * shaped like the block, which is an ordinary thing for a plan to look like.
   */
  test('the word review in a sentence is not a block', () => {
    const text = [
      'Phase 3 is the review step, once the audit lands.',
      '',
      'Steps:',
      '- Ran: npm test is the gate for this one',
      '- Callers checked: find_references on _findMatch is the first move',
    ].join('\n');
    assert.deepEqual(claims(text, { evidence }), []);
  });
});

describe('the checklist count', () => {
  const said = (line, checklist) => claims(`## Review\n- ${line}`, { evidence: new Map(), checklist });

  test('a total that does not match task.md is reported', () => {
    assert.deepEqual(said('Checklist: 3/3 done', { total: 6, done: 3 }), ['checklist']);
  });

  test('claiming more ticked than are ticked is reported', () => {
    assert.deepEqual(said('Checklist: 6/6 done', { total: 6, done: 4 }), ['checklist']);
  });

  test('an accurate count is not', () => {
    assert.deepEqual(said('Checklist: 4/6 done', { total: 6, done: 4 }), []);
  });

  /*
   * Claiming *fewer* done than are ticked is not a finding. It is the model
   * being conservative about its own work, which is the direction this whole
   * mechanism is trying to encourage.
   */
  test('under-claiming is allowed', () => {
    assert.deepEqual(said('Checklist: 2/6 done', { total: 6, done: 4 }), []);
  });

  test('no list on disk proves nothing either way', () => {
    assert.deepEqual(said('Checklist: 3/3 done', null), []);
  });
});

describe('countChecklist', () => {
  test('counts items and ticks, not lines', () => {
    const body = '# Task\n\nSome notes.\n\n- [x] one\n- [ ] two\n  - [x] nested\n\nA trailing note.';
    assert.deepEqual(countChecklist(body), { total: 3, done: 2 });
  });

  test('a file with no items is not a list of zero', () => {
    assert.equal(countChecklist('# Task\n\nJust prose.'), null);
    assert.equal(countChecklist(''), null);
    assert.equal(countChecklist(null), null);
  });
});

describe('the transcript row', () => {
  test('nothing to say means no row', () => {
    assert.equal(describeFindings([]), null);
    assert.equal(describeFindings(null), null);
  });

  /*
   * The row is drawn in the live frame, where a row that wraps is charged as
   * one and drawn as two — a bug this frame has had twice. The reasons
   * truncate; the count never does.
   */
  test('it fits the width it is given', () => {
    const many = Array.from({ length: 8 }, () => ({
      claim: 'ran', because: 'no command ran this turn',
    }));
    for (const w of [60, 72, 80]) {
      assert.ok(describeFindings(many, w).length <= w, `overflowed at ${w}`);
    }
  });

  test('the count survives truncation', () => {
    assert.match(describeFindings(
      [{ because: 'x'.repeat(200) }, { because: 'y'.repeat(200) }], 60,
    ), /^2 unverified/);
  });
});
