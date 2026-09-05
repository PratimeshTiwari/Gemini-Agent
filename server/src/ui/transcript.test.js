/**
 * transcript — Unit Tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { groupTurns, collectFocusableItems, parseTurnActions } from './transcript.js';

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

describe('collectFocusableItems', () => {
  it('offers a turn only when it has actions to expand', () => {
    const withTool = { id: 1, steps: [{ type: 'tool_call', toolName: 'read_file' }] };
    const proseOnly = { id: 2, steps: [{ role: 'assistant', content: 'just text' }] };

    const items = collectFocusableItems([withTool, proseOnly], []);
    assert.deepStrictEqual(items.map(i => i.id), ['turn_1']);
  });

  it('counts a thinking block as an action', () => {
    const turn = { id: 3, steps: [{ role: 'assistant', content: '<think>hmm</think>' }] };
    assert.strictEqual(collectFocusableItems([turn], []).length, 1);
  });

  it('appends in-flight tool calls after the turns', () => {
    const turn = { id: 1, steps: [{ type: 'tool_call' }] };
    const items = collectFocusableItems([turn], [{ id: 'call-1' }]);
    assert.deepStrictEqual(items.map(i => i.type), ['turn_actions', 'activeCall']);
    assert.strictEqual(items[1].sourceIdx, 0);
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
