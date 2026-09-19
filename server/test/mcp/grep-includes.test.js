/**
 * `includes` silently matched nothing whenever it named a path.
 *
 * The fallback tested the **basename** against the raw glob:
 *
 *     const ext = glob.replace('*', '');
 *     return entry.name.endsWith(ext);
 *
 * `*.js` worked by accident — `".js"` is a suffix — and anything containing a
 * directory could never match. `includes: ["server/src/core/prompt-builder.js"]`
 * compared `"prompt-builder.js".endsWith("server/src/core/prompt-builder.js")`
 * and got false, every time.
 *
 * So a grep narrowed to one file returned **0 matches**, which to the model
 * reading it is indistinguishable from "that code is not there". In the session
 * that prompted this audit every `grep_search` carrying an `includes` path came
 * back empty — `"export "` in a file with dozens of exports — and the model
 * concluded the file was unreadable, answered from guesswork, and then wrote a
 * post-mortem blaming its own discipline.
 *
 * It only ever ran because it is the *fallback*. `spawn('rg')` fails with
 * ENOENT wherever ripgrep is not a real binary on PATH — including where it is
 * a shell function, which `command -v rg` reports as present — and the catch
 * was bare, so nothing said which half was answering.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MCPServer } from '../../src/mcp/mcp-server.js';

describe('grep_search include filters', () => {
  let ws, server;
  before(() => {
    ws = mkdtempSync(join(tmpdir(), 'grepinc-'));
    mkdirSync(join(ws, 'src', 'core'), { recursive: true });
    mkdirSync(join(ws, 'test'), { recursive: true });
    writeFileSync(join(ws, 'src', 'core', 'alpha.js'), 'export const NEEDLE = 1;\n');
    writeFileSync(join(ws, 'src', 'core', 'beta.js'), 'const NEEDLE = 2;\n');
    writeFileSync(join(ws, 'test', 'alpha.test.js'), 'it("NEEDLE", () => {});\n');
    writeFileSync(join(ws, 'README.md'), 'NEEDLE in prose\n');
    server = new MCPServer(ws);
  });
  after(() => rmSync(ws, { recursive: true, force: true }));

  const hits = async (includes) => {
    const r = await server.executeTool('grep_search', { pattern: 'NEEDLE', ...(includes ? { includes } : {}) }, {});
    return r.result?.matchCount ?? -1;
  };

  // The reported bug: narrowing to one file found nothing.
  test('an exact file path finds the file', async () => {
    assert.equal(await hits(['src/core/alpha.js']), 1);
  });

  test('a directory glob finds what is in it', async () => {
    assert.equal(await hits(['src/core/*.js']), 2);
  });

  test('a ** glob crosses directories', async () => {
    assert.equal(await hits(['src/**/*.js']), 2);
  });

  test('a bare extension glob still means anywhere', async () => {
    assert.equal(await hits(['*.js']), 3, 'the one case the old matcher got right by accident');
  });

  test('a bare basename means anywhere too', async () => {
    assert.equal(await hits(['alpha.js']), 1);
  });

  test('a suffix pattern matches across directories', async () => {
    assert.equal(await hits(['*.test.js']), 1);
  });

  /*
   * The controls. Without these, a matcher that simply returns true for
   * everything passes every test above — which is the opposite bug and just as
   * silent: the model would be handed matches from files it excluded.
   */
  test('a path that exists but does not match is excluded', async () => {
    assert.equal(await hits(['src/core/beta.js']), 1, 'it matched more than the one file asked for');
  });

  test('a path that matches nothing returns nothing', async () => {
    assert.equal(await hits(['nowhere/absent.js']), 0);
  });

  test('an extension filter excludes other extensions', async () => {
    assert.equal(await hits(['*.md']), 1, 'markdown filter picked up javascript');
  });

  test('no filter searches everything', async () => {
    assert.equal(await hits(null), 4);
  });
});
