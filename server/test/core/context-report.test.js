/**
 * `/context` reports what is in the window — both halves.
 *
 * It reported how *much* (turns, tokens, diffs) and never *what*. The Context
 * tab got the source rows first; the command that shares its name did not, so
 * one surface could tell you your `AGENT.md` was the unedited template and the
 * other could not. Same rows, same function, two surfaces.
 *
 * The width rules are the part worth testing. A label here is a path, and one
 * long path setting the padding for every row is the fault `describeSettings`
 * already had — a row that outgrows the viewport.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { AgentLoop } from '../../src/core/agent-loop.js';

/** The report, without constructing a whole agent. */
function report(agentMdFiles) {
  const fake = {
    workspace: '/w', mode: 'auto', contextTokens: 0, contextLimit: 1000,
    conversationHistory: [], diffEngine: { getPendingDiffs: () => [], appliedDiffs: [] },
    promptBuilder: { lastAgentMdFiles: agentMdFiles },
  };
  return AgentLoop.prototype._getContextInfo.call(fake);
}

const LONG = '/private/tmp/claude-501/-Users-someone-Documents-A-Project/02d53908-08c4/scratchpad/harness/wsf/AGENT.md';

describe('the report says what is feeding the prompt', () => {
  test('sources appear alongside the sizes', async () => {
    const { message } = await report([{ path: '/w/AGENT.md', bytes: 3943, state: 'loaded' }]);
    assert.match(message, /Tokens/);
    assert.match(message, /Feeding the prompt/);
    assert.match(message, /AGENT\.md/);
  });

  test('a template is called a template, which is the finding that started this', async () => {
    const { message } = await report([{ path: '/w/AGENT.md', bytes: 740, state: 'template' }]);
    assert.match(message, /template/);
  });

  test('before the first prompt it says so rather than guessing', async () => {
    const { message } = await report(undefined);
    assert.match(message, /pending|first prompt/i);
  });
});

describe('no row outgrows the viewport', () => {
  test('one long path does not set the padding for every row', async () => {
    const { message } = await report([
      { path: LONG, bytes: 12, state: 'loaded' },
      { path: '/a/AGENT.md', bytes: 0, state: 'template' },
    ]);
    for (const line of message.split('\n')) {
      assert.ok(line.length <= 96, `a ${line.length}-char line wraps: ${line.slice(0, 60)}…`);
    }
  });

  test('a long label is elided from the left, where the path is least useful', async () => {
    const { message } = await report([{ path: LONG, bytes: 12, state: 'loaded' }]);
    assert.match(message, /….*AGENT\.md/, 'the file name was the half thrown away');
  });

  test('the detail truncates before the label does', async () => {
    // You can lose the end of "it is being sent as your project context" and
    // still know the file is a template; a truncated path names no file at all.
    const { message } = await report([{ path: '/a/AGENT.md', bytes: 0, state: 'template' }]);
    const row = message.split('\n').find((l) => l.includes('/a/AGENT.md'));
    assert.ok(row.includes('/a/AGENT.md'), 'the label was cut');
    assert.match(row, /template/);
  });
});
