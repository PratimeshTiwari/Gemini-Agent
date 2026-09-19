import test from 'node:test';
import assert from 'node:assert/strict';
import { validateArgs, schemaFor } from '../../src/mcp/validate-args.js';
import { MCPServer } from '../../src/mcp/mcp-server.js';
import { readErrors } from '../../src/core/error-log.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SPEC = {
  path: { type: 'string', required: true },
  startLine: { type: 'number', required: false },
  isRegex: { type: 'boolean', required: false },
  includes: { type: 'array', required: false },
};

const check = (args, spec = SPEC) => validateArgs('read_file', spec, args);

test('what the model meant is accepted', async (t) => {
  await t.test('a correct call passes through unchanged', () => {
    const r = check({ path: 'a.js', startLine: 10 });
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, { path: 'a.js', startLine: 10 });
  });

  // Models emit "10" for a number often enough that failing on it throws away a
  // turn that would have worked. Each of these is a browser round-trip saved.
  await t.test('a number written as a string is coerced', () => {
    const r = check({ path: 'a.js', startLine: '10' });
    assert.equal(r.ok, true);
    assert.equal(r.value.startLine, 10);
  });

  // `Boolean("false")` is `true`, so coercing booleans the way numbers are
  // coerced would silently invert exactly the flags that matter — `isRegex`,
  // `recursive`. The words are handled explicitly instead.
  await t.test('boolean words are read, not truthiness-tested', () => {
    assert.equal(check({ path: 'a.js', isRegex: 'false' }).value.isRegex, false);
    assert.equal(check({ path: 'a.js', isRegex: 'true' }).value.isRegex, true);
    assert.equal(check({ path: 'a.js', isRegex: 'no' }).value.isRegex, false);
    assert.equal(check({ path: 'a.js', isRegex: false }).value.isRegex, false);
  });

  await t.test('one value where a list was asked for becomes a list', () => {
    assert.deepEqual(check({ path: 'a.js', includes: '*.js' }).value.includes, ['*.js']);
  });

  await t.test('an unknown argument is noise, not an error', () => {
    const r = check({ path: 'a.js', somethingElse: 1 });
    assert.equal(r.ok, true);
    assert.equal(r.value.somethingElse, 1);
  });

  await t.test('an optional parameter may simply be absent', () => {
    assert.equal(check({ path: 'a.js' }).ok, true);
  });
});

test('what the model got wrong is refused, readably', async (t) => {
  await t.test('a missing required parameter is named', () => {
    const r = check({ startLine: 5 });
    assert.equal(r.ok, false);
    assert.match(r.message, /`path` \(string, required\) is required but was not given/);
  });

  await t.test('a wrong type shows what actually arrived', () => {
    const r = check({ path: 123 });
    assert.equal(r.ok, false);
    assert.match(r.message, /`path`.*got 123/);
  });

  await t.test('a number that is not a number is still a failure', () => {
    assert.equal(check({ path: 'a.js', startLine: 'abc' }).ok, false);
  });

  // The model cannot see the schema again until the next refresh turn, and half
  // of these failures are a guessed parameter name.
  await t.test('the message lists the parameters that do exist', () => {
    const r = check({ filename: 'a.js' });
    assert.match(r.message, /Parameters: .*`path` \(string, required\)/);
    assert.match(r.message, /You sent: filename/);
  });

  await t.test('it tells the model what to do next, not how sorry to be', () => {
    assert.match(check({}).message, /Fix the arguments and call it again/);
  });

  await t.test('no arguments at all is the missing-required case, not a crash', () => {
    for (const args of [null, undefined, 'a string', ['an', 'array'], 42]) {
      const r = check(args);
      assert.equal(r.ok, false, JSON.stringify(args));
      assert.match(r.message, /`path`/);
    }
  });

  await t.test('a tool with no parameters accepts anything', () => {
    assert.equal(validateArgs('get_editor_state', {}, {}).ok, true);
    assert.equal(validateArgs('get_editor_state', undefined, { x: 1 }).ok, true);
  });
});

test('schemaFor mirrors the declaration', async (t) => {
  await t.test('required and optional are distinguished', () => {
    const schema = schemaFor(SPEC);
    assert.equal(schema.safeParse({ path: 'a' }).success, true);
    assert.equal(schema.safeParse({}).success, false);
  });
});

