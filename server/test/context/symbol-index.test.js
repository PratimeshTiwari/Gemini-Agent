/**
 * The symbol index, and the two ways its predecessor failed.
 *
 * `ast-chunker` was deleted for resolving **24%** of this repo's own top-level
 * symbols: it walked `ast.body`, so every class method and every
 * `export const foo = () => {}` was invisible, and plain acorn cannot parse
 * `.jsx` at all — which is most of `ui/`. Both failures are load-bearing tests
 * here, because "it finds some symbols" is precisely the state that makes a
 * search tool worse than none: the model looks, finds nothing, and concludes
 * the code is not there.
 *
 * The third failure is subtler and is why this parses rather than greps: a name
 * in a comment, in a string, or as an object key is not a use of that symbol.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { definitionsIn, referencesIn, SymbolIndex } from '../../src/context/symbol-index.js';

const kinds = (src) => definitionsIn(src).map((d) => `${d.kind} ${d.name}`).sort();

describe('every shape the old chunker missed', () => {
  test('a class and its methods, not just the class', () => {
    const found = kinds(`
      export class PromptBuilder {
        constructor() {}
        buildPrompt(o) { return o; }
        static make() {}
        get mainModel() { return 1; }
      }
    `);
    assert.ok(found.includes('class PromptBuilder'));
    assert.ok(found.includes('method buildPrompt'), 'methods were the bulk of the missing 76%');
    assert.ok(found.includes('method make'));
    assert.ok(found.includes('get mainModel'), 'a getter is a definition people search for');
    // Not the constructor: every class has one, so indexing it means
    // find_symbol("constructor") answers with the whole codebase.
    assert.ok(!found.includes('method constructor'));
    assert.ok(!found.some((f) => f.endsWith(' constructor')));
  });

  test('a function assigned to a const', () => {
    // `export const foo = () => {}` is not a FunctionDeclaration and is not a
    // top-level statement's `id` — it was invisible to the walk that preceded.
    const found = kinds('export const resolveEffort = (cfg) => cfg;');
    assert.deepEqual(found, ['function resolveEffort']);
  });

  test('a function in an object literal', () => {
    const found = kinds('const api = { load() {}, save: () => {} };');
    assert.ok(found.includes('method load'));
    assert.ok(found.includes('method save'));
  });

  test('plain data is not a definition', () => {
    // Indexing every object key makes every config value a "symbol", and the
    // result is a search that always hits and never helps.
    const found = definitionsIn('const config = { retries: 3, name: "x" };').map((d) => d.name);
    assert.ok(!found.includes('retries'), 'a number is not something you jump to');
    assert.ok(found.includes('config'));
  });

  test('line numbers are the definition\'s own', () => {
    const defs = definitionsIn('\n\n\nexport function go() {}\n');
    assert.equal(defs.find((d) => d.name === 'go').line, 4);
  });
});

describe('JSX — the other half the chunker could not read', () => {
  const JSX = `
    import { Banner } from './Banner.jsx';
    export function App({ title }) {
      return <div className="x"><Banner name={title} /></div>;
    }
  `;

  test('a .jsx file yields its definitions', () => {
    // acorn-jsx teaches the *parser*; acorn-walk still throws "No walker
    // function defined for node type JSXElement". Adding one without the other
    // is how "acorn cannot parse .jsx" gets written down as a fact.
    assert.ok(kinds(JSX).includes('function App'));
  });

  test('a component used as a tag is a reference', () => {
    // It is a JSXIdentifier, not an Identifier, so a check for one node type
    // misses every component — which in ui/components is the only use there is.
    const refs = referencesIn(JSX, 'Banner');
    assert.equal(refs.length, 2, 'expected the import and the tag');
  });

  test('an attribute name is not a reference', () => {
    assert.equal(referencesIn(JSX, 'className').length, 0);
  });
});

describe('a reference is a use, which is not a match', () => {
  const SRC = `
    import { logError } from './error-log.js';
    // logError is mentioned in this comment
    const msg = 'call logError here';
    const opts = { logError: 1 };
    function go() { logError({}); }
    fs.logError;
  `;

  test('the import and the call, and nothing else', () => {
    const refs = referencesIn(SRC, 'logError');
    assert.equal(refs.length, 2, `grep would return 6; got ${refs.length}`);
  });

  test('a comment is not a use', () => {
    assert.ok(!referencesIn(SRC, 'logError').some((r) => r.line === 3));
  });

  test('a string is not a use', () => {
    assert.ok(!referencesIn(SRC, 'logError').some((r) => r.line === 4));
  });

  test('an object key is not a use', () => {
    assert.ok(!referencesIn(SRC, 'logError').some((r) => r.line === 5));
  });

  test('a member property is not a use of a binding', () => {
    assert.ok(!referencesIn(SRC, 'logError').some((r) => r.line === 7));
  });

  test('a renamed import is found under both names', () => {
    const src = "import { InputBar as Bar } from './x.js';\nBar();";
    assert.equal(referencesIn(src, 'InputBar').length, 1, 'searching the real name missed the import');
    assert.equal(referencesIn(src, 'Bar').length, 2);
  });

  test('a plain import is counted once, not twice', () => {
    // acorn gives `imported` and `local` the same position for `import { X }`,
    // and both have to be visited for the import to be found at all.
    assert.equal(referencesIn("import { X } from './x.js';", 'X').length, 1);
  });
});

describe('SymbolIndex over a tree', () => {
  let ws;
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'sym-'));
    mkdirSync(join(ws, 'src'), { recursive: true });
    writeFileSync(join(ws, 'src', 'a.js'), 'export class Alpha {\n  run() {}\n}\n');
    writeFileSync(join(ws, 'src', 'b.js'), "import { Alpha } from './a.js';\nnew Alpha().run();\n");
  });
  afterEach(() => rmSync(ws, { recursive: true, force: true }));

  test('definitions and uses across files', () => {
    const idx = new SymbolIndex(ws).refresh();
    assert.deepEqual(idx.find('Alpha'), [{ file: 'src/a.js', line: 1, kind: 'class' }]);
    assert.equal(idx.references('Alpha').length, 3);
  });

  test('an unchanged file is not reparsed', () => {
    const idx = new SymbolIndex(ws).refresh();
    const before = idx.files.get(join(ws, 'src', 'a.js'));
    idx.refresh();
    assert.equal(idx.files.get(join(ws, 'src', 'a.js')), before, 'the cache entry was replaced');
  });

  test('an edited file is picked up', () => {
    const idx = new SymbolIndex(ws).refresh();
    writeFileSync(join(ws, 'src', 'a.js'), 'export class Beta {}\n');
    utimesSync(join(ws, 'src', 'a.js'), new Date(), new Date(Date.now() + 2000));
    idx.refresh();
    assert.deepEqual(idx.find('Alpha'), []);
    assert.equal(idx.find('Beta').length, 1);
  });

  test('a deleted file leaves nothing behind', () => {
    const idx = new SymbolIndex(ws).refresh();
    rmSync(join(ws, 'src', 'a.js'));
    idx.refresh();
    assert.deepEqual(idx.find('Alpha'), [], 'a stale index is the failure this replaces');
  });

  test('a syntax error costs that file and no other', () => {
    writeFileSync(join(ws, 'src', 'broken.js'), 'function ( { oops\n');
    const idx = new SymbolIndex(ws).refresh();
    assert.equal(idx.find('Alpha').length, 1, 'one bad file made the whole index unavailable');
    assert.ok(idx.skipped.some((s) => s.file.endsWith('broken.js')));
  });

  test('what cannot be read is named, not silently dropped', () => {
    // The failure that matters is the model searching, finding nothing, and
    // concluding the symbol does not exist.
    writeFileSync(join(ws, 'src', 'c.ts'), 'export const typed: number = 1;\n');
    const idx = new SymbolIndex(ws).refresh();
    const skip = idx.skipped.find((s) => s.file.endsWith('c.ts'));
    assert.ok(skip, 'a TypeScript file vanished without a word');
    assert.match(skip.reason, /\.ts/);
  });

  test('node_modules is not indexed, at any depth', () => {
    mkdirSync(join(ws, 'server', 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(ws, 'server', 'node_modules', 'dep', 'i.js'), 'export class Alpha {}\n');
    const idx = new SymbolIndex(ws).refresh();
    assert.equal(idx.find('Alpha').length, 1, 'a dependency answered for the project');
  });
});
