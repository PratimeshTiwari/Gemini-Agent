/**
 * transcript — Unit Tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { groupTurns, parseTurnActions } from '../../src/ui/transcript.js';

describe('groupTurns', () => {
  it('starts a turn at each user message and attaches what follows', () => {
    const turns = groupTurns([
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'two' },
    ]);

    assert.strictEqual(turns.length, 2);
    assert.strictEqual(turns[0].userMsg.content, 'one');
    assert.strictEqual(turns[0].steps.length, 1);
    assert.strictEqual(turns[1].steps.length, 0);
  });

  it('opens a turn with no user message when history starts mid-stream', () => {
    const turns = groupTurns([{ role: 'assistant', content: 'resumed' }]);
    assert.strictEqual(turns.length, 1);
    assert.strictEqual(turns[0].userMsg, null);
  });

  it('tags each message with its index in the flat history', () => {
    const history = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }];
    groupTurns(history);
    assert.deepStrictEqual(history.map(m => m._globalIdx), [0, 1]);
  });
});

describe('parseTurnActions', () => {
  it('pairs a tool_result with the tool_call before it', () => {
    const { actions } = parseTurnActions({
      id: 1,
      steps: [
        { type: 'tool_call', toolName: 'read_file', args: { path: 'a' } },
        { type: 'tool_result', result: { totalLines: 3 }, success: true },
      ],
    });

    assert.strictEqual(actions.length, 1);
    assert.strictEqual(actions[0].type, 'tool');
    assert.strictEqual(actions[0].toolName, 'read_file');
    assert.strictEqual(actions[0].success, true);
  });

  it('keeps an orphan tool_result as its own row', () => {
    const { actions } = parseTurnActions({ id: 1, steps: [{ type: 'tool_result', result: 'x' }] });
    assert.strictEqual(actions[0].type, 'tool_result');
  });

  it('splits thinking out of the reply and keeps the prose', () => {
    const { actions, finalMessages } = parseTurnActions({
      id: 1,
      steps: [{ role: 'assistant', content: '<think>reasoning</think>the answer' }],
    });

    assert.strictEqual(actions[0].type, 'think');
    assert.strictEqual(actions[0].content, 'reasoning');
    assert.strictEqual(finalMessages[0].content, 'the answer');
  });

  it('lifts an attached image out of the message body', () => {
    const { actions, finalMessages } = parseTurnActions({
      id: 1,
      steps: [{ role: 'assistant', content: '🖼️ Image attached: /tmp/shot.png\nlook at this' }],
    });

    assert.strictEqual(actions[0].type, 'image');
    assert.strictEqual(actions[0].content, '/tmp/shot.png');
    assert.strictEqual(finalMessages[0].content, 'look at this');
  });

  it('separates command output from other system messages', () => {
    const { actions } = parseTurnActions({
      id: 1,
      steps: [
        { role: 'system', type: 'command_output', content: '$ ls' },
        { role: 'system', content: 'note' },
      ],
    });

    assert.deepStrictEqual(actions.map(a => a.type), ['command_output', 'system']);
  });
});

describe('parseTurnActions — image attachments', () => {
  const turnWith = (content) => ({ id: 0, userMsg: null, steps: [{ role: 'assistant', content }] });

  it('the size suffix /image writes is consumed, not left in the prose', () => {
    const { actions, finalMessages } = parseTurnActions(
      turnWith('🖼️ Image attached: /tmp/shot.png (128KB)\nType your prompt and the image will be included.'),
    );
    assert.strictEqual(actions[0].type, 'image');
    assert.strictEqual(actions[0].content, '/tmp/shot.png');
    assert.doesNotMatch(finalMessages[0].content, /128KB/);
    assert.doesNotMatch(finalMessages[0].content, /^\s*\(/);
  });

  it('every supported extension is recognised, with or without a size', () => {
    for (const name of ['a.png', 'b.jpg', 'c.jpeg', 'd.webp']) {
      for (const suffix of ['', ' (4KB)', '(1024 KB)']) {
        const { actions } = parseTurnActions(turnWith(`🖼️ Image attached: /tmp/${name}${suffix}\nrest`));
        assert.strictEqual(actions[0]?.content, `/tmp/${name}`, `${name}${suffix}`);
      }
    }
  });

  it('an image and a think block in one message get distinct ids', () => {
    const { actions } = parseTurnActions(
      turnWith('<think>hmm</think>🖼️ Image attached: /tmp/a.png (2KB)\nrest'),
    );
    const ids = actions.map((a) => a.id);
    assert.strictEqual(new Set(ids).size, ids.length, `duplicate ids: ${ids.join(', ')}`);
  });
});

describe('parseTurnActions — the model\'s reasoning', () => {
  const parse = (content) => parseTurnActions({ id: 1, steps: [{ role: 'assistant', content }] });

  // Every tier's prompt asks for `<thought>`; this used to match `<think>`, a
  // tag nothing asks for. So reasoning was never recognised as reasoning and
  // went into the transcript as raw XML.
  it('recognises the tag the prompt actually asks for', () => {
    const { actions, finalMessages } = parse('<thought>weighing it up</thought>\nHere is the answer.');
    assert.deepStrictEqual(actions.map((a) => a.type), ['think']);
    assert.strictEqual(actions[0].content, 'weighing it up');
    assert.strictEqual(finalMessages[0].content, 'Here is the answer.');
  });

  it('still recognises the older spelling', () => {
    const { actions } = parse('<think>older</think>\nanswer');
    assert.strictEqual(actions[0].content, 'older');
  });

  // A pro turn routinely emits several. A non-global replace left every block
  // after the first sitting in the prose.
  it('takes all of them, not just the first', () => {
    const { actions, finalMessages } = parse(
      '<thought>one</thought>\nfirst\n<thought>two</thought>\nsecond',
    );
    assert.deepStrictEqual(actions.map((a) => a.content), ['one', 'two']);
    assert.ok(!finalMessages[0].content.includes('<thought>'));
  });

  it('gives each one its own row id', () => {
    const { actions } = parse('<thought>a</thought>x<thought>b</thought>');
    assert.strictEqual(new Set(actions.map((a) => a.id)).size, 2);
  });

  // A reply cut off mid-thought would otherwise leave a bare opening tag and
  // everything after it in the transcript.
  it('an unclosed block does not leak the tag into the prose', () => {
    const { finalMessages } = parse('Here goes.\n<thought>I was interrupted');
    assert.strictEqual(finalMessages[0].content, 'Here goes.');
  });

  it('a reply with no reasoning is untouched', () => {
    const { actions, finalMessages } = parse('Just the answer.');
    assert.deepStrictEqual(actions, []);
    assert.strictEqual(finalMessages[0].content, 'Just the answer.');
  });
});
