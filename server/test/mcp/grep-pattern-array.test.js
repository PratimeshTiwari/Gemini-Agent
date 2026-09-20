/**
 * The prompt told the model to pass an array and the validator refused it.
 *
 * `grep_search`'s own description says: "Pass SEVERAL patterns at once when you
 * are not sure what this codebase calls something — ['rate limit', 'throttle',
 * 'quota'] is one search, not three, and guessing wrong three times in a row
 * costs three round trips." The catalog repeats it: "pattern (string or array
 * of strings, required)". The handler has always accepted both.
 *
 * Only the declared type said `string`, so `validate-args` rejected every array
 * before the handler saw it. The model did exactly what it was instructed to do
 * and the call failed — four times in one afternoon of real use, on the second
 * most-used tool there is, logged as `grep_search:bad_args`.
 *
 * Told the truth, enforced the opposite: the same shape as plan mode and
 * markdown, and as `run_background` skipping approval.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MCPServer } from '../../src/mcp/mcp-server.js';

describe('grep_search takes one pattern or several', () => {
  let ws, server;
  before(() => {
    ws = mkdtempSync(join(tmpdir(), 'greppat-'));
    writeFileSync(join(ws, 'a.js'), 'rate limit here\n');
    writeFileSync(join(ws, 'b.js'), 'throttle here\n');
    writeFileSync(join(ws, 'c.js'), 'unrelated\n');
    server = new MCPServer(ws);
  });
  after(() => rmSync(ws, { recursive: true, force: true }));

  const run = (pattern) => server.executeTool('grep_search', { pattern }, {});

  test('an array searches for all of them at once', async () => {
    const r = await run(['rate limit', 'throttle']);
    assert.ok(!r.error, `rejected: ${r.error}`);
    assert.equal(r.result.matchCount, 2, 'the OR across terms is the whole feature');
  });

  test('a single string still works', async () => {
    const r = await run('throttle');
    assert.ok(!r.error, `rejected: ${r.error}`);
    assert.equal(r.result.matchCount, 1);
  });

  /*
   * The controls. Widening a type is how a validator stops validating — and a
   * tool whose arguments are never checked is the thing `validate-args` exists
   * to prevent, since a wrong-typed argument then fails deep inside a handler
   * with a message the model cannot act on.
   */
  test('a number is still refused', async () => {
    const r = await run(42);
    assert.match(String(r.error), /schema/);
  });

  test('an array of numbers is still refused', async () => {
    const r = await run([1, 2]);
    assert.match(String(r.error), /schema/);
  });

  test('a missing pattern is still refused', async () => {
    const r = await server.executeTool('grep_search', {}, {});
    assert.match(String(r.error), /schema/);
  });
});
