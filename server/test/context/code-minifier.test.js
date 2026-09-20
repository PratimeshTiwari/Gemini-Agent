/**
 * The one function on the tool-result hot path, which no test ever called.
 *
 * `PromptBuilder.buildToolResultBatch` embeds every tool result in the next
 * prompt, and serialises non-string results through here. Every fixture in the
 * suite passed a **string**, so the branch was never taken — while real tool
 * results are mostly objects (`find_symbol` returns `{name, found,
 * definitions}`, `manage_task` returns `{tasks: [...]}`).
 *
 * Two things were wrong behind that gap, and the second is the bad one:
 *
 * - `undefined` came back as `undefined`, not a string, under a
 *   `@returns {string}` annotation. The caller reads `.length` off it, so the
 *   whole prompt build throws and every other result in the batch dies with it.
 * - A cycle or a BigInt threw, was caught, and returned `''` — the model handed
 *   a tool that ran and produced nothing. A loud crash is recoverable; a
 *   confident empty result is not.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeMinifier } from '../../src/context/code-minifier.js';
import { PromptBuilder } from '../../src/core/prompt-builder.js';

const min = (v) => CodeMinifier.minifyJson(v);

describe('it always returns a string', () => {
  /*
   * The contract the annotation claimed and the code did not keep. Asserted
   * over every shape a tool handler can plausibly return, rather than the one
   * that happened to break.
   */
  test('whatever it is given', () => {
    const circular = { a: 1 }; circular.self = circular;
    for (const v of [undefined, null, 0, '', 'text', {}, [], { a: 1 }, circular, { n: 1n }, () => {}]) {
      assert.equal(typeof min(v), 'string', `${String(v)} came back as ${typeof min(v)}`);
    }
  });

  test('undefined is empty, not the value undefined', () => {
    assert.equal(min(undefined), '');
  });
});

describe('it never silently loses the content', () => {
  /*
   * The worse of the two bugs. `JSON.stringify` throws on a cycle, the catch
   * returned `''`, and a result with plenty in it arrived as nothing at all.
   */
  test('a cycle keeps everything that is not the cycle', () => {
    const r = { stdout: 'the real output', exitCode: 0 };
    r.self = r;

    const out = min(r);
    assert.match(out, /the real output/, 'the whole result was replaced by an empty string');
    assert.match(out, /exitCode/);
    assert.match(out, /\[circular\]/, 'the cycle should be marked, not dropped in silence');
  });

  test('a BigInt does not take the rest of the object with it', () => {
    const out = min({ bytes: 9007199254740993n, path: 'src/a.js' });
    assert.match(out, /src\/a\.js/);
  });

  // The control: an ordinary object must not go near the cycle path, and must
  // come back as plain compact JSON.
  test('an ordinary object is just compact JSON', () => {
    assert.equal(min({ a: 1, b: [2, 3] }), '{"a":1,"b":[2,3]}');
    assert.doesNotMatch(min({ a: 1 }), /circular/);
  });
});

describe('strings pass through', () => {
  test('non-JSON text is returned unchanged', () => {
    assert.equal(min('ENOENT: no such file'), 'ENOENT: no such file');
    assert.equal(min(''), '');
  });

  test('JSON text is compacted', () => {
    assert.equal(min('{\n  "a": 1\n}'), '{"a":1}');
  });
});

describe('the saving is real', () => {
  /*
   * The number in the doc comment, checked rather than repeated. It is the
   * entire justification for the function existing on the hot path.
   */
  test('a directory listing is about 40% smaller compact', () => {
    const dir = {
      path: '.',
      entries: Array.from({ length: 30 }, (_, i) => ({ name: `file${i}.js`, type: 'file', size: 1234 })),
    };
    const pretty = JSON.stringify(dir, null, 2).length;
    const compact = min(dir).length;

    const saved = 1 - compact / pretty;
    assert.ok(saved > 0.35, `only ${Math.round(saved * 100)}% smaller — the claim is stale`);
  });
});

describe('and the prompt path survives all of it', () => {
  function builder() {
    const ws = mkdtempSync(join(tmpdir(), 'min-'));
    mkdirSync(join(ws, '.agent'), { recursive: true });
    return { pb: new PromptBuilder(ws, `${process.cwd()}/server`), ws };
  }

  /*
   * Through the real method, because the unit test above would pass against a
   * `minifyJson` whose *caller* still could not cope. The failure being pinned
   * is a thrown prompt build, which loses the whole batch and the turn.
   */
  test('a result of undefined does not kill the batch', () => {
    const { pb, ws } = builder();
    assert.doesNotThrow(() => pb.buildToolResultBatch([
      { name: 'read_file', result: undefined },
      { name: 'grep_search', result: 'the other result, which must survive' },
    ]));
    assert.match(
      pb.buildToolResultBatch([
        { name: 'read_file', result: undefined },
        { name: 'grep_search', result: 'the other result, which must survive' },
      ]),
      /must survive/,
      'one bad result took the whole batch with it',
    );
    rmSync(ws, { recursive: true, force: true });
  });

  test('a circular result reaches the model with its content', () => {
    const { pb, ws } = builder();
    const r = { stdout: 'the real output' }; r.self = r;

    assert.match(pb.buildToolResultBatch([{ name: 'run_command', result: r }]), /the real output/);
    rmSync(ws, { recursive: true, force: true });
  });
});
