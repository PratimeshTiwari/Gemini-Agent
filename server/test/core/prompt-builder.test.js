import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { PromptBuilder, stripImageData } from '../../src/core/prompt-builder.js';
import { effortFromConfig } from '../../src/core/effort.js';

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
    for (const effort of ['lite', 'flash', 'standard']) {
      const pb = new PromptBuilder(ws, ws);
      const modelConfig = { effort };
      const messages = [build(pb, { modelConfig }), driveToRefresh(pb, { modelConfig }).prompt];
      for (const m of messages) {
        assert.doesNotMatch(m, /QUESTION: </,
          `${effort} still points the model at a protocol with no parser`);
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
    const p = build(pb, { modelConfig: { effort: 'standard' } });
    assert.match(p, /<thought>/, 'pro asks for thought blocks');
    assert.match(p, /`<thought>` block is the one thing that may precede a tool call/);
  });
});

describe('PromptBuilder — the advertised tool set matches the dispatchable one', () => {
  const names = (text) => [...text.matchAll(/^## ([a-z_]+)/gm)].map((m) => m[1]);

  test('ask_subagent is advertised in every tier when subagents are on', () => {
    for (const effort of ['lite', 'flash', 'standard']) {
      const pb = new PromptBuilder(ws, ws);
      const defs = pb._buildToolDefinitions(true, { effort });
      assert.ok(names(defs).includes('ask_subagent'),
        `${effort} omits ask_subagent, which agent-loop dispatches`);
    }
  });

  test('the reminder index cannot drift from the definitions', () => {
    for (const subagents of [true, false]) {
      const pb = new PromptBuilder(ws, ws);
      const defs = names(pb._buildToolDefinitions(subagents, {}));
      const index = pb._buildToolIndex(subagents, {});
      for (const n of defs) {
        assert.ok(index.includes(n), `subagents=${subagents}: ${n} missing from the index`);
      }
    }
  });

  test('ask_subagent appears only when it can actually be routed', () => {
    const pb = new PromptBuilder(ws, ws);
    assert.ok(!names(pb._buildToolDefinitions(false, {})).includes('ask_subagent'));
    assert.ok(names(pb._buildToolDefinitions(true, {})).includes('ask_subagent'));
  });

  test('ask_reasoner is gone, in every topology', () => {
    // Swarm needed three distinct models to be worth anything, and there are
    // only two bridges. Advertising a tool that cannot be routed is how the
    // model ends up calling something that silently goes nowhere.
    const pb = new PromptBuilder(ws, ws);
    for (const topology of ['single', 'duo']) {
      assert.ok(!names(pb._buildToolDefinitions(topology, {})).includes('ask_reasoner'));
    }
  });
});

describe('PromptBuilder — tier differentiation', () => {
  test('flash gets a smaller prompt than pro', () => {
    const pb = new PromptBuilder(ws, ws);
    const flash = build(pb, { modelConfig: { effort: 'lite' } }).length;
    const pb2 = new PromptBuilder(ws, ws);
    const pro = build(pb2, { modelConfig: { effort: 'standard' } }).length;
    assert.ok(flash < pro / 2, `flash ${flash} vs pro ${pro}`);
  });

  test('flash gets worked examples of the tool format, pro gets the spec', () => {
    const pb = new PromptBuilder(ws, ws);
    assert.match(pb._buildToolCallFormat('lite'), /"name": "read_file"/);
    assert.doesNotMatch(pb._buildToolCallFormat('pro'), /"name": "read_file"/);
  });

  // The three old keys are folded into one rung on read, so a config written
  // by any earlier build still lands on the profile it used to get.
  test('a config written before /effort still selects the right profile', () => {
    assert.strictEqual(effortFromConfig({ modelTier: 'lite' }), 'lite');
    assert.strictEqual(effortFromConfig({ reasoningEffort: 'low' }), 'lite');
    assert.strictEqual(effortFromConfig({ reasoningEffort: 'medium' }), 'flash');
    assert.strictEqual(effortFromConfig({ modelTier: 'pro', reasoningLevel: 'deep' }), 'pro');
    assert.strictEqual(effortFromConfig({}), 'pro');
  });

  // "flash tier, deep reasoning" was representable and meant nothing. The tier
  // is what the prompt branched on, so it wins and the level is dropped.
  test('a combination that never made sense resolves to the half that did', () => {
    assert.strictEqual(effortFromConfig({ modelTier: 'lite', reasoningLevel: 'deep' }), 'lite');
  });
});

/*
 * One pro rung since 2026-09-20. `brief` and `deep` are gone, so what was a
 * comparison between three rungs is now a description of the one that is left:
 * `pro` is the old `standard` plus `deep`'s review step, and explicitly
 * *without* `deep`'s other two blocks.
 *
 * Those two are the assertions that carry weight here. The critical-analysis
 * phase and the assumption ledger were declined on **output** cost, which no
 * character count of the prompt can see — so nothing but a `doesNotMatch` will
 * notice them creeping back in.
 */
describe('PromptBuilder — the pro rung', () => {
  const proPrompt = (effort = 'pro') => {
    const pb = new PromptBuilder(ws, ws);
    return build(pb, { modelConfig: { effort } });
  };

  test('it plans first — the block `brief` used to skip', () => {
    assert.match(proPrompt(), /RESTATE AND DECOMPOSE/);
  });

  test('it keeps deep\'s review step', () => {
    assert.match(proPrompt(), /Send the diff to `ask_subagent`/);
  });

  test('and not deep\'s other two blocks, which cost output on every turn', () => {
    assert.doesNotMatch(proPrompt(), /Approach enumeration/);
    assert.doesNotMatch(proPrompt(), /ASSUMPTION LEDGER/);
  });

  test('the four-phase protocol, not brief\'s three', () => {
    assert.match(proPrompt(), /PHASE 4: VERIFICATION/);
    assert.doesNotMatch(proPrompt(), /PHASE 3: VERIFICATION/);
  });

  // The retired ids are not rungs; asking for one must land on `pro` rather
  // than on a flash profile, which is the whole point of `RETIRED_RUNGS`.
  test('a retired rung name still builds the pro prompt', () => {
    for (const gone of ['brief', 'standard', 'deep']) {
      assert.match(proPrompt(gone), /RESTATE AND DECOMPOSE/, gone);
    }
  });

  test('an unknown or missing level falls back to standard, never to nothing', () => {
    for (const bad of [undefined, null, '', 'ultra', 42, {}]) {
      const pb = new PromptBuilder(ws, ws);
      const p = build(pb, { modelConfig: { effort: bad } });
      assert.match(p, /RESTATE AND DECOMPOSE/, `effort ${JSON.stringify(bad)} produced no protocol`);
    }
  });

  test('levels do not leak into the flash tiers, which have no room for them', () => {
    const pb = new PromptBuilder(ws, ws);
    const p = build(pb, { modelConfig: { effort: 'lite' } });
    assert.doesNotMatch(p, /RESTATE AND DECOMPOSE/);
    assert.doesNotMatch(p, /Adversarial self-review/);
  });

  /*
   * The reminder has to describe the rung in force, not a default. With one pro
   * rung the discriminating pair is flash-thinking against pro — if the
   * reminder ever hard-coded either, this is what catches it.
   */
  test('the periodic reminder repeats the rung actually in force', () => {
    const remind = (effort) => {
      const pb = new PromptBuilder(ws, ws);
      const modelConfig = { effort };
      build(pb, { modelConfig });
      return driveToRefresh(pb, { modelConfig }).prompt;
    };
    assert.match(remind('pro'), /decompose/i);
    assert.doesNotMatch(remind('lite'), /decompose/i);
  });
});

describe('PromptBuilder — the prompt tells the truth about delegation', () => {
  /*
   * Asserted on the contract, not on one wording.
   *
   * This used to match `role: "research"` exactly — a string that lived in the
   * Role block's description of `ask_subagent`, which duplicated the tool's own
   * entry further down. Removing that duplication broke the test while leaving
   * the capability fully described, which is a test failing for the wrong
   * reason: it was pinning a sentence rather than a promise.
   *
   * What the prompt has to do is name the tool, name the three roles, and say
   * the subagent starts empty — the last one being what stops a caller sending
   * "review the fix above" to something that has never seen it.
   */
  test('with subagents on it says they exist and what they are for', () => {
    const pb = new PromptBuilder(ws, ws);
    const p = build(pb, { subagents: true });
    assert.doesNotMatch(p, /There are no other models to delegate to/);
    assert.match(p, /ask_subagent/);
    for (const role of ['review', 'research', 'task']) {
      assert.match(p, new RegExp(`"${role}"`), `the ${role} role is never named`);
    }
    assert.match(p, /own empty context|has not seen this conversation/,
      'nothing tells the caller the subagent starts with nothing');
  });

  /*
   * The half that used to be wrong in the other direction: a prompt that lists
   * subagent tools while telling the model it has nobody to delegate to. With
   * the toggle off it must do neither — no tool, and no claim that one exists.
   */
  test('with subagents off it says so, and names no subagent tool', () => {
    const pb = new PromptBuilder(ws, ws);
    const p = build(pb, { subagents: false });
    assert.match(p, /no subagents available in this session/);
    assert.doesNotMatch(p, /ask_subagent/);
  });
});

describe('PromptBuilder — the ask_question contract', () => {
  test('every tier is told a prose question does not reach the user', () => {
    for (const effort of ['lite', 'flash', 'standard']) {
      const pb = new PromptBuilder(ws, ws);
      const p = build(pb, { modelConfig: { effort } });
      assert.match(p, /ask_question/, `${effort} does not mention the tool`);
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
    assert.match(one, /"taskId":"abc"/);
  });

  test('object results go in minified — indentation is pure token cost', () => {
    const pb = new PromptBuilder(ws, ws);
    const result = { path: '.', children: [{ name: 'server', type: 'dir' }] };
    const one = pb.buildToolResultPrompt('list_directory', result);
    assert.ok(one.includes(JSON.stringify(result)), 'should contain the compact form');
    assert.ok(!one.includes('\n  "path"'), 'should not contain pretty-printed indentation');
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
    for (const effort of ['lite', 'flash', 'standard']) {
      const pb = new PromptBuilder(ws, ws);
      const turn0 = build(pb, { modelConfig: { effort } });
      assert.match(turn0, /one answer per turn/i,
        `${effort} states it nowhere — retiring the trailer must not delete the rule`);
    }
  });

  test('the tool-result envelope says what to do, not what to avoid', () => {
    const pb = new PromptBuilder(ws, ws);
    const envelope = pb.buildToolResultPrompt('read_file', 'x');
    assert.match(envelope, /Reply once, with exactly one of/);
    assert.doesNotMatch(envelope, /No drafts/);
  });
});

describe('stripImageData — what goes out is not what is kept', () => {
  const dataUrl = `data:image/png;base64,${'A'.repeat(2000)}`;
  const message = `[Image attached: /tmp/shot.png (14KB, image/png)]\n\n<image_data>\n${dataUrl}\n</image_data>\n\nwhat is wrong here?`;

  test('the payload itself is untouched — the bridge needs it whole', () => {
    assert.ok(message.includes(dataUrl), 'sanity: the fixture carries the data URL');
  });

  test('the remembered form keeps the question and drops the megabyte', () => {
    const kept = stripImageData(message);
    assert.doesNotMatch(kept, /base64,A/);
    assert.match(kept, /what is wrong here\?/);
    assert.match(kept, /Image attached: \/tmp\/shot\.png/, 'you can still see one was sent');
    assert.ok(kept.length < 300, `still ${kept.length} chars`);
  });

  test('several images in one message all go', () => {
    const two = `${message}\n${message}`;
    assert.doesNotMatch(stripImageData(two), /base64,A/);
  });

  test('a message with no image is returned unchanged', () => {
    assert.equal(stripImageData('just a question'), 'just a question');
    assert.equal(stripImageData(''), '');
    assert.equal(stripImageData(null), '');
  });
});

describe('PromptBuilder — the prompt may not name a tool that does not exist', () => {
  /**
   * The prompt *is* the contract. A tool named in prose that no dispatcher
   * answers to is worse than a missing instruction: the model obeys it, the
   * call is rejected, and the turn is spent.
   *
   * This existed. The pro-tier guardrails told the model to build its task.md
   * checklist "using the `write_to_file` tool", and there has never been a
   * `write_to_file` — the write tools are `create_file` and `edit_file`. It
   * survived because nothing compares the prose against the dispatch tables,
   * which is what this does.
   */
  const REAL_TOOLS = new Set([
    // mcp/mcp-server.js TOOL_DEFINITIONS
    'search_files', 'grep_search', 'read_file', 'edit_file', 'create_file',
    'list_directory', 'run_command', 'run_background',
    'manage_task', 'get_editor_state', 'get_diagnostics',
    // dispatched inside core/agent-loop.js, declared in no array (P2)
    'ask_question', 'ask_subagent', 'ask_researcher', 'ask_reviewer',
    'manage_memory',
  ]);

  /** Things in backticks that read like a tool name but are not one. */
  const NOT_TOOLS = /^(implementation_plan|task|walkthrough|plan|agent|memory|errors|history|package_json|node_modules)$/;

  test('every snake_case name the prompt calls a "tool" is dispatchable', () => {
    const offenders = new Set();

    for (const mode of ['plan', 'auto']) {
      for (const effort of ['lite', 'flash', 'brief', 'standard', 'deep']) {
        for (const topology of ['single', 'duo']) {
          const pb = new PromptBuilder(ws, ws);
          const modelConfig = { effort, main: 'gemini', ...(topology === 'duo' ? { reviewer: 'chatgpt' } : {}) };
          // Turn 0 (everything) and the periodic reminder both carry prose.
          const prompts = [build(pb, { mode, topology, modelConfig })];
          const refreshed = driveToRefresh(pb, { mode, topology, modelConfig });
          if (refreshed.prompt) prompts.push(refreshed.prompt);

          for (const prompt of prompts) {
            // `name` immediately followed by the word "tool" is the shape that
            // instructs a call; a bare backticked word can be a filename.
            for (const m of prompt.matchAll(/`([a-z][a-z0-9_]*_[a-z0-9_]+)`\s+tool\b/g)) {
              if (!REAL_TOOLS.has(m[1]) && !NOT_TOOLS.test(m[1])) offenders.add(m[1]);
            }
          }
        }
      }
    }

    assert.deepEqual([...offenders], [], `prompt names undispatchable tool(s): ${[...offenders]}`);
  });
});

describe('PromptBuilder — a dispatchable tool the prompt never mentions is unreachable', () => {
  /**
   * The other direction, and the one that bit.
   *
   * The existing guard catches a prompt naming a tool that does not exist.
   * `recall_history` was the opposite: registered in `TOOL_DEFINITIONS`, fully
   * working, and absent from the prompt — because `_buildToolDefinitions` is
   * two hand-written lists rather than a render of that array, which `CLAUDE.md`
   * has recorded as a drift risk since P2. A tool the model is never told about
   * is a tool that does not exist, and nothing said so.
   */
  test('every tool in TOOL_DEFINITIONS appears in the prompt', async () => {
    const { MCPServer } = await import('../../src/mcp/mcp-server.js');
    const server = new MCPServer(ws);
    const registered = server.getToolDefinitions
      ? server.getToolDefinitions().map((t) => t.name)
      : (server.tools || []).map((t) => t.name);

    assert.ok(registered.length > 0, 'could not read the tool registry');

    const pb = new PromptBuilder(ws, ws);
    const prompt = build(pb, { modelConfig: { effort: 'standard', main: 'gemini' } });

    const missing = registered.filter((name) => !prompt.includes(name));
    assert.deepEqual(missing, [], `dispatchable but never mentioned: ${missing.join(', ')}`);
  });
});

describe('every rung asks for a list, checks it, and reviews before finishing', () => {
  const pro = (effort) => build(new PromptBuilder(ws, ws), { modelConfig: { effort } });
  const pb = () => new PromptBuilder(ws, ws);
  const LADDER = ['lite', 'flash', 'pro'];

  /*
   * Where the handover lives depends on the rung now.
   *
   * The two flash rungs carry a few lines inside their own reasoning prompt —
   * small enough that moving them would cost more machinery than it saves. The
   * pro rungs get the full block on the **tool-result round that first changes
   * something**, because it is an instruction for the end of a turn and was
   * being delivered before the turn had done anything.
   *
   * So "every rung is asked" is still the property; it is just answered from
   * two places, and this checks both rather than only the one it used to.
   */
  // `pb()` is a fresh builder each call, deliberately: the block is full once
  // per chat and a pointer after.
  const handoverFor = (effort) => pro(effort) + pb().buildHandoverBlock(effort);

  // The point of scaling rather than excluding: Flash is the *weakest* model on
  // the ladder, so it is the most likely to report a thing as done without
  // having looked. Leaving the check off that rung takes it off the one that
  // needs it most.
  test('no rung is left without a handover check', () => {
    for (const effort of LADDER) {
      assert.match(handoverFor(effort), /BEFORE YOU FINISH|THE HANDOVER REVIEW/, effort);
    }
  });

  test('every rung is told to keep a checklist, and to check it at the end', () => {
    for (const effort of LADDER) {
      const p = handoverFor(effort);
      assert.match(p, /proactively create/, `${effort}: never asked for a list`);
      assert.match(p, /Checklist:|<task_checklist>/, `${effort}: never checks it`);
    }
  });

  test('every rung must say what it did not do', () => {
    // Silence here reads as "all of it is finished", which is how a partial job
    // gets handed over as a complete one.
    for (const effort of LADDER) {
      assert.match(handoverFor(effort), /Not done|not \*done\*|did \*not\* do/i, effort);
    }
  });

  /*
   * And the pro rungs must NOT carry it up front any more — that is the change,
   * and without this the move could silently revert to "in both places", which
   * costs the characters twice and looks like it works.
   */
  test('the pro rung no longer carries it in the opening prompt', () => {
    assert.doesNotMatch(pro('pro'), /THE HANDOVER REVIEW|Read back:/);
  });

  test('and the flash rungs still do, because theirs is small', () => {
    for (const effort of ['lite', 'flash']) {
      assert.match(pro(effort), /BEFORE YOU FINISH/, effort);
      assert.equal(pb().buildHandoverBlock(effort), '', `${effort} should not get a second one`);
    }
  });

  /*
   * Still three sizes, and they are the three rungs now rather than a split
   * inside pro. `handover-lite` was `brief`'s four-point version; with `brief`
   * gone it belongs to `flash-thinking`, which is the rung it now serves — so
   * nothing was orphaned by the collapse, it moved down one.
   */
  test('the depth scales with the rung', () => {
    // A fresh builder each time: the block is full once per chat and a pointer
    // after, so reusing one here would ask the same chat for it repeatedly and
    // assert against the reminder.
    const blockFresh = (effort) => new PromptBuilder(ws, ws).buildHandoverBlock(effort);

    assert.match(pro('lite'), /BEFORE YOU FINISH/);
    assert.doesNotMatch(pro('lite'), /THE HANDOVER REVIEW/, 'the full review on a 5.6k prompt is +33%');

    // flash-thinking carries the four-point version inside its own reasoning
    // prompt, and gets no second block.
    assert.match(pro('flash'), /Read back:/);
    assert.doesNotMatch(pro('flash'), /THE HANDOVER REVIEW/);

    assert.match(blockFresh('pro'), /THE HANDOVER REVIEW/);
  });

  // The whole prompt strategy exists to avoid large repeated payloads typed
  // into a browser tab, and Flash's identity is being terse.
  test('the cost stays proportionate', () => {
    const chars = Object.fromEntries(LADDER.map((e) => [e, pro(e).length]));
    assert.ok(chars.lite < 7000, `lite grew to ${chars.lite}; it is the terse rung`);
    // Strictly increasing, named explicitly. A mechanical rename briefly turned
    // the middle comparison into `chars.flash < chars.flash` — a value against
    // itself, which passes forever and says nothing.
    assert.ok(chars.lite < chars.flash, `lite ${chars.lite} !< flash ${chars.flash}`);
    assert.ok(chars.flash < chars.pro, `flash ${chars.flash} !< pro ${chars.pro}`);
  });
});

describe('the handover review — asked for, so pin where it appears', () => {
  const pro = (effort, over = {}) =>
    build(new PromptBuilder(ws, ws), { modelConfig: { effort }, ...over });
  const block = (effort) => new PromptBuilder(ws, ws).buildHandoverBlock(effort);

  test('standard and deep get it', () => {
    for (const effort of ['standard', 'deep']) {
      assert.match(block(effort), /THE HANDOVER REVIEW/, effort);
    }
  });

  /*
   * A retired rung name must still produce the pro block rather than nothing.
   * `buildHandoverBlock` takes the level, and `brief` used to select the
   * four-point version — so if the collapse had missed this call site, an old
   * stored config would silently get a shorter review than the rung it folds to.
   */
  test('a retired rung name gets the pro block, not the old short one', () => {
    for (const gone of ['brief', 'standard', 'deep']) {
      assert.match(block(gone), /THE HANDOVER REVIEW/, gone);
    }
  });

  test('the flash tiers never see the pro prompt, so they get their own', () => {
    assert.doesNotMatch(pro('lite'), /THE HANDOVER REVIEW/);
    assert.doesNotMatch(pro('flash'), /THE HANDOVER REVIEW/);
    assert.match(pro('lite'), /BEFORE YOU FINISH/);
    assert.match(pro('flash'), /BEFORE YOU FINISH/);
  });

  /*
   * It no longer rides turn 0 at all — the point of moving it.
   *
   * 1,879 characters of "check your work before you finish", delivered before
   * the turn had done anything and then thousands of tokens behind the model by
   * the time it mattered. It rides the tool-result round that first changes
   * something instead.
   */
  test('it is not in the opening prompt on any turn', () => {
    const pb = new PromptBuilder(ws, ws);
    const first = build(pb, { modelConfig: { effort: 'deep' } });
    const second = build(pb, { modelConfig: { effort: 'deep' } });
    assert.doesNotMatch(first, /THE HANDOVER REVIEW/);
    assert.doesNotMatch(second, /THE HANDOVER REVIEW/);
  });

  test('it names the checklist that is actually carried back', () => {
    // It asks the model to audit `<task_checklist>`, which rides every turn.
    // Auditing a list it cannot see is the write-only trap that made the
    // original task.md useless.
    assert.match(block('deep'), /<task_checklist>/);
  });

  test('it demands evidence rather than reassurance', () => {
    const p = block('deep');
    assert.match(p, /not a verdict|not checked/i);
    assert.match(p, /Paste what it\s+printed|Paste what it printed/);
  });
});

/**
 * A finished checklist, arriving on an unrelated prompt.
 *
 * `task.md` is one file reused for every task, so a completed list keeps
 * riding every later turn — including the first turn of something entirely
 * different. Reported from use: a finished round-2 list still sitting under a
 * new prompt. Handed ticked boxes with no framing, the model cannot tell "you
 * already did this" from "this is the plan for what you are being asked now",
 * and both natural mistakes are bad — tick nothing because it all looks done,
 * or edit the old file instead of writing a new plan.
 */
describe('a completed checklist says that it is completed', () => {
  const withTask = (md) => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-'));
    const file = join(dir, '.agent', 'artifacts', 'task.md');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, md);
    const pb = new PromptBuilder(dir, dir);
    build(pb, { modelConfig: { effort: 'deep' } });          // turn 0
    const p = build(pb, { modelConfig: { effort: 'deep' } }); // the next turn
    rmSync(dir, { recursive: true, force: true });
    return p;
  };

  test('all ticked is marked complete, and says what to do instead', () => {
    const tag = withTask('- [x] A\n- [x] B\n').match(/<task_checklist[^>]*>/)[0];
    assert.match(tag, /state="complete"/);
    assert.match(tag, /write a new list/i, 'it should say what to do if this request is different');
  });

  test('anything still open is not marked, because there is work in it', () => {
    const tag = withTask('- [x] A\n- [ ] B\n').match(/<task_checklist[^>]*>/)[0];
    assert.doesNotMatch(tag, /state="complete"/);
  });

  // Dropping the block entirely would take the handover review's
  // "re-read <task_checklist>" with it.
  test('the list is still sent either way', () => {
    assert.match(withTask('- [x] A\n'), /<task_checklist/);
    assert.match(withTask('- [ ] A\n'), /<task_checklist/);
  });
});

/**
 * Resuming a conversation the browser tab was never part of.
 *
 * The model's memory *is* the chat thread — `conversationHistory` is never
 * replayed into a tab. So restoring a transcript gives the model nothing, and
 * it will answer confidently about work it never did. The recap is the only
 * thing that makes "resume" honest when the tab has moved on.
 */
describe('the recap after a resume', () => {
  const resumed = () => {
    const ws2 = mkdtempSync(join(tmpdir(), 'recap-'));
    const pb = new PromptBuilder(ws2, ws2);
    pb.pendingRecap = [
      { role: 'user', content: 'why is the poller re-reading comments' },
      { role: 'agent', content: 'Because the watermark only moves when something was found.' },
      { role: 'tool', content: '{"huge":"json"}' },
    ];
    return { pb, cleanup: () => rmSync(ws2, { recursive: true, force: true }) };
  };

  test('the next turn carries it, framed as background', () => {
    const { pb, cleanup } = resumed();
    const p = build(pb, { modelConfig: { effort: 'standard' } });
    assert.match(p, /<resumed_conversation/);
    assert.match(p, /not part of/i, 'the model should be told it was not there');
    assert.match(p, /why is the poller re-reading comments/);
    cleanup();
  });

  // An introduction, not context to carry forever — the prompt strategy exists
  // to avoid large repeated payloads typed into a browser.
  test('and only that turn', () => {
    const { pb, cleanup } = resumed();
    build(pb, { modelConfig: { effort: 'standard' } });
    const second = build(pb, { modelConfig: { effort: 'standard' } });
    assert.doesNotMatch(second, /<resumed_conversation/);
    cleanup();
  });

  test('tool traffic is left out of it', () => {
    const { pb, cleanup } = resumed();
    assert.doesNotMatch(build(pb, { modelConfig: { effort: 'standard' } }), /huge/);
    cleanup();
  });

  test('nothing pending, nothing added', () => {
    const ws2 = mkdtempSync(join(tmpdir(), 'recap-'));
    const pb = new PromptBuilder(ws2, ws2);
    assert.doesNotMatch(build(pb, { modelConfig: { effort: 'standard' } }), /<resumed_conversation/);
    rmSync(ws2, { recursive: true, force: true });
  });

  test('a very long conversation is cut, not sent whole', () => {
    const ws2 = mkdtempSync(join(tmpdir(), 'recap-'));
    const pb = new PromptBuilder(ws2, ws2);
    pb.pendingRecap = Array.from({ length: 200 }, (_, i) => ({
      role: 'user', content: `turn ${i} ${'x'.repeat(200)}`,
    }));
    const p = build(pb, { modelConfig: { effort: 'standard' } });
    const block = p.match(/<resumed_conversation[\s\S]*?<\/resumed_conversation>/)[0];
    assert.ok(block.length < 5000, `the recap was ${block.length} characters`);
    assert.match(block, /turn 199/, 'it kept the oldest turns instead of the newest');
    rmSync(ws2, { recursive: true, force: true });
  });
});
