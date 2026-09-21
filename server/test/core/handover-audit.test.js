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

/**
 * Reported from use with three screenshots, 2026-09-21.
 *
 * A `## Review` block closed a turn with five **Verified Files**, two of which
 * did not exist: `TasksPane.jsx`, and `server/src/github/poller.js` in a
 * directory deleted wholesale in `e375aed`. The prose above it described an
 * `agentLoop.on(...)` event API, `F2` navigation and three dialog components,
 * none of which exist either — an invented architecture with a citation list
 * attached, which is the shape that gets believed.
 *
 * The audit written for exactly this passed it clean, twice over:
 *
 *  - `claimFor` returned `ran`, `callers`, `checklist` or null, so
 *    "Verified Files" matched nothing. `SUPPORTED_BY` carried a `read` entry
 *    that no label could ever reach — dead by construction.
 *  - and the parser required `- Label: value`, skipping any line whose value
 *    was empty. The real block puts nothing after the colon and the paths
 *    beneath as deeper list items, so the one shape that occurs was the one
 *    shape not read.
 */
test('a file claim is checked against the filesystem', async (t) => {
  const REPLY = [
    'triggering the review agent loop when changes occur.',
    '',
    '## Review',
    '- Verified Files:',
    '    - server/src/ui/App.jsx',
    '    - server/src/ui/components/TasksPane.jsx',
    '    - server/src/mcp/tools/run-background.js',
    '    - server/src/mcp/tools/manage-task.js',
    '    - server/src/github/poller.js',
    '- Findings:',
    '    - The UI uses Ink with strict viewport boundaries.',
  ].join('\n');

  const REAL = new Set([
    'server/src/ui/App.jsx',
    'server/src/mcp/tools/run-background.js',
    'server/src/mcp/tools/manage-task.js',
  ]);
  const exists = (p) => REAL.has(p);
  const read4 = new Map([['read_file', 4]]);

  await t.test('the two invented paths are named, and only those', () => {
    const { findings } = auditHandover(REPLY, { evidence: read4, exists });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].claim, 'files');
    assert.match(findings[0].because, /TasksPane\.jsx/);
    assert.match(findings[0].because, /github\/poller\.js/);
    assert.doesNotMatch(findings[0].because, /App\.jsx/,
      'a file that does exist was reported as invented');
  });

  await t.test('a list where every path is real reports nothing', () => {
    const clean = REPLY
      .replace('    - server/src/ui/components/TasksPane.jsx\n', '')
      .replace('    - server/src/github/poller.js\n', '');
    assert.deepEqual(auditHandover(clean, { evidence: read4, exists }).findings, []);
  });

  // The paths are real but nothing was opened this turn — the old `read` check,
  // finally reachable. A model may legitimately cite an earlier turn's reads, so
  // this says what the turn has no record of, never that the claim is false.
  await t.test('real paths with no read this turn are still unverified', () => {
    const clean = REPLY
      .replace('    - server/src/ui/components/TasksPane.jsx\n', '')
      .replace('    - server/src/github/poller.js\n', '');
    const { findings } = auditHandover(clean, { evidence: new Map(), exists });
    assert.equal(findings.length, 1);
    assert.match(findings[0].because, /no file was read this turn/);
  });

  await t.test('an inline list is read the same as a nested one', () => {
    const inline = '## Review\n- Files: `server/src/ui/App.jsx`, `server/src/nope.js`';
    const { findings } = auditHandover(inline, { evidence: read4, exists });
    assert.equal(findings.length, 1);
    assert.match(findings[0].because, /nope\.js/);
  });

  // Fail open. A detector that punishes an unusual format teaches the model to
  // stop emitting the format, and then the thing being measured disappears.
  await t.test('prose under the label is not guessed at', () => {
    const prose = '## Review\n- Verified Files:\n    - everything under the ui directory';
    assert.deepEqual(auditHandover(prose, { evidence: read4, exists }).findings, []);
  });

  await t.test('an honest disclaimer is not a finding', () => {
    const none = '## Review\n- Verified Files: none — I answered from the earlier reads';
    assert.deepEqual(auditHandover(none, { evidence: new Map(), exists }).findings, []);
  });

  // The model supplies these strings, and `../` reaches real files in a sibling
  // project that say nothing about this claim. The caller's `exists` resolves
  // against the workspace and refuses anything that escapes it, so such a path
  // is reported unverified rather than silently confirmed.
  await t.test('a path outside the workspace is unverified, not true', () => {
    const escape = '## Review\n- Verified Files: `../other-project/src/main.js`';
    const { findings } = auditHandover(escape, { evidence: read4, exists: () => false });
    assert.equal(findings.length, 1);
    assert.match(findings[0].because, /other-project/);
  });

  /*
   * An extensionless path is not recognised, and that is the fail-open choice.
   *
   * `server/src/github/` — a directory, which the original reported failure also
   * contained — cannot be told from prose by shape alone, and guessing wrong
   * means reporting an honest block as a lie. Written down because the gap is
   * deliberate and would otherwise read as an oversight.
   */
  await t.test('a bare directory is not treated as a path claim', () => {
    const dir = '## Review\n- Verified Files: `server/src/github/`';
    assert.deepEqual(auditHandover(dir, { evidence: read4, exists: () => false }).findings, []);
  });

  await t.test('with no exists predicate it degrades to the read check', () => {
    assert.deepEqual(auditHandover(REPLY, { evidence: read4 }).findings, []);
    assert.equal(auditHandover(REPLY, { evidence: new Map() }).findings.length, 1);
  });
});
