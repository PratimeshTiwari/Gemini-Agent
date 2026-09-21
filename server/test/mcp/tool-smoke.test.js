/**
 * Every registered tool, called once, on its happy path.
 *
 * This did not exist, and the gap shipped a total breakage: a stray edit left
 * `isMethod` referenced in `findSymbol`, where it is never defined, so **every**
 * `find_symbol` call returned `Tool find_symbol failed: isMethod is not
 * defined`. 1,474 tests were green. `find-references-methods.test.js` covered
 * the sibling function in detail and nothing called `find_symbol` at all.
 *
 * The cause is worth naming because it is a whole class: a Python
 * `str.replace(old, new)` with no count replaces **every** occurrence, and the
 * tail of `findSymbol` was byte-identical to the tail of `findReferences`. This
 * repo's notes already say "a string anchor hits the first match"; replacing
 * without a count is the same trap with the opposite failure.
 *
 * So this is deliberately shallow and total. It asserts almost nothing about
 * *what* each tool returns — the per-tool suites do that — only that calling it
 * the way the agent does does not throw and does not come back a failure. A
 * tool that cannot run at all is the failure mode that costs a whole turn, and
 * the model is told the tool exists by a prompt built from the same catalog.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MCPServer } from '../../src/mcp/mcp-server.js';
import { TaskManager } from '../../src/core/task-manager.js';
import { DiffEngine } from '../../src/core/diff-engine.js';

let ws;
let server;
let taskManager;
let ctx;

before(() => {
  ws = mkdtempSync(join(tmpdir(), 'smoke-'));
  mkdirSync(join(ws, '.agent'), { recursive: true });
  mkdirSync(join(ws, 'src'), { recursive: true });
  writeFileSync(join(ws, 'src', 'a.js'),
    'export function hello() { return 1; }\nexport class Box { open() { return hello(); } }\n');
  writeFileSync(join(ws, 'README.md'), '# fixture\n\nhello lives in src/a.js\n');

  // The server is constructed with a DiffEngine in main.js — the write tools
  // reach it through `this.diffEngine`, not through the per-call context.
  server = new MCPServer(ws, new DiffEngine(ws));
  taskManager = new TaskManager(ws);
  ctx = { workspace: ws, taskManager, editor: null };
});

after(() => {
  try { taskManager?.killAll?.(); } catch { /* best effort */ }
  rmSync(ws, { recursive: true, force: true });
});

/**
 * One call per tool, with arguments that should succeed.
 *
 * `null` means "no safe happy-path call from a test" — those are listed rather
 * than skipped silently, so the reason is visible and a new tool cannot be
 * quietly omitted (the membership assertion at the bottom enforces that).
 */
const HAPPY_PATH = {
  read_file: { path: 'src/a.js' },
  create_file: { path: 'made.txt', content: 'x' },
  edit_file: { path: 'src/a.js', edits: [{ oldText: 'return 1;', newText: 'return 2;' }] },
  list_directory: { path: '.' },
  search_files: { query: 'a.js' },
  grep_search: { pattern: 'hello' },
  find_symbol: { name: 'hello' },
  find_references: { name: 'hello' },
  run_command: { command: 'echo ok' },
  run_background: { command: 'sh -c "sleep 5"' },
  manage_task: { action: 'list' },
  recall_history: { query: 'hello' },
  get_editor_state: {},
  get_diagnostics: {},
};

describe('every registered tool runs', () => {
  test('none of them throws or reports failure', async () => {
    const broken = [];

    for (const def of server.getToolDefinitions()) {
      const args = HAPPY_PATH[def.name];
      if (args === null) continue;
      if (args === undefined) {
        broken.push(`${def.name}: registered but this test has no happy-path call for it`);
        continue;
      }
      try {
        const r = await server.executeTool(def.name, args, ctx);
        // `success: false` is how a handler reports a failure; a thrown error
        // is rewritten into the same shape by `executeTool`.
        if (r?.success === false) broken.push(`${def.name}: ${r.error}`);
      } catch (e) {
        broken.push(`${def.name}: threw ${e.message}`);
      }
    }

    assert.deepEqual(broken, [], `\n  ${broken.join('\n  ')}\n`);
  });

  /*
   * The membership check, so a tool added later cannot slip past by simply not
   * being in the map above. Without it this file silently stops covering new
   * tools, which is exactly how `find_symbol` came to have no test.
   */
  test('the map covers the whole registry', () => {
    const registered = server.getToolDefinitions().map((d) => d.name).sort();
    const covered = Object.keys(HAPPY_PATH).sort();

    assert.deepEqual(registered.filter((n) => !covered.includes(n)), [],
      'a tool is registered with no entry in HAPPY_PATH — add one, or null with a reason');
    assert.deepEqual(covered.filter((n) => !registered.includes(n)), [],
      'HAPPY_PATH names a tool that is not registered');
  });
});

/**
 * The specific regression, kept beside the general sweep.
 *
 * The sweep would catch it, but only as one line in a list. This says what
 * broke and what it returned, because the next person to see
 * `isMethod is not defined` should find the story rather than a diff.
 */
describe('find_symbol answers', () => {
  test('a function definition comes back', async () => {
    const r = await server.executeTool('find_symbol', { name: 'hello' }, ctx);

    assert.equal(r.success, true, `find_symbol is broken again: ${r.error}`);
    assert.equal(r.result.found, 1);
    assert.equal(r.result.definitions[0].kind, 'function');
  });

  test('a method definition comes back, and says it is one', async () => {
    const r = await server.executeTool('find_symbol', { name: 'open' }, ctx);

    assert.equal(r.success, true, `find_symbol is broken again: ${r.error}`);
    assert.equal(r.result.definitions[0].kind, 'method');
  });

  // `methodNote` belongs to `find_references`, which is the tool that includes
  // member uses. It leaked into this one and took the whole tool with it.
  test('it does not carry find_references own note', async () => {
    const r = await server.executeTool('find_symbol', { name: 'open' }, ctx);
    assert.equal(r.result.methodNote, undefined);
  });

  test('a name that is not there is reported, not failed', async () => {
    const r = await server.executeTool('find_symbol', { name: 'nothingCalledThis' }, ctx);

    assert.equal(r.success, true);
    assert.equal(r.result.found, 0);
    assert.match(r.result.message, /No definition/);
  });
});
