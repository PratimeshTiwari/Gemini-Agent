import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PromptBuilder } from './prompt-builder.js';

// A workspace with no AGENT.md, no rules and no context folders, so the sizes
// below measure the prompt itself rather than whatever repo the tests run in.
let ws;
before(() => { ws = mkdtempSync(join(tmpdir(), 'pb-')); });
after(() => rmSync(ws, { recursive: true, force: true }));

const build = (pb, over = {}) =>
  pb.buildPrompt({ userMessage: 'do the thing', mode: 'auto', topology: 'single', ...over });

/** Drive the builder until the periodic reminder appears. */
function driveToRefresh(pb, over = {}, limit = 60) {
  for (let i = 0; i < limit; i++) {
    const p = build(pb, over);
    if (p.includes('<system_reminder>')) return { prompt: p, after: i + 1 };
  }
  return { prompt: null, after: limit };
}

describe('PromptBuilder — what goes out on each message', () => {
  test('turn 0 carries the system prompt and the full tool schemas', () => {
    const pb = new PromptBuilder(ws, ws);
    const p = build(pb);
    assert.match(p, /<system_instructions>/);
    assert.match(p, /<available_tools>/);
    // "full" means parameter docs, not just names
    assert.match(p, /Parameters:/);
  });

  test('ordinary turns send the user message and a context line, nothing else', () => {
    const pb = new PromptBuilder(ws, ws);
    build(pb);
    const p = build(pb);
    assert.doesNotMatch(p, /<system_instructions>/);
    assert.doesNotMatch(p, /<available_tools>/);
    assert.match(p, /\[Workspace: /);
    assert.match(p, /do the thing/);
  });

  test('the reminder is a reminder: names only, never the schemas again', () => {
    const pb = new PromptBuilder(ws, ws);
    build(pb);
    const { prompt } = driveToRefresh(pb);
    assert.ok(prompt, 'reminder never fired');
    assert.match(prompt, /<available_tools>/);
    assert.doesNotMatch(prompt, /Parameters:/);
    assert.doesNotMatch(prompt, /<system_instructions>/);
  });

  test('the reminder stays far cheaper than the prompt it reminds of', () => {
    const pb = new PromptBuilder(ws, ws);
    const turn0 = build(pb).length;
    const { prompt } = driveToRefresh(pb);
    assert.ok(prompt.length < turn0 / 3,
      `reminder ${prompt.length} chars vs turn 0 ${turn0} — resending a large block is what trips the A/B modal`);
  });
});

describe('PromptBuilder — refresh cadence counts messages, not user turns', () => {
  test('tool-result messages pull the reminder forward', () => {
    const plain = new PromptBuilder(ws, ws);
    build(plain);
    const withoutTools = driveToRefresh(plain).after;

    const busy = new PromptBuilder(ws, ws);
    build(busy);
    let n = 0;
    for (; n < 60; n++) {
      // one user turn, then three tool round-trips off the back of it
      const p = build(busy);
      if (p.includes('<system_reminder>')) break;
      for (let k = 0; k < 3; k++) busy.noteMessageSent();
    }

    assert.ok(n < withoutTools,
      `tool-heavy session refreshed after ${n} turns, quiet session after ${withoutTools} — ` +
      'a turn-based counter would make these identical');
  });

  test('noteMessageSent is called once per message, not once per result', () => {
    const pb = new PromptBuilder(ws, ws);
    build(pb);
    const before = pb.messagesSinceRefresh;
    pb.buildToolResultPrompt('read_file', 'contents');
    pb.buildToolResultPrompt('grep_search', 'hits');
    assert.strictEqual(pb.messagesSinceRefresh, before,
      'building a result must not count; the loop counts the joined batch');
    pb.noteMessageSent();
    assert.strictEqual(pb.messagesSinceRefresh, before + 1);
  });

  test('resetPromptState puts the next message back at turn 0', () => {
    const pb = new PromptBuilder(ws, ws);
    build(pb);
    assert.doesNotMatch(build(pb), /<system_instructions>/);
    pb.resetPromptState();
    assert.match(build(pb), /<system_instructions>/);
  });
});

describe('PromptBuilder — instructions the model can actually act on', () => {
  test('no message teaches the QUESTION: protocol, which nothing parses', () => {
    for (const tier of ['flash', 'flash-thinking', 'pro']) {
      const pb = new PromptBuilder(ws, ws);
      const modelConfig = { modelTier: tier };
      const messages = [build(pb, { modelConfig }), driveToRefresh(pb, { modelConfig }).prompt];
      for (const m of messages) {
        assert.doesNotMatch(m, /QUESTION: </,
          `${tier} still points the model at a protocol with no parser`);
      }
      assert.match(messages[0], /ask_question/);
    }
  });

  test('the single-response rule is stated once, in the system prompt', () => {
    const pb = new PromptBuilder(ws, ws);
    const turn0 = build(pb);
    assert.strictEqual((turn0.match(/ONE ANSWER PER TURN/g) || []).length, 1);
    // ...and not chanted at the end of every message thereafter.
    assert.doesNotMatch(build(pb), /drafts/i);
    assert.doesNotMatch(driveToRefresh(pb).prompt, /drafts/i);
  });

  test('the anti-fluff rule does not forbid the thought blocks pro requires', () => {
    const pb = new PromptBuilder(ws, ws);
    const p = build(pb, { modelConfig: { modelTier: 'pro' } });
    assert.match(p, /<thought>/, 'pro asks for thought blocks');
    assert.match(p, /`<thought>` block is the one thing that may precede a tool call/);
  });
});

describe('PromptBuilder — the advertised tool set matches the dispatchable one', () => {
  const names = (text) => [...text.matchAll(/^## ([a-z_]+)/gm)].map((m) => m[1]);

  test('ask_researcher is advertised in every tier', () => {
    for (const tier of ['flash', 'flash-thinking', 'pro']) {
      const pb = new PromptBuilder(ws, ws);
      const defs = pb._buildToolDefinitions('single', { modelTier: tier });
      assert.ok(names(defs).includes('ask_researcher'),
        `${tier} omits ask_researcher, which agent-loop dispatches`);
    }
  });

  test('the reminder index cannot drift from the definitions', () => {
    for (const topology of ['single', 'duo', 'swarm']) {
      const pb = new PromptBuilder(ws, ws);
      const defs = names(pb._buildToolDefinitions(topology, {}));
      const index = pb._buildToolIndex(topology, {});
      for (const n of defs) {
        assert.ok(index.includes(n), `${topology}: ${n} missing from the reminder index`);
      }
    }
  });

  test('subagent tools appear only where that topology can route them', () => {
    const pb = new PromptBuilder(ws, ws);
    assert.ok(!names(pb._buildToolDefinitions('single', {})).includes('ask_reviewer'));
    assert.ok(names(pb._buildToolDefinitions('duo', {})).includes('ask_reviewer'));
    assert.ok(!names(pb._buildToolDefinitions('duo', {})).includes('ask_reasoner'));
    assert.ok(names(pb._buildToolDefinitions('swarm', {})).includes('ask_reasoner'));
  });
});

describe('PromptBuilder — tier differentiation', () => {
  test('flash gets a smaller prompt than pro', () => {
    const pb = new PromptBuilder(ws, ws);
    const flash = build(pb, { modelConfig: { modelTier: 'flash' } }).length;
    const pb2 = new PromptBuilder(ws, ws);
    const pro = build(pb2, { modelConfig: { modelTier: 'pro' } }).length;
    assert.ok(flash < pro / 2, `flash ${flash} vs pro ${pro}`);
  });

  test('flash gets worked examples of the tool format, pro gets the spec', () => {
    const pb = new PromptBuilder(ws, ws);
    assert.match(pb._buildToolCallFormat('flash'), /"name": "read_file"/);
    assert.doesNotMatch(pb._buildToolCallFormat('pro'), /"name": "read_file"/);
  });

  test('legacy reasoningEffort still selects a tier', () => {
    const pb = new PromptBuilder(ws, ws);
    assert.strictEqual(pb._effortToTier('low'), 'flash');
    assert.strictEqual(pb._effortToTier('medium'), 'flash-thinking');
    assert.strictEqual(pb._effortToTier('high'), 'pro');
    assert.strictEqual(pb._effortToTier(undefined), 'pro');
  });
});

describe('PromptBuilder — pro reasoning levels', () => {
  const proPrompt = (reasoningLevel) => {
    const pb = new PromptBuilder(ws, ws);
    return build(pb, { modelConfig: { modelTier: 'pro', reasoningLevel } });
  };

  test('brief skips the planning ceremony; standard and deep require it', () => {
    assert.doesNotMatch(proPrompt('brief'), /RESTATE AND DECOMPOSE/);
    assert.match(proPrompt('standard'), /RESTATE AND DECOMPOSE/);
    assert.match(proPrompt('deep'), /RESTATE AND DECOMPOSE/);
  });

  test('deep adds approach enumeration and an adversarial pass', () => {
    assert.match(proPrompt('deep'), /Approach enumeration/);
    assert.match(proPrompt('deep'), /Adversarial self-review/);
    assert.doesNotMatch(proPrompt('standard'), /Adversarial self-review/);
  });

  test('the levels are ordered by how much prompt they spend', () => {
    const brief = proPrompt('brief').length;
    const standard = proPrompt('standard').length;
    const deep = proPrompt('deep').length;
    assert.ok(brief < standard, `brief ${brief} !< standard ${standard}`);
    assert.ok(standard < deep, `standard ${standard} !< deep ${deep}`);
  });

  test('phase numbering stays consistent within a level', () => {
    // brief drops the analysis phase, so its verify step is PHASE 3, not 4.
    assert.match(proPrompt('brief'), /PHASE 3: VERIFICATION/);
    assert.match(proPrompt('standard'), /PHASE 4: VERIFICATION/);
  });

  test('an unknown or missing level falls back to standard, never to nothing', () => {
    for (const bad of [undefined, null, '', 'ultra', 42, {}]) {
      const pb = new PromptBuilder(ws, ws);
      const p = build(pb, { modelConfig: { modelTier: 'pro', reasoningLevel: bad } });
      assert.match(p, /RESTATE AND DECOMPOSE/, `level ${JSON.stringify(bad)} produced no protocol`);
    }
  });

  test('levels do not leak into the flash tiers, which have no room for them', () => {
    const pb = new PromptBuilder(ws, ws);
    const p = build(pb, { modelConfig: { modelTier: 'flash', reasoningLevel: 'deep' } });
    assert.doesNotMatch(p, /RESTATE AND DECOMPOSE/);
    assert.doesNotMatch(p, /reasoning level/);
  });

  test('the periodic reminder repeats the level actually in force', () => {
    const pb = new PromptBuilder(ws, ws);
    const modelConfig = { modelTier: 'pro', reasoningLevel: 'brief' };
    build(pb, { modelConfig });
    const { prompt } = driveToRefresh(pb, { modelConfig });
    assert.match(prompt, /Investigate → Implement → Verify/);
    assert.doesNotMatch(prompt, /decompose it into a checklist/i);
  });
});

describe('PromptBuilder — the solo topology tells the truth about delegation', () => {
  test('single no longer claims there is nothing to delegate to while listing subagent tools', () => {
    const pb = new PromptBuilder(ws, ws);
    const p = build(pb, { topology: 'single' });
    assert.doesNotMatch(p, /There are no other models to delegate to/);
    // Both of these dispatch fine in single topology (agent-loop.js), so the
    // prompt has to admit they exist.
    assert.match(p, /ask_researcher/);
    assert.match(p, /ask_subagent/);
  });
});

describe('PromptBuilder — the ask_question contract', () => {
  test('every tier is told a prose question does not reach the user', () => {
    for (const tier of ['flash', 'flash-thinking', 'pro']) {
      const pb = new PromptBuilder(ws, ws);
      const p = build(pb, { modelConfig: { modelTier: tier } });
      assert.match(p, /ask_question/, `${tier} does not mention the tool`);
    }
    const pb = new PromptBuilder(ws, ws);
    assert.match(build(pb), /a question written in prose is not a question/i);
  });

  test('the header parameter the UI renders is documented', () => {
    const pb = new PromptBuilder(ws, ws);
    assert.match(build(pb), /header \(string, optional\)/);
  });
});

describe('PromptBuilder — the objective is not the message repeated back', () => {
  test('an objective identical to the user message is not sent twice', () => {
    const pb = new PromptBuilder(ws, ws);
    const text = 'ask me 3 questions with options';
    const turn0 = pb.buildPrompt({ userMessage: text, mode: 'plan', modelConfig: {}, objective: text });
    assert.strictEqual((turn0.match(/ask me 3 questions with options/g) || []).length, 1);

    const plain = pb.buildPrompt({ userMessage: text, mode: 'plan', modelConfig: {}, objective: text });
    assert.doesNotMatch(plain, /\[Objective:/);
  });

  test('an objective that differs from the message is still carried', () => {
    const pb = new PromptBuilder(ws, ws);
    build(pb);
    const plain = pb.buildPrompt({
      userMessage: 'now do the next one',
      mode: 'plan',
      modelConfig: {},
      objective: 'migrate the parser to acorn',
    });
    assert.match(plain, /\[Objective: migrate the parser to acorn\]/);
  });
});

describe('PromptBuilder — tool results ride in one envelope', () => {
  const results = [
    { name: 'read_file', result: 'a' },
    { name: 'read_file', result: 'b' },
    { name: 'grep_search', result: 'c' },
  ];

  test('the trailer appears once, not once per result', () => {
    const pb = new PromptBuilder(ws, ws);
    const batch = pb.buildToolResultBatch(results);
    assert.strictEqual((batch.match(/Reply once, with exactly one of/g) || []).length, 1,
      'three instructions to give one response is both repetitive and self-contradictory');
  });

  test('every result is still present and attributed to its tool', () => {
    const pb = new PromptBuilder(ws, ws);
    const batch = pb.buildToolResultBatch(results);
    assert.strictEqual((batch.match(/<result tool=/g) || []).length, 3);
    assert.match(batch, /tool="grep_search"/);
    for (const value of ['a', 'b', 'c']) assert.ok(batch.includes(value));
  });

  test('batching a fan-out costs far less than repeating the envelope', () => {
    const pb = new PromptBuilder(ws, ws);
    const one = pb.buildToolResultPrompt('read_file', 'a').length;
    const three = pb.buildToolResultBatch(results).length;
    assert.ok(three < one * 2, `three results (${three}) should not cost three envelopes (${one * 3})`);
  });

  test('the single-result wrapper still produces a valid envelope', () => {
    const pb = new PromptBuilder(ws, ws);
    const one = pb.buildToolResultPrompt('read_file', 'contents');
    assert.match(one, /<tool_results>/);
    assert.match(one, /<result tool="read_file">/);
    assert.ok(one.includes('contents'));
  });

  test('an object result is serialised rather than stringified to [object Object]', () => {
    const pb = new PromptBuilder(ws, ws);
    const one = pb.buildToolResultPrompt('manage_task', { status: 'running', taskId: 'abc' });
    assert.match(one, /"taskId": "abc"/);
  });
});

describe('PromptBuilder — drift brings the reminder forward', () => {
  test('a malformed tool call refreshes on the next prompt, not 20 messages later', () => {
    const pb = new PromptBuilder(ws, ws);
    build(pb);
    assert.doesNotMatch(build(pb), /<system_reminder>/, 'nothing is due yet');
    pb.noteDrift();
    assert.match(build(pb), /<system_reminder>/, 'drift should pull the reminder in');
  });

  test('the reminder still resets the counter afterwards', () => {
    const pb = new PromptBuilder(ws, ws);
    build(pb);
    pb.noteDrift();
    build(pb);
    assert.doesNotMatch(build(pb), /<system_reminder>/, 'it should not fire every turn after drift');
  });
});

describe('PromptBuilder — turn-0 ordering', () => {
  test('the tool-call format sits immediately before the tool list it governs', () => {
    const pb = new PromptBuilder(ws, ws);
    const p = build(pb);
    const format = p.indexOf('## Tool Call Format');
    const tools = p.indexOf('<available_tools>');
    const reasoning = p.indexOf('Cognitive Mode');
    assert.ok(format > -1 && tools > -1);
    assert.ok(format < tools, 'the contract must precede the list');
    assert.ok(reasoning < format, 'and follow the behavioural rules');
  });
});

describe('PromptBuilder — the single-response rule is stated, not chanted', () => {
  test('a plain user turn ends with the user message, not a formatting rule', () => {
    const pb = new PromptBuilder(ws, ws);
    build(pb);
    const plain = build(pb);
    assert.doesNotMatch(plain, /No drafts/);
    assert.ok(plain.trimEnd().endsWith('</user_message>'),
      `the last thing read should be the request:\n${plain}`);
  });

  test('the rule is still stated where it is read at least once', () => {
    for (const tier of ['flash', 'flash-thinking', 'pro']) {
      const pb = new PromptBuilder(ws, ws);
      const turn0 = build(pb, { modelConfig: { modelTier: tier } });
      assert.match(turn0, /one answer per turn/i,
        `${tier} states it nowhere — retiring the trailer must not delete the rule`);
    }
  });

  test('the tool-result envelope says what to do, not what to avoid', () => {
    const pb = new PromptBuilder(ws, ws);
    const envelope = pb.buildToolResultPrompt('read_file', 'x');
    assert.match(envelope, /Reply once, with exactly one of/);
    assert.doesNotMatch(envelope, /No drafts/);
  });
});
