/**
 * The batch turn loop, testable for the first time.
 *
 * It was `AgentLoop.runHeadlessTask` — a second agent loop inside the first,
 * ten turns with its own dispatch and its own retry, reachable only through a
 * browser tab. GITHUB-AGENT-PLAN phase 6 pulled it out; these are what the
 * extraction was for.
 *
 * Everything that touches the outside is injected, so a full multi-turn task
 * with tool calls, provider errors and a parse failure runs here in
 * milliseconds with no browser and no network.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { runBatchTask, MAX_BATCH_TURNS } from '../../src/core/turn-runner.js';

/** A runner whose model replies from a script. */
function scripted(replies, over = {}) {
  const prompts = [];
  const toolCalls = [];
  let i = 0;
  return {
    prompts,
    toolCalls,
    run: () => runBatchTask({
      system: 'SYSTEM',
      user: 'do the thing',
      send: async (prompt) => {
        prompts.push(prompt);
        const next = replies[i];
        i += 1;
        return next === undefined ? { success: true, result: 'done' } : next;
      },
      extractToolCalls: (content) => {
        const calls = [...content.matchAll(/<call>(\w+)<\/call>/g)]
          .map((m, n) => ({ id: `c${n}`, name: m[1], args: { path: 'x' } }));
        return { toolCalls: calls, cleanContent: content.replace(/<call>\w+<\/call>/g, '').trim() };
      },
      executeTool: async (name, args) => { toolCalls.push({ name, args }); return { ok: true }; },
      ...over,
    }),
  };
}

const reply = (text) => ({ success: true, result: text });

