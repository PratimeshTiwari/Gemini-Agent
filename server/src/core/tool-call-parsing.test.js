import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop } from './agent-loop.js';

/**
 * `_extractToolCalls` is what stands in for a tool-call API here — the call is
 * parsed out of prose the model wrote. It is the most load-bearing text
 * processing in the project and had no tests, so these pin the behaviour that
 * exists rather than proposing a new one.
 */
const parser = () => Object.create(AgentLoop.prototype);
const parse = (text) => parser()._extractToolCalls(text);

const block = (body) => '```json\n' + body + '\n```';

test('the ordinary shapes a model emits', async (t) => {
  await t.test('a fenced json block becomes a call', () => {
    const { toolCalls } = parse(block('{"name": "read_file", "args": {"path": "a.js"}}'));
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].name, 'read_file');
    assert.deepEqual(toolCalls[0].args, { path: 'a.js' });
  });

  await t.test('the prose around it survives as the reply', () => {
    const { cleanContent } = parse(`Let me look.\n\n${block('{"name":"read_file","args":{"path":"a.js"}}')}\n\nThen I will edit it.`);
    assert.match(cleanContent, /Let me look/);
    assert.match(cleanContent, /Then I will edit it/);
    assert.doesNotMatch(cleanContent, /read_file/);
  });

  await t.test('an array in one block is several calls', () => {
    const { toolCalls } = parse(block('[{"name":"read_file","args":{"path":"a.js"}},{"name":"read_file","args":{"path":"b.js"}}]'));
    assert.deepEqual(toolCalls.map((c) => c.args.path), ['a.js', 'b.js']);
  });

  await t.test('several blocks are several calls', () => {
    const { toolCalls } = parse(
      `${block('{"name":"read_file","args":{"path":"a.js"}}')}\nand then\n${block('{"name":"grep_search","args":{"pattern":"x"}}')}`,
    );
    assert.deepEqual(toolCalls.map((c) => c.name), ['read_file', 'grep_search']);
  });

  await t.test('a fence with no language tag still parses', () => {
    const { toolCalls } = parse('```\n{"name":"read_file","args":{"path":"a.js"}}\n```');
    assert.equal(toolCalls.length, 1);
  });

  await t.test('args may be omitted entirely', () => {
    const { toolCalls } = parse(block('{"name":"get_editor_state"}'));
    assert.deepEqual(toolCalls[0].args, {});
  });
});

test('the shapes that are why there is a fallback parser', async (t) => {
  // Gemini drops the fence often enough that giving up on unfenced JSON would
  // lose whole turns.
  await t.test('a bare object with no fence is still found', () => {
    const { toolCalls } = parse('Sure.\n{"name": "read_file", "args": {"path": "a.js"}}\nDone.');
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].name, 'read_file');
  });

  await t.test('a raw newline inside a string does not break the parse', () => {
    const { toolCalls } = parse(block('{"name":"create_file","args":{"path":"a.md","content":"line one\nline two"}}'));
    assert.equal(toolCalls.length, 1);
    assert.match(toolCalls[0].args.content, /line one/);
  });

  await t.test('nested braces are matched, not counted naively', () => {
    const { toolCalls } = parse('{"name":"manage_task","args":{"action":"send_input","payload":{"a":{"b":1}}}}');
    assert.equal(toolCalls.length, 1);
    assert.deepEqual(toolCalls[0].args.payload, { a: { b: 1 } });
  });

  await t.test('a brace inside a string is not a brace', () => {
    const { toolCalls } = parse('{"name":"grep_search","args":{"pattern":"function () {"}}');
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].args.pattern, 'function () {');
  });
});

test('what must not be mistaken for a call', async (t) => {
  await t.test('prose with no JSON yields no calls and is returned whole', () => {
    const text = 'I read the file and it looks correct. Nothing to change.';
    const { toolCalls, cleanContent } = parse(text);
    assert.deepEqual(toolCalls, []);
    assert.equal(cleanContent, text);
  });

  // The model explaining a JSON config, or showing the user an example, is not
  // asking to run anything.
  await t.test('an object that is not a tool call is left alone', () => {
    const { toolCalls } = parse('Your config should be:\n```json\n{"compilerOptions": {"strict": true}}\n```');
    assert.deepEqual(toolCalls, []);
  });

  await t.test('an object with a name but no args is a call; one with neither is not', () => {
    assert.equal(parse('{"args":{"path":"a.js"}}').toolCalls.length, 0);
  });

  await t.test('empty and non-string input do not throw', () => {
    assert.deepEqual(parse('').toolCalls, []);
    assert.deepEqual(parse('   ').toolCalls, []);
  });
});

test('_cleanJsonString', async (t) => {
  await t.test('escapes newlines inside string literals', () => {
    const out = parser()._cleanJsonString('{"content":"a\nb"}');
    assert.doesNotMatch(out, /"a\nb"/);
    assert.deepEqual(JSON.parse(out), { content: 'a\nb' });
  });

  await t.test('leaves newlines between keys alone', () => {
    const out = parser()._cleanJsonString('{\n  "a": 1\n}');
    assert.deepEqual(JSON.parse(out), { a: 1 });
  });
});
