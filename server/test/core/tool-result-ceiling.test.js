/**
 * The ceiling, end to end, on the shape that motivated it.
 *
 * `result-budget.test.js` covers the arithmetic. This covers what actually goes
 * into the browser: five parallel `run_command` results, 50 KB each, because
 * the per-tool cap is per tool and `_executeToolCalls` runs them at once.
 *
 * The spooling is what makes truncation non-lossy, and it is the whole
 * difference between this and the caps that already existed: a cut result the
 * model cannot recover is a decision made on its behalf about what mattered.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PromptBuilder } from '../../src/core/prompt-builder.js';
import * as paths from '../../src/core/paths.js';

const SRC = `${process.cwd()}/server`;

function builderIn() {
  const ws = mkdtempSync(join(tmpdir(), 'ceiling-'));
  mkdirSync(join(ws, '.agent'), { recursive: true });
  return { pb: new PromptBuilder(ws, SRC), ws };
}

const bulk = (chars, tag = 'out') => `${tag} line\n`.repeat(Math.ceil(chars / 9));

describe('five parallel commands do not become a quarter-megabyte prompt', () => {
  test('the batch is bounded however big the results are', () => {
    const { pb, ws } = builderIn();
    const five = Array.from({ length: 5 }, (_, i) => ({
      name: 'run_command', result: bulk(50000, `cmd${i}`),
    }));

    const before = five.reduce((n, r) => n + r.result.length, 0);
    const after = pb.buildToolResultBatch(five).length;

    assert.ok(before > 180000, 'the fixture is not the reported shape');
    assert.ok(after < 20000, `batch was ${after} characters`);
    rmSync(ws, { recursive: true, force: true });
  });

  /*
   * Fairness, through the real method. First-come would spend the whole budget
   * on the 200 KB result at position 0 and leave four one-line reads with
   * nothing — losing four cheap answers to pay for one expensive one.
   */
  test('one huge result does not swallow four small ones', () => {
    const { pb, ws } = builderIn();
    const out = pb.buildToolResultBatch([
      { name: 'run_command', result: bulk(200000) },
      ...Array.from({ length: 4 }, (_, i) => ({ name: 'read_file', result: `small ${i}` })),
    ]);

    for (const i of [0, 1, 2, 3]) {
      assert.match(out, new RegExp(`small ${i}`), `read ${i} was cut for the big one`);
    }
    rmSync(ws, { recursive: true, force: true });
  });

  test('a batch that already fits is untouched', () => {
    const { pb, ws } = builderIn();
    const small = [{ name: 'read_file', result: 'a tiny result' }];

    assert.match(pb.buildToolResultBatch(small), /a tiny result/);
    assert.doesNotMatch(pb.buildToolResultBatch(small), /characters cut/);
    // The directory is not even created — `_spool` is only reached by a result
    // that actually overflowed, so a batch that fits leaves no trace at all.
    assert.equal(existsSync(paths.tmpDir(ws)), false, 'it spooled something it did not need to');
    rmSync(ws, { recursive: true, force: true });
  });
});

describe('what was cut is still reachable', () => {
  test('the full output is on disk and the prompt says where', () => {
    const { pb, ws } = builderIn();
    const full = `${bulk(60000)}ENOENT: the last line, which is the answer\n`;
    const out = pb.buildToolResultBatch([{ name: 'run_command', result: full }]);

    const named = out.match(/\.agent\/tmp\/([\w.-]+\.txt)/);
    assert.ok(named, `the prompt does not say where the rest went: ${out.slice(0, 400)}`);

    const spooled = readFileSync(join(paths.tmpDir(ws), named[1]), 'utf8');
    assert.equal(spooled, full, 'the spooled copy is not the whole thing');
    rmSync(ws, { recursive: true, force: true });
  });

  // The tail is where the error is. A head-only cut would drop exactly the
  // line the model needs and leave it diagnosing the wrong thing confidently.
  test('the end of a failing command survives the cut', () => {
    const { pb, ws } = builderIn();
    const out = pb.buildToolResultBatch([{
      name: 'run_command',
      failed: true,
      result: `${bulk(60000)}ENOENT: the last line, which is the answer\n`,
    }]);

    assert.match(out, /which is the answer/);
    assert.match(out, /status="failed"/, 'the failure marker was lost in the rewrite');
    rmSync(ws, { recursive: true, force: true });
  });
});

describe('the spool does not grow forever', () => {
  test('old spools are pruned and the newest is kept', () => {
    const { pb, ws } = builderIn();
    const dir = paths.tmpDir(ws);
    mkdirSync(dir, { recursive: true });

    // 30 older spools, plus a clipboard image that must survive.
    for (let i = 0; i < 30; i++) {
      writeFileSync(join(dir, `run_command-${(1000 + i).toString(36)}-aaaaaa.txt`), 'old');
    }
    writeFileSync(join(dir, 'clipboard-image.png'), 'not yours');

    const out = pb.buildToolResultBatch([{ name: 'run_command', result: bulk(60000) }]);
    const left = readdirSync(dir);

    assert.ok(left.length <= 21, `${left.length} files left in .agent/tmp`);
    assert.ok(left.includes('clipboard-image.png'), 'it deleted a file that was not its own');

    const named = out.match(/\.agent\/tmp\/([\w.-]+\.txt)/);
    assert.ok(left.includes(named[1]), 'it pruned the file it had just written');
    rmSync(ws, { recursive: true, force: true });
  });
});

describe('it cannot fail a turn', () => {
  /*
   * A workspace that cannot be written to is not a reason to lose the results.
   * The excerpt is still the useful part; only the pointer to the rest is lost.
   */
  test('an unwritable workspace still produces a prompt', () => {
    const pb = new PromptBuilder('/nonexistent/path/that/cannot/exist', SRC);
    const out = pb.buildToolResultBatch([{ name: 'run_command', result: bulk(60000) }]);

    assert.match(out, /<tool_results>/);
    assert.match(out, /characters cut/);
    assert.doesNotMatch(out, /\.agent\/tmp/, 'it claimed a spool it could not write');
  });
});