test('executeTool refuses a bad call before the handler sees it', async (t) => {
  const server = new MCPServer('/tmp', null);

  await t.test('the schema error comes back instead of a handler crash', async () => {
    const r = await server.executeTool('read_file', {}, {});
    assert.equal(r.success, false);
    assert.match(r.error, /do not match its schema/);
    assert.match(r.error, /`path`/);
  });

  // The handler must receive the coerced value, not the original string —
  // validating and then passing the raw args through would be worse than not
  // validating, because it would look like it worked.
  await t.test('the handler receives the coerced arguments', async () => {
    const seen = [];
    const original = server.tools.get('grep_search');
    server.tools.set('grep_search', { ...original, handler: async (args) => { seen.push(args); return 'ok'; } });

    await server.executeTool('grep_search', { pattern: 'x', maxResults: '5' }, {});
    assert.equal(seen[0].maxResults, 5);
    server.tools.set('grep_search', original);
  });

  await t.test('an unknown tool still says which ones exist', async () => {
    const r = await server.executeTool('nope', {}, {});
    assert.match(r.error, /Unknown tool: nope/);
    assert.match(r.error, /grep_search/);
  });
});

/*
 * What the *log* gets, which is not what the model gets.
 *
 * `logError` keeps only the first line of `message`, and `/logs` truncates
 * `detail` the same way — so the per-field diagnosis has to be on line one or
 * it reaches no reader at all. It was not: the call site logged
 * `checked.message.split('\n')[0]`, the generic headline, and six
 * `grep_search:bad_args` records piled up in this repo's own log without one
 * of them naming an argument. The cause had to be recovered from commit
 * timestamps.
 *
 * Every assertion below is written so that restoring that line fails it.
 */
test('a bad call is logged with the diagnosis, not the headline', async (t) => {
  const HEADLINE = /do not match its schema/;

  await t.test('validateArgs hands back the problems as a list', () => {
    const r = check({});
    assert.equal(r.ok, false);
    assert.deepEqual(r.problems, ['`path` (string, required) is required but was not given']);
    // The prose still contains it; the list is the half a logger can use.
    assert.match(r.message, /is required but was not given/);
  });

  await t.test('one problem per failing parameter, not one per call', () => {
    const r = check({ startLine: 'abc' });
    assert.equal(r.problems.length, 2);
    assert.ok(r.problems.some((p) => p.startsWith('`path`')), r.problems.join(' | '));
    assert.ok(r.problems.some((p) => p.startsWith('`startLine`')), r.problems.join(' | '));
  });

  await t.test('the record names the argument that was wrong', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'badargs-'));
    try {
      const server = new MCPServer(ws, null);
      const r = await server.executeTool('read_file', {}, {});
      assert.equal(r.success, false);

      const [record] = readErrors(ws, { flow: 'tool' });
      assert.equal(record.op, 'read_file:bad_args');
      assert.match(record.message, /`path`.*is required but was not given/);
      // The negative control: this is exactly what used to be written.
      assert.doesNotMatch(record.message, HEADLINE);
      // The model's own error is unchanged — it still gets the full contract.
      assert.match(r.error, HEADLINE);
      assert.match(r.error, /Parameters: /);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  await t.test('several problems reach the log on one line', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'badargs-'));
    try {
      const server = new MCPServer(ws, null);
      await server.executeTool('read_file', { startLine: 'abc' }, {});

      const [record] = readErrors(ws, { flow: 'tool' });
      assert.doesNotMatch(record.message, /\n/);
      assert.match(record.message, /`path`.*;.*`startLine`|`startLine`.*;.*`path`/);
      assert.deepEqual(record.meta.args, ['startLine']);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  /*
   * `logError` keys its 60s collapse window on the message, so while every
   * failure shared the headline two unrelated mistakes counted as one failure
   * repeated — the log actively merged the evidence it was keeping.
   */
  await t.test('two different mistakes are two records, not one repeated', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'badargs-'));
    try {
      const server = new MCPServer(ws, null);
      await server.executeTool('read_file', {}, {});
      await server.executeTool('read_file', { path: 'a.js', startLine: 'abc' }, {});

      const records = readErrors(ws, { flow: 'tool' });
      assert.equal(records.length, 2);
      assert.notEqual(records[0].message, records[1].message);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
