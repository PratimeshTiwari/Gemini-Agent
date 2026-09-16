/**
 * The checklist the model writes, handed back to it.
 *
 * Reported from use: on the pro tier Gemini created the task list and never
 * ticked anything. It is not prompt adherence — it was mechanically very hard.
 *
 * The system prompt tells the model to create `.agent/artifacts/task.md` and
 * tick items off, and the file it writes was read by exactly one thing: the UI,
 * to draw a row above the prompt. **No prompt ever carried its contents back.**
 * Measured before the fix: absent from turn 0, from every tool-result turn, and
 * from twenty-five further turns including refreshes.
 *
 * So ticking meant guessing the exact line text for `edit_file` — which fails
 * outright on a mismatch — or rewriting the file from a memory that compaction
 * erodes. This is the same write-only trap CLAUDE.md records for `manage_memory`
 * before phase 3, in a second place, and it has the same fix: the missing half,
 * not a new mechanism.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PromptBuilder } from '../../src/core/prompt-builder.js';

let ws;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'task-'));
  mkdirSync(join(ws, '.agent', 'artifacts'), { recursive: true });
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

const writeTask = (body) => writeFileSync(join(ws, '.agent', 'artifacts', 'task.md'), body);
const mc = { effort: 'standard', main: 'gemini' };
const build = (pb, msg = 'go') =>
  pb.buildPrompt({ userMessage: msg, mode: 'auto', topology: 'single', modelConfig: mc });

describe('the checklist comes back', () => {
  test('on turn 0', () => {
    writeTask('- [ ] Rename the variable\n- [ ] Update the callers\n');
    assert.match(build(new PromptBuilder(ws, ws)), /Update the callers/);
  });

  test('on every turn after it, because ticking is a per-turn act', () => {
    // Memory rides turn 0 and the refresh; this cannot. A checklist the model
    // last saw twenty turns ago is one it has to guess the text of.
    writeTask('- [ ] Rename the variable\n');
    const pb = new PromptBuilder(ws, ws);
    for (let i = 0; i < 5; i += 1) {
      assert.match(build(pb, `turn ${i}`), /<task_checklist path=/, `turn ${i} dropped it`);
    }
  });

  test('it carries the path, so the model knows what to edit', () => {
    writeTask('- [ ] Something\n');
    assert.match(build(new PromptBuilder(ws, ws)), /path="\.agent\/artifacts\/task\.md"/);
  });

  test('ticked items come back ticked', () => {
    // The whole point: the model has to see what is already done, or it reports
    // progress it did not make.
    writeTask('- [x] Done\n- [ ] Not done\n');
    const p = build(new PromptBuilder(ws, ws));
    assert.match(p, /- \[x\] Done/);
    assert.match(p, /- \[ \] Not done/);
  });
});

describe('what is left out', () => {
  test('no file, no block', () => {
    assert.ok(!build(new PromptBuilder(ws, ws)).includes('<task_checklist path='));
  });

  test('an empty file is not an empty block', () => {
    writeTask('   \n\n');
    assert.ok(!build(new PromptBuilder(ws, ws)).includes('<task_checklist path='));
  });

  test('the model\'s own preamble is not read back to it', () => {
    writeTask('# Task\n\nA long explanation of the plan that the model wrote itself.\n\n- [ ] Step one\n');
    const p = build(new PromptBuilder(ws, ws));
    assert.match(p, /- \[ \] Step one/);
    assert.ok(!p.includes('A long explanation'), 'its own prose costs tokens every turn for nothing');
  });

  test('a file with no checklist at all still comes back', () => {
    // Better to show what is there than to decide it is not a checklist and
    // silently send nothing.
    writeTask('Just some notes about the task.\n');
    assert.match(build(new PromptBuilder(ws, ws)), /Just some notes/);
  });
});

describe('bounded, because nothing prunes it', () => {
  test('a runaway checklist is capped and says how much it dropped', () => {
    writeTask(Array.from({ length: 120 }, (_, i) => `- [ ] Item ${i}`).join('\n'));
    const p = build(new PromptBuilder(ws, ws));
    const block = p.slice(p.indexOf('<task_checklist path='), p.indexOf('</task_checklist>'));
    assert.ok(block.split('\n').length < 50, 'a 120-item list rode the prompt whole');
    assert.match(block, /and \d+ more/);
  });

  test('very long items are truncated rather than sent whole', () => {
    writeTask(Array.from({ length: 30 }, (_, i) => `- [ ] ${'x'.repeat(300)} ${i}`).join('\n'));
    const p = build(new PromptBuilder(ws, ws));
    const block = p.slice(p.indexOf('<task_checklist path='), p.indexOf('</task_checklist>'));
    assert.ok(block.length < 2300, `the block was ${block.length} characters`);
  });

  test('it stays small enough to ride every turn', () => {
    // The argument for putting it on every turn is that it is cheap. If a
    // typical checklist is not cheap, the argument fails.
    writeTask('- [x] Rename the variable\n- [ ] Update the callers\n- [ ] Run the tests\n');
    const p = build(new PromptBuilder(ws, ws));
    const block = p.slice(p.indexOf('<task_checklist path='), p.indexOf('</task_checklist>') + 17);
    assert.ok(block.length < 400, `${block.length} chars on every turn is not cheap`);
  });
});

describe('it must never break a turn', () => {
  test('an unreadable artifact is silence, not a throw', () => {
    // A directory where the file should be: readFileSync throws EISDIR.
    mkdirSync(join(ws, '.agent', 'artifacts', 'task.md'), { recursive: true });
    assert.doesNotThrow(() => build(new PromptBuilder(ws, ws)));
  });
});

describe('the instruction matches the mechanism', () => {
  test('the prompt says the checklist is given back', () => {
    // Note for anyone editing these: the *instruction* also contains the string
    // "<task_checklist>", so a test looking for the block must match the
    // opening tag with its path attribute or it matches the instruction.
    // An instruction to update a file the model cannot see is the bug this
    // fixes; saying so is what makes the fix usable.
    writeTask('- [ ] Something\n');
    const p = build(new PromptBuilder(ws, ws));
    assert.match(p, /task_checklist/);
    assert.match(p, /- \[x\]/, 'it never says what ticking looks like');
  });
});
