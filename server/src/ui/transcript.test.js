/**
 * transcript — Unit Tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { groupTurns, parseTurnActions } from './transcript.js';

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
