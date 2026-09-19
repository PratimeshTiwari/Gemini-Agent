/**
 * What the turn actually did, handed back before it reports on itself.
 *
 * `pro-handover-review.md` asks the model to say what it ran and whose callers
 * it checked, in bold, with the hedge explicitly forbidden. Nothing ever
 * compared the answer to anything — so prose was always cheaper than a tool
 * call and looked identical on screen. One observed review closed with
 * `Ran: Adversarial security and reliability analysis` having run no command,
 * and `Callers checked: …` having called `find_references` zero times.
 *
 * Two properties make this worth its dozen characters:
 *
 * - **Derived, never declared.** The model cannot write it, so it cannot write
 *   it wrong.
 * - **It arrives before the claim.** Prevention, the same argument as the tool
 *   anchor: 56 tokens that stop the denial beat three detectors that catch it.
 *
 * And it rides on the *tool-result* prompt rather than `buildPrompt`, because
 * `buildPrompt` runs once at the top of a turn when nothing has happened yet.
 * A tally there would read zero on every turn, forever — which is the shape of
 * a fix that looks right and is inert.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop } from '../../src/core/agent-loop.js';
import { PromptBuilder } from '../../src/core/prompt-builder.js';

const WS = process.cwd();

describe('the turn tally', () => {
  const loop = () => {
    const l = Object.create(AgentLoop.prototype);
    l._turnEvidence = new Map();
    return l;
  };

  test('is empty before anything has run', () => {
    assert.equal(loop().turnEvidence, '');
  });

  test('names the tools, and counts repeats', () => {
    const l = loop();
    l._turnEvidence.set('read_file', 3);
    l._turnEvidence.set('run_command', 1);

    // `run_command` rather than `run_command×1`: the count is noise when it is
    // one, and "did it run a command" is the question being answered.
    assert.equal(l.turnEvidence, 'read_file×3, run_command');
  });

  // Absence is the claim. A list padded with `find_references×0` would be the
  // model's own excuse written for it.
  test('says nothing about tools that did not run', () => {
    const l = loop();
    l._turnEvidence.set('read_file', 1);
    assert.doesNotMatch(l.turnEvidence, /find_references|run_command/);
  });

  test('survives a loop that never initialised it', () => {
    const l = Object.create(AgentLoop.prototype);
    assert.equal(l.turnEvidence, '');
  });
});

describe('the tool-result prompt carries it', () => {
  const build = (results, evidence) =>
    new PromptBuilder(WS, `${WS}/server`).buildToolResultBatch(results, evidence);

  const RESULT = [{ name: 'read_file', result: 'ok' }];

  test('the tally is in the prompt, with what to do about it', () => {
    const p = build(RESULT, 'read_file×3, run_command');

    assert.match(p, /<turn_so_far>read_file×3, run_command<\/turn_so_far>/);
    assert.match(p, /Report only what is in that list/);
  });

  /*
   * The negative control, and the reason this file is not decorative: a block
   * that renders when there is nothing to put in it teaches the model that an
   * empty tally is normal, which is exactly the signal being sent.
   */
  test('nothing is added when nothing has run', () => {
    const p = build(RESULT, '');

    assert.doesNotMatch(p, /turn_so_far/);
    assert.doesNotMatch(p, /Report only what is in that list/);
  });

  /*
   * The argument for it is that it is nearly free, and every character here is
   * retyped into a browser on every round. Measured against the *wrapper*
   * rather than the whole block, because the tally itself is the payload and
   * grows with the work — a flat cap would fail on a busy turn rather than on
   * the thing worth catching, which is someone turning this into a paragraph.
   */
  test('it is cheap, which is the whole argument for it', () => {
    const tally = 'read_file×3, run_command';
    const overhead = build(RESULT, tally).length - build(RESULT, '').length - tally.length;

    assert.ok(overhead < 110, `the wrapper around the tally grew to ${overhead} characters`);
  });

  // It goes after the results and before the instruction: the model reads the
  // last thing hardest, and the last thing must stay "what to do next".
  test('it does not displace the closing instruction', () => {
    const p = build(RESULT, 'read_file');

    assert.ok(p.indexOf('</tool_results>') < p.indexOf('<turn_so_far>'));
    assert.ok(p.indexOf('<turn_so_far>') < p.indexOf('Reply once, with exactly one of'));
  });
});

