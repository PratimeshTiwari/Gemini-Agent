/**
 * The audit is only worth anything if something runs it.
 *
 * `handover-audit.test.js` covers the judgement; this covers the wiring, which
 * is where this repo's write-only traps have all lived. `getAllMemories` had no
 * callers, `task.md` was written and never read back, `rememberWorkspace`
 * existed with nothing calling it — three times the mechanism was right and
 * nothing connected it.
 *
 * So: does a real turn ending in an unsupported claim produce a row and a log
 * record, and does a turn ending in a supported one produce neither.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop } from '../../src/core/agent-loop.js';
import * as paths from '../../src/core/paths.js';

/** A loop wired just enough to finish a turn and be watched doing it. */
function loopIn(dir, evidence = new Map()) {
  const panel = [];
  const l = Object.create(AgentLoop.prototype);
  Object.assign(l, {
    workspace: dir,
    mode: 'auto',
    modelConfig: { main: 'gemini' },
    conversationHistory: [],
    isProcessing: true,
    sessionStore: { appendTurn() {}, saveHistory() {} },
    promptBuilder: { noteDrift() {}, noteMessageSent() {}, resetPromptState() {} },
    callbacks: { sendToPanel: (m) => panel.push(m) },
    _turnEvidence: evidence,
    _releaseExtension() {},
  });
  return { l, panel };
}

const CLAIMS_A_RUN = `All done.

## Review
- Ran: npm test → everything passes
- Not done / assumed: nothing`;

describe('a finished turn audits its own handover', () => {
  test('an unsupported claim reaches the transcript and the log', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-wire-'));
    mkdirSync(join(dir, '.agent'), { recursive: true });
    const { l, panel } = loopIn(dir);

    l._auditHandover(CLAIMS_A_RUN);

    const row = panel.find((m) => /unverified in the handover/.test(m.payload?.message || ''));
    assert.ok(row, 'nothing was said on screen');
    assert.match(row.payload.message, /no command ran this turn/);

    // The rate is the whole point — `/logs rates` reads this back.
    const log = paths.errorLogPath(dir);
    assert.ok(existsSync(log), 'nothing was logged, so there is no rate to read');
    assert.match(readFileSync(log, 'utf8'), /handover_unsupported/);

    rmSync(dir, { recursive: true, force: true });
  });

  /*
   * The control. A turn that did the work must pass in silence — a row on every
   * turn is a row nobody reads, and it would make the rate meaningless as well.
   */
  test('a supported claim says nothing at all', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-wire-'));
    mkdirSync(join(dir, '.agent'), { recursive: true });
    const { l, panel } = loopIn(dir, new Map([['run_command', 1]]));

    l._auditHandover(CLAIMS_A_RUN);

    assert.equal(panel.length, 0);
    assert.equal(existsSync(paths.errorLogPath(dir)), false);
    rmSync(dir, { recursive: true, force: true });
  });

  test('an ordinary reply with no handover block says nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-wire-'));
    mkdirSync(join(dir, '.agent'), { recursive: true });
    const { l, panel } = loopIn(dir);

    l._auditHandover('I fixed the off-by-one in the cap and the tests pass.');

    assert.equal(panel.length, 0);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('and the turn actually calls it', () => {
  /*
   * The tests above call `_auditHandover` directly, which proves it works and
   * proves nothing about whether anything runs it. That gap is this repo's
   * most-repeated bug — `getAllMemories`, `task.md`, `rememberWorkspace` — so
   * it gets a test that goes through the real path.
   */
  test('a reply with no tool calls is audited on the way out', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-wire-'));
    mkdirSync(join(dir, '.agent'), { recursive: true });
    const { l, panel } = loopIn(dir);
    Object.assign(l, {
      _backgroundCallbacks: null,
      extensionLock: { release() {}, abortAll() {} },
      contextManager: { needsCompaction: () => false },
    });

    await l.handleGeminiResponse('m1', { content: CLAIMS_A_RUN, complete: true });

    assert.ok(
      panel.some((m) => /unverified in the handover/.test(m.payload?.message || '')),
      'the turn ended without auditing its own handover',
    );
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('it reads the real checklist', () => {
  test('a count that does not match task.md is reported', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-wire-'));
    mkdirSync(paths.artifactsDir(dir), { recursive: true });
    writeFileSync(paths.artifactPath(dir, 'task.md'),
      '- [x] one\n- [ ] two\n- [ ] three\n');

    const { l, panel } = loopIn(dir);
    l._auditHandover('## Review\n- Checklist: 3/3 done');

    assert.ok(panel.some((m) => /3 items|are ticked/.test(m.payload?.message || '')),
      `nothing matched; got ${JSON.stringify(panel.map((m) => m.payload?.message))}`);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('it cannot break the turn it audits', () => {
  /*
   * It runs after the reply has already reached the user, on the path that
   * ends a turn. An exception here would turn a finished answer into a failed
   * one — the audit doing more damage than the thing it audits.
   */
  test('a workspace it cannot read does not throw', () => {
    const { l } = loopIn('/nonexistent/path/that/cannot/exist');
    assert.doesNotThrow(() => l._auditHandover(CLAIMS_A_RUN));
  });

  test('a loop with no callbacks does not throw', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-wire-'));
    mkdirSync(join(dir, '.agent'), { recursive: true });
    const { l } = loopIn(dir);
    l.callbacks = null;

    assert.doesNotThrow(() => l._auditHandover(CLAIMS_A_RUN));
    rmSync(dir, { recursive: true, force: true });
  });
});