describe('a task runs to its answer', () => {
  test('one turn with no tool calls is the answer', async () => {
    const s = scripted([reply('Here is the plan.')]);
    const out = await s.run();
    assert.equal(out.success, true);
    assert.equal(out.result, 'Here is the plan.');
    assert.equal(out.turns, 1);
  });

  test('tool calls are executed and fed back', async () => {
    const s = scripted([reply('looking <call>read_file</call>'), reply('Here is the plan.')]);
    const out = await s.run();
    assert.equal(out.result, 'Here is the plan.');
    assert.deepEqual(s.toolCalls.map((c) => c.name), ['read_file']);
    assert.match(s.prompts[1], /"name": "read_file"/, 'the result never reached the next turn');
  });

  test('parallel calls in one turn all run', async () => {
    const s = scripted([reply('<call>read_file</call><call>grep_search</call>'), reply('done')]);
    await s.run();
    assert.deepEqual(s.toolCalls.map((c) => c.name), ['read_file', 'grep_search']);
  });

  test('only what is new goes out after the first turn', async () => {
    // The tab is held for the life of the task, so turn 2 is the same
    // conversation and does not need the system prompt again. Measured before
    // this: 156,140 characters sent where 28,943 were new — 81% resent, growing
    // every turn, which is the shape that trips Gemini's repetition filters.
    const s = scripted([reply('<call>read_file</call>'), reply('done')]);
    await s.run();
    assert.match(s.prompts[0], /SYSTEM/, 'turn 1 must carry everything');
    assert.ok(!s.prompts[1].includes('SYSTEM'), 'the system prompt was sent twice');
    assert.ok(!s.prompts[1].includes('do the thing'), 'the request was sent twice');
    assert.match(s.prompts[1], /"name": "read_file"/, 'the tool result never arrived');
  });

  test('the saving is the point, so measure it at a real size', async () => {
    // At toy sizes a tool result is bigger than a seven-word system prompt and
    // the comparison says nothing. The headless system prompt is ~1.6 KB.
    const prompts = [];
    let n = 0;
    await runBatchTask({
      system: 'SYSTEM PROMPT '.repeat(120),
      user: 'Analyse this review comment. '.repeat(20),
      send: async (prompt) => {
        prompts.push(prompt);
        n += 1;
        return n < 4 ? reply('<call>read_file</call>') : reply('the plan');
      },
      extractToolCalls: (c) => ({
        toolCalls: c.includes('<call>') ? [{ id: 'a', name: 'read_file', args: {} }] : [],
        cleanContent: c.replace(/<call>\w+<\/call>/g, '').trim(),
      }),
      executeTool: async () => ({ ok: true }),
    });

    const total = prompts.reduce((a, p) => a + p.length, 0);
    // Flat re-serialisation would have resent the whole thread every turn.
    assert.ok(total < prompts[0].length * prompts.length,
      `sent ${total} chars over ${prompts.length} turns — no better than flat`);
    for (const p of prompts.slice(1)) {
      assert.ok(!p.includes('SYSTEM PROMPT'), 'a later turn resent the system prompt');
    }
  });

  test('send is told whether it is continuing, so a flat transport still works', async () => {
    const flags = [];
    await runBatchTask({
      system: 's', user: 'u',
      send: async (prompt, opts) => {
        flags.push(opts?.continuing);
        return flags.length === 1 ? reply('<call>x</call>') : reply('done');
      },
      extractToolCalls: (c) => ({
        toolCalls: c.includes('<call>') ? [{ name: 'x', args: {} }] : [],
        cleanContent: c.replace(/<call>\w+<\/call>/g, '').trim(),
      }),
      executeTool: async () => ({}),
    });
    assert.deepEqual(flags, [false, true]);
  });

  test('a lost tab is recovered by saying it all again, once', async () => {
    // The extension refuses an incremental prompt when the session's tab is
    // gone, rather than opening a fresh one — that would get a confident answer
    // to a question the model never saw.
    const prompts = [];
    let n = 0;
    const out = await runBatchTask({
      system: 'SYSTEM', user: 'do the thing',
      send: async (prompt, { continuing }) => {
        prompts.push({ prompt, continuing });
        n += 1;
        if (n === 1) return reply('<call>read_file</call>');
        if (n === 2) return { sessionLost: true };     // the tab was closed
        return reply('the plan');
      },
      extractToolCalls: (c) => ({
        toolCalls: c.includes('<call>') ? [{ id: 'a', name: 'read_file', args: {} }] : [],
        cleanContent: c.replace(/<call>\w+<\/call>/g, '').trim(),
      }),
      executeTool: async () => ({ ok: true }),
    });
    assert.equal(out.success, true);
    assert.equal(out.result, 'the plan');
    assert.equal(prompts.length, 3);
    assert.equal(prompts[2].continuing, false, 'it retried incrementally into an empty tab');
    assert.match(prompts[2].prompt, /SYSTEM/, 'the re-send did not carry the system prompt');
    assert.match(prompts[2].prompt, /do the thing/);
    assert.match(prompts[2].prompt, /read_file/, 'the tool result was dropped on the way');
  });
});

describe('the budget', () => {
  test('a model that never stops calling tools is stopped', async () => {
    const s = scripted(Array.from({ length: 50 }, () => reply('<call>read_file</call>')));
    const out = await s.run();
    assert.equal(out.turns, MAX_BATCH_TURNS);
    assert.equal(out.success, true, 'it should return what it has, not fail');
  });

  test('the budget is configurable', async () => {
    const out = await runBatchTask({
      system: 's', user: 'u', maxTurns: 2,
      send: async () => reply('<call>x</call>'),
      extractToolCalls: () => ({ toolCalls: [{ name: 'x', args: {} }], cleanContent: 'thinking' }),
      executeTool: async () => ({}),
    });
    assert.equal(out.turns, 2);
  });
});

describe('a provider error is not an answer', () => {
  const PROVIDER_ERROR = 'Something went wrong. Please try again later.';

  test('it is retried rather than written down as the plan', async () => {
    // Gemini's own failure arrives through the same path as a real reply — no
    // tool calls and some prose — and used to become the PR plan on disk.
    const s = scripted([reply(PROVIDER_ERROR), reply('The actual plan.')]);
    const out = await s.run();
    assert.equal(out.result, 'The actual plan.');
  });

  test('a model that only ever errors fails the task', async () => {
    const s = scripted(Array.from({ length: 10 }, () => reply(PROVIDER_ERROR)));
    const out = await s.run();
    assert.equal(out.success, false);
    assert.match(out.error, /kept returning an error/);
  });

  test('the retry tells the model what happened', async () => {
    const s = scripted([reply(PROVIDER_ERROR), reply('ok')]);
    await s.run();
    assert.match(s.prompts[1], /provider error, not an answer/);
  });
});