describe('the loop counts what it dispatches', () => {
  /** A loop wired just enough to run `_executeToolCalls` and see what it sent. */
  const driven = (toolResult) => {
    const dir = mkdtempSync(join(tmpdir(), 'evidence-'));
    const sent = [];
    const l = Object.create(AgentLoop.prototype);
    Object.assign(l, {
      workspace: dir,
      mode: 'auto',
      modelConfig: { main: 'gemini' },
      conversationHistory: [],
      commandRules: { enabled: false, allow: [], block: [] },
      sessionStore: { appendTurn() {} },
      riskClassifier: { classify: () => ({ level: 'safe', reason: '' }) },
      mcpServer: { executeTool: async () => toolResult },
      promptBuilder: {
        noteMessageSent() {},
        buildToolResultBatch: (r, ev) => `RESULTS|${ev}`,
      },
      callbacks: { sendToPanel() {} },
      _sendToGemini: (prompt) => sent.push(prompt),
      _turnEvidence: new Map(),
    });
    return { l, sent, dir };
  };

  test('what ran reaches the next prompt', async () => {
    const { l, sent, dir } = driven({ success: true, result: 'file contents' });
    await l._executeToolCalls([
      { name: 'read_file', args: { path: 'a.js' } },
      { name: 'read_file', args: { path: 'b.js' } },
    ]);

    assert.equal(sent.length, 1);
    assert.equal(sent[0], 'RESULTS|read_file×2');
    rmSync(dir, { recursive: true, force: true });
  });

  /*
   * Counted where dispatched, not where they succeed. "I ran the tests and
   * they failed" is a true and useful claim, and a tally of successes only
   * would mark it unsupported — turning the check into something that punishes
   * honesty about a failure.
   */
  test('a call that failed still counts as having been made', async () => {
    const { l, sent, dir } = driven({ success: false, error: 'ENOENT' });
    await l._executeToolCalls([{ name: 'read_file', args: { path: 'missing.js' } }]);

    assert.equal(sent[0], 'RESULTS|read_file');
    rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * The handover review rides the round that earned it.
 *
 * It used to ride the opening prompt: 1,879 characters of "check your work
 * before you say you are finished", delivered before the turn had done
 * anything, and then thousands of tokens behind the model by the time it
 * mattered. The same failure the tool anchor exists for, and the same cure —
 * put the instruction where it applies rather than saying it louder up front.
 */
describe('the handover arrives when there is something to hand over', () => {
  const loop = (effort = 'deep') => {
    const l = Object.create(AgentLoop.prototype);
    l.modelConfig = { main: 'gemini', effort };
    l._turnEvidence = new Map();
    l._handoverSent = false;
    l.promptBuilder = new PromptBuilder(WS, `${WS}/server`);
    return l;
  };

  test('a turn that changed something gets it', () => {
    const l = loop();
    l._turnEvidence.set('edit_file', 1);
    assert.match(l._dueHandover(), /THE HANDOVER REVIEW/);
  });

  /*
   * The control, and the reason the gate is on evidence rather than the rung.
   * A turn that only read files has nothing to hand over, and asking it for a
   * review produces the empty ceremony already seen in use — "Checklist: 0/0
   * done (Resetting state) · Ran: N/A · Callers checked: 0".
   */
  test('a turn that only looked at things does not', () => {
    const l = loop();
    l._turnEvidence.set('read_file', 9);
    l._turnEvidence.set('grep_search', 3);
    assert.equal(l._dueHandover(), '');
  });

  test('running a command counts as having done something', () => {
    const l = loop();
    l._turnEvidence.set('run_command', 1);
    assert.match(l._dueHandover(), /THE HANDOVER REVIEW/);
  });

  // Once per turn. Repeating it on every later round is the large repeated
  // payload the whole prompt strategy exists to avoid.
  test('it goes out once, not on every round after', () => {
    const l = loop();
    l._turnEvidence.set('edit_file', 1);
    assert.ok(l._dueHandover().length > 0);
    assert.equal(l._dueHandover(), '', 'sent twice in one turn');
    assert.equal(l._dueHandover(), '');
  });

  // The flash rungs carry their own, inline and much smaller. Sending them this
  // one too would be the same text twice at the rung least able to afford it.
  test('the flash rungs are left alone', () => {
    for (const effort of ['flash', 'flash-thinking']) {
      const l = loop(effort);
      l._turnEvidence.set('edit_file', 1);
      assert.equal(l._dueHandover(), '', effort);
    }
  });

  test('brief gets the short version, deep the long one', () => {
    const b = loop('brief'); b._turnEvidence.set('edit_file', 1);
    const d = loop('deep'); d._turnEvidence.set('edit_file', 1);
    assert.match(b._dueHandover(), /BEFORE YOU FINISH/);
    assert.match(d._dueHandover(), /THE HANDOVER REVIEW/);
  });
});

/**
 * Full once per chat, a pointer after — the tool anchor's shape.
 *
 * Moving the handover to "once per working turn" looked like a reduction and
 * was not. Measured on real use rather than on the test fixtures that flattered
 * it: turns are short (median 1 message) and 29% of them change something, so
 * per-working-turn sends this **five times** where the old every-20-messages
 * refresh sent it once. Five times a small block beats once inside a
 * 26,000-character payload — but it grows with session length, and repeated
 * payloads are the thing the whole prompt strategy exists to avoid.
 */
describe('the handover repeats as a reminder, not as itself', () => {
  const builder = () => new PromptBuilder(WS, `${WS}/server`);

  test('the full block once, a pointer after', () => {
    const pb = builder();
    const first = pb.buildHandoverBlock('deep');
    const second = pb.buildHandoverBlock('deep');

    assert.match(first, /THE HANDOVER REVIEW/);
    assert.ok(first.length > 1000, `the first one is only ${first.length} characters`);
    assert.doesNotMatch(second, /THE HANDOVER REVIEW/);
    assert.ok(second.length < 200, `the reminder is ${second.length} characters`);
  });

  // It must still *ask* for the thing, or the reminder is decoration.
  test('the pointer names what it wants', () => {
    const pb = builder();
    pb.buildHandoverBlock('deep');
    assert.match(pb.buildHandoverBlock('deep'), /## Review/);
  });

  /*
   * A new chat has seen nothing, whatever the old one saw. Without this the
   * model gets a pointer to a block it was never given — the drift
   * `toolCatalogDrift` exists to catch, in a different costume.
   */
  test('a new thread gets the full block again', () => {
    const pb = builder();
    pb.buildHandoverBlock('deep');
    pb.resetPromptState();
    assert.match(pb.buildHandoverBlock('deep'), /THE HANDOVER REVIEW/);
  });

  test('over ten working turns it costs a reminder, not ten blocks', () => {
    const pb = builder();
    let total = 0;
    for (let i = 0; i < 10; i++) total += pb.buildHandoverBlock('deep').length;

    assert.ok(total < 4000, `ten turns cost ${total} characters`);
  });
});
