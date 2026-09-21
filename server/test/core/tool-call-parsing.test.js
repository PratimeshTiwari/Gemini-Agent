import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop } from '../../src/core/agent-loop.js';

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

  await t.test('an indented fence is still the clean path, not the fallback', () => {
    // A fence inside a list item is indented, and the model writes lists
    // unprompted. The fallback would find the JSON either way — the thing that
    // would break is the *reply*: the fallback removes only the object, so the
    // orphaned ``` fence is left on screen.
    const { toolCalls, cleanContent } = parse(
      '1. Run this:\n\n   ```json\n   {"name":"read_file","args":{"path":"a.js"}}\n   ```\n\n2. Then check it.',
    );
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].args.path, 'a.js');
    assert.doesNotMatch(cleanContent, /```/, `a bare fence was left in the reply:\n${cleanContent}`);
    assert.match(cleanContent, /Then check it/);
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

/**
 * Reported from use, 2026-09-20, with the reply preserved in
 * `.agent/logs/errors.jsonl` under `op: 'parse_tool_calls'`.
 *
 * Asked whether the system prompt should be re-sent in chunks, the model
 * answered the question — correctly — and illustrated its answer with a bare
 * fence. Gemini labels an untagged fence "Plaintext" in its own UI, so nothing
 * on screen suggested JSON; the parser matched it only because the body opens
 * with `[` and closes with `}`.
 *
 * The cost was not one bad block. The throw is inside the `replace` callback,
 * so the whole reply died with it, and the loop then sent "Please correct the
 * previous JSON formatting error." into the thread — about a tool call that was
 * never made. The model complied, invented one, and spent the turn
 * investigating a question it had already answered.
 */
test('prose is not a malformed tool call', async (t) => {
  const REPORTED = [
    'Improving the effort tiers by actively reminding the model of its instructions',
    'is a highly effective approach.',
    '',
    '- **Pro/High Effort:** The agent loop intercepts the prompt and wraps it:',
    '',
    '```',
    '[SYSTEM REMINDER: You are in PRO effort tier. You MUST plan first, investigate',
    'using read_file, and use <thought> before any action.]',
    '',
    'User Request: {user_input}',
    '```',
    '',
    'That is the cheapest version.',
  ].join('\n');

  await t.test('the reported reply parses to no calls and does not throw', () => {
    const { toolCalls } = parse(REPORTED);
    assert.deepEqual(toolCalls, []);
  });

  await t.test('and the answer survives intact, block included', () => {
    const { cleanContent } = parse(REPORTED);
    assert.match(cleanContent, /Improving the effort tiers/);
    assert.match(cleanContent, /That is the cheapest version/);
    assert.match(cleanContent, /SYSTEM REMINDER/,
      'the illustration was deleted out of the reply that was explaining it');
  });

  // The negative control. Without it this suite would pass against a parser
  // that had simply stopped throwing, which is a different and worse bug: a
  // genuinely mangled call would be silently swallowed as prose.
  await t.test('an untagged fence that names a tool is still repaired', () => {
    assert.throws(
      () => parse('```\n{"name": "read_file", "args": {"path": "a.js",}\n```'),
      /Failed to parse JSON block/,
    );
  });

  await t.test('a ```json fence still claims JSON, so a broken one is repaired', () => {
    assert.throws(
      () => parse('```json\n{not json at all}\n```'),
      /Failed to parse JSON block/,
    );
  });

  await t.test('other untagged prose shapes that open and close like JSON', () => {
    for (const body of [
      '[TODO] finish the parser {see above}',
      '{{ template }} renders to [value]',
      '[1] see footnote {2}',
    ]) {
      const text = '```\n' + body + '\n```';
      assert.deepEqual(parse(text).toolCalls, [], `parsed a call out of: ${body}`);
      assert.match(parse(text).cleanContent, /```/, `dropped the block: ${body}`);
    }
  });
});

test('a block that is not a call stays in the reply', async (t) => {
  // It was parsed, found to hold no `name`, and deleted anyway — so a model
  // answering "your config should be:" had the answer removed from its own
  // reply and the user read the sentence with nothing after it.
  await t.test('a json config the model is showing the user survives', () => {
    const text = 'Your config should be:\n```json\n{"compilerOptions": {"strict": true}}\n```';
    const { toolCalls, cleanContent } = parse(text);
    assert.deepEqual(toolCalls, []);
    assert.match(cleanContent, /compilerOptions/);
  });

  await t.test('but a block that did become a call is still removed', () => {
    const { toolCalls, cleanContent } = parse(
      'Reading it.\n' + block('{"name":"read_file","args":{"path":"a.js"}}'),
    );
    assert.equal(toolCalls.length, 1);
    assert.doesNotMatch(cleanContent, /read_file/);
    assert.doesNotMatch(cleanContent, /```/);
  });
});
