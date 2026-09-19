/**
 * `find_references` answered **0** for every method in the repo.
 *
 * A method is only ever called as `x.name()`, and `referencesIn` excluded
 * member properties — correctly, for a binding: `fs.readFile` does not use a
 * `readFile` variable. Nothing distinguished the two questions, so the answer
 * to "who calls this method?" was always nothing.
 *
 * Measured on this repo before the fix, through the real tool:
 *
 *     buildToolResultBatch    0 references    (2 call sites in src, 17 with tests)
 *     acceptDiff              0 references    (3 call sites in src)
 *     classify                4 references    (the standalone function only)
 *
 * and the 0 case returns `It may be dead code, or reached by a computed name.`
 * That is the `semantic_search` failure exactly — the model reaches for the
 * tool, is told the code is not there, and acts on it. Here the action it
 * invites is deletion.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findReferences } from '../../src/mcp/tools/find-symbol.js';

/** A workspace with a class, a caller, and some `Array.prototype` noise. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'refs-'));
  mkdirSync(join(dir, 'src'), { recursive: true });

  writeFileSync(join(dir, 'src', 'builder.js'), `
export class PromptBuilder {
  buildToolResultBatch(results) {
    return results.map((r) => r.name).join(',');
  }
}
`);
  writeFileSync(join(dir, 'src', 'loop.js'), `
import { PromptBuilder } from './builder.js';
export function run(loop, results) {
  const pb = new PromptBuilder();
  const a = pb.buildToolResultBatch(results);
  const b = loop.promptBuilder.buildToolResultBatch(results);
  return [a, b].map((x) => x).join('');
}
`);
  return dir;
}

const lines = (r) => (r.files ?? []).flatMap((f) => f.lines.map((l) => ({ file: f.file, ...l })));

describe('a method has callers', () => {
  test('the calls are found, where there used to be none', async () => {
    const dir = repo();
    const r = await findReferences({ name: 'buildToolResultBatch', includeDefinition: false },
      { workspace: dir });

    assert.equal(r.found, 2, `expected both call sites, got ${r.found}: ${r.message ?? ''}`);
    assert.ok(lines(r).some((l) => /pb\.buildToolResultBatch/.test(l.text)));
    assert.ok(lines(r).some((l) => /loop\.promptBuilder\.buildToolResultBatch/.test(l.text)),
      'a call through two levels of property was missed');
    rmSync(dir, { recursive: true, force: true });
  });

  /*
   * The message is the dangerous half. "It may be dead code" about a method
   * called twice is the tool arguing for its own deletion.
   */
  test('it is not reported as possibly dead', async () => {
    const dir = repo();
    const r = await findReferences({ name: 'buildToolResultBatch', includeDefinition: false },
      { workspace: dir });

    assert.doesNotMatch(r.message ?? '', /dead code/);
    rmSync(dir, { recursive: true, force: true });
  });

  /*
   * `x.name` cannot be told from a same-named method on another object, so the
   * answer says which hits came that way rather than hiding it. An answer that
   * conceals its own ambiguity is the one that gets acted on wrongly.
   */
  test('member hits are marked and the ambiguity is stated', async () => {
    const dir = repo();
    const r = await findReferences({ name: 'buildToolResultBatch', includeDefinition: false },
      { workspace: dir });

    assert.ok(lines(r).every((l) => l.viaMember), 'member hits were mixed in unmarked');
    assert.match(r.methodNote, /viaMember/);
    rmSync(dir, { recursive: true, force: true });
  });

  test('the definition is still found, and still marked as one', async () => {
    const dir = repo();
    const r = await findReferences({ name: 'buildToolResultBatch', includeDefinition: true },
      { workspace: dir });

    assert.equal(r.found, 3);
    assert.equal(lines(r).filter((l) => l.isDefinition).length, 1);
    rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * "list the definition too (default true)" and "the definition is marked" are
 * what the prompt says. For a function, whose `id` is a real Identifier, that
 * was true. For a method it was not: a non-computed `MethodDefinition` key is
 * deliberately never visited, so the definition simply was not in the answer.
 *
 * Another instance of the shape this repo keeps finding — the model was told
 * the truth and the code was doing something else.
 */
describe('the definition is listed, for a method as well as a function', () => {
  test('a method definition appears and is marked', async () => {
    const dir = repo();
    const r = await findReferences({ name: 'buildToolResultBatch' }, { workspace: dir });
    const def = lines(r).find((l) => l.isDefinition);

    assert.ok(def, 'the definition is missing from an answer that promises to list it');
    assert.match(def.file, /builder\.js$/);
    assert.match(def.text, /buildToolResultBatch/, 'the definition came back as a bare line number');
    rmSync(dir, { recursive: true, force: true });
  });

  test('and a function definition still appears exactly once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'refs-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.js'), 'export function helper() {}\nhelper();\n');

    const r = await findReferences({ name: 'helper' }, { workspace: dir });

    assert.equal(lines(r).filter((l) => l.isDefinition).length, 1,
      'the definition was added a second time on top of its own Identifier');
    assert.equal(r.found, 2);
    rmSync(dir, { recursive: true, force: true });
  });

  // The control: asked not to, it does not.
  test('includeDefinition false still excludes it', async () => {
    const dir = repo();
    const r = await findReferences({ name: 'buildToolResultBatch', includeDefinition: false },
      { workspace: dir });

    assert.ok(!lines(r).some((l) => l.isDefinition));
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('and a name that is not a method here is left alone', () => {
  /*
   * The control, and the reason this is gated rather than always on. `map` and
   * `join` are `Array.prototype`, not this repo's — measured unconditionally on
   * the real repo they are 165 and 180 hits, a wall of text about the standard
   * library, every character of which is retyped into a browser next turn.
   */
  test('map and join do not become a wall of Array.prototype', async () => {
    const dir = repo();
    for (const name of ['map', 'join']) {
      const r = await findReferences({ name, includeDefinition: false }, { workspace: dir });
      assert.equal(r.found ?? 0, 0, `${name} pulled in ${r.found} standard-library uses`);
      assert.equal(r.methodNote, undefined);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  /*
   * And the original correctness this must not undo: a member access is not a
   * use of a *binding* of that name. `fs.readFile` is not `readFile`.
   */
  test('a member access is still not a use of a same-named function', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'refs-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.js'), 'export function readFile() {}\n');
    writeFileSync(join(dir, 'src', 'b.js'), 'import fs from "fs";\nfs.readFile("x");\n');

    const r = await findReferences({ name: 'readFile', includeDefinition: false }, { workspace: dir });

    assert.equal(r.found ?? 0, 0, '`fs.readFile` was counted as a use of the local function');
    rmSync(dir, { recursive: true, force: true });
  });
});
