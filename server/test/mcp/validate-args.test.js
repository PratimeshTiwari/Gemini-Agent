import test from 'node:test';
import assert from 'node:assert/strict';
import { validateArgs, schemaFor } from '../../src/mcp/validate-args.js';
import { MCPServer } from '../../src/mcp/mcp-server.js';

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