describe('a bad tool call is repaired, not fatal', () => {
  test('a parse failure asks for the format again', async () => {
    let calls = 0;
    const out = await runBatchTask({
      system: 's', user: 'u',
      send: async () => reply('garbage'),
      extractToolCalls: () => {
        calls += 1;
        if (calls === 1) throw new Error('Unexpected token');
        return { toolCalls: [], cleanContent: 'recovered' };
      },
      executeTool: async () => ({}),
    });
    assert.equal(out.result, 'recovered');
    assert.equal(out.turns, 2);
  });

  test('a tool that throws becomes a result, not a crash', async () => {
    const s = scripted([reply('<call>read_file</call>'), reply('done')], {
      executeTool: async () => { throw new Error('ENOENT'); },
    });
    const out = await s.run();
    assert.equal(out.success, true);
    assert.match(s.prompts[1], /ENOENT/, 'the model was never told why it failed');
  });
});

describe('a batch turn has nobody to approve anything', () => {
  test('an unsafe command is refused rather than queued', async () => {
    // There is no approval prompt on this path, so anything not safe would
    // wait for a decision that never comes.
    const s = scripted([reply('<call>run_command</call>'), reply('done')], {
      classifyRisk: () => ({ level: 'critical', reason: 'rm -rf' }),
    });
    await s.run();
    assert.equal(s.toolCalls.length, 0, 'a critical command was executed in the background');
    assert.match(s.prompts[1], /blocked in background agent/);
  });

  test('a safe command runs', async () => {
    const s = scripted([reply('<call>run_command</call>'), reply('done')], {
      classifyRisk: () => ({ level: 'safe', reason: '' }),
    });
    await s.run();
    assert.deepEqual(s.toolCalls.map((c) => c.name), ['run_command']);
  });

  test('with no classifier, nothing is blocked', async () => {
    const s = scripted([reply('<call>run_command</call>'), reply('done')]);
    await s.run();
    assert.equal(s.toolCalls.length, 1);
  });
});

describe('delegation', () => {
  test('ask_subagent goes to the subagent runner, not the tool server', async () => {
    const seen = [];
    const s = scripted([reply('<call>ask_subagent</call>'), reply('done')], {
      extractToolCalls: (c) => ({
        toolCalls: c.includes('ask_subagent') ? [{ name: 'ask_subagent', args: { prompt: 'find it' } }] : [],
        cleanContent: c.replace(/<call>\w+<\/call>/g, '').trim(),
      }),
      runSubagent: async (p) => { seen.push(p); return { success: true, result: 'found' }; },
    });
    await s.run();
    assert.deepEqual(seen, ['find it']);
    assert.equal(s.toolCalls.length, 0, 'it went to executeTool instead');
  });
});

describe('failure to reach the model at all', () => {
  test('a failed send ends the task with its error', async () => {
    const out = await runBatchTask({
      system: 's', user: 'u',
      send: async () => ({ success: false, error: 'tab timed out' }),
      extractToolCalls: () => ({ toolCalls: [], cleanContent: '' }),
      executeTool: async () => ({}),
    });
    assert.equal(out.success, false);
    assert.equal(out.error, 'tab timed out');
  });

  test('a model that says nothing at all still returns something', async () => {
    const out = await runBatchTask({
      system: 's', user: 'u',
      send: async () => reply('   '),
      extractToolCalls: () => ({ toolCalls: [], cleanContent: '' }),
      executeTool: async () => ({}),
    });
    assert.equal(out.result, '(No plan generated)');
  });
});
