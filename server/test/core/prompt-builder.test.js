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
    for (const effort of ['flash', 'flash-thinking', 'standard']) {
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

  test('ask_researcher is advertised in every tier', () => {
    for (const effort of ['flash', 'flash-thinking', 'standard']) {
      const pb = new PromptBuilder(ws, ws);
      const defs = pb._buildToolDefinitions('single', { effort });
      assert.ok(names(defs).includes('ask_researcher'),
        `${effort} omits ask_researcher, which agent-loop dispatches`);
    }
  });

  test('the reminder index cannot drift from the definitions', () => {
    for (const topology of ['single', 'duo']) {
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
    const flash = build(pb, { modelConfig: { effort: 'flash' } }).length;
    const pb2 = new PromptBuilder(ws, ws);
    const pro = build(pb2, { modelConfig: { effort: 'standard' } }).length;
    assert.ok(flash < pro / 2, `flash ${flash} vs pro ${pro}`);
  });

  test('flash gets worked examples of the tool format, pro gets the spec', () => {
    const pb = new PromptBuilder(ws, ws);
    assert.match(pb._buildToolCallFormat('flash'), /"name": "read_file"/);
    assert.doesNotMatch(pb._buildToolCallFormat('pro'), /"name": "read_file"/);
  });

  // The three old keys are folded into one rung on read, so a config written
  // by any earlier build still lands on the profile it used to get.
  test('a config written before /effort still selects the right profile', () => {
    assert.strictEqual(effortFromConfig({ modelTier: 'flash' }), 'flash');
    assert.strictEqual(effortFromConfig({ reasoningEffort: 'low' }), 'flash');
    assert.strictEqual(effortFromConfig({ reasoningEffort: 'medium' }), 'flash-thinking');
    assert.strictEqual(effortFromConfig({ modelTier: 'pro', reasoningLevel: 'deep' }), 'deep');
    assert.strictEqual(effortFromConfig({}), 'standard');
  });

  // "flash tier, deep reasoning" was representable and meant nothing. The tier
  // is what the prompt branched on, so it wins and the level is dropped.
  test('a combination that never made sense resolves to the half that did', () => {
    assert.strictEqual(effortFromConfig({ modelTier: 'flash', reasoningLevel: 'deep' }), 'flash');
  });
});

describe('PromptBuilder — pro reasoning levels', () => {
  const proPrompt = (effort) => {
    const pb = new PromptBuilder(ws, ws);
    return build(pb, { modelConfig: { effort } });
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
      const p = build(pb, { modelConfig: { effort: bad } });
      assert.match(p, /RESTATE AND DECOMPOSE/, `effort ${JSON.stringify(bad)} produced no protocol`);
    }
  });

  test('levels do not leak into the flash tiers, which have no room for them', () => {
    const pb = new PromptBuilder(ws, ws);
    const p = build(pb, { modelConfig: { effort: 'flash' } });
    assert.doesNotMatch(p, /RESTATE AND DECOMPOSE/);
    assert.doesNotMatch(p, /Adversarial self-review/);
  });

  test('the periodic reminder repeats the level actually in force', () => {
    const pb = new PromptBuilder(ws, ws);
    const modelConfig = { effort: 'brief' };
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
    for (const effort of ['flash', 'flash-thinking', 'standard']) {
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
    for (const effort of ['flash', 'flash-thinking', 'standard']) {
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
    'list_directory', 'run_command', 'open_in_editor', 'run_background',
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
      for (const effort of ['flash', 'flash-thinking', 'brief', 'standard', 'deep']) {
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
  const LADDER = ['flash', 'flash-thinking', 'brief', 'standard', 'deep'];

  // The point of scaling rather than excluding: Flash is the *weakest* model on
  // the ladder, so it is the most likely to report a thing as done without
  // having looked. Leaving the check off that rung takes it off the one that
  // needs it most.
  test('no rung is left without a handover check', () => {
    for (const effort of LADDER) {
      assert.match(pro(effort), /BEFORE YOU FINISH|THE HANDOVER REVIEW/, effort);
    }
  });

  test('every rung is told to keep a checklist, and to check it at the end', () => {
    for (const effort of LADDER) {
      const p = pro(effort);
      assert.match(p, /proactively create/, `${effort}: never asked for a list`);
      assert.match(p, /Checklist:|<task_checklist>/, `${effort}: never checks it`);
    }
  });

  test('every rung must say what it did not do', () => {
    // Silence here reads as "all of it is finished", which is how a partial job
    // gets handed over as a complete one.
    for (const effort of LADDER) {
      assert.match(pro(effort), /Not done|not \*done\*|did \*not\* do/i, effort);
    }
  });

  // Three sizes, because one size is either ceremony on a one-line fix or too
  // thin for work where being wrong is expensive.
  test('the depth scales with the rung', () => {
    assert.match(pro('flash'), /BEFORE YOU FINISH/);
    assert.doesNotMatch(pro('flash'), /THE HANDOVER REVIEW/, 'the full review on a 5.6k prompt is +33%');

    for (const mid of ['flash-thinking', 'brief']) {
      assert.match(pro(mid), /Read back:/, `${mid} should get the four-point version`);
      assert.doesNotMatch(pro(mid), /THE HANDOVER REVIEW/, mid);
    }

    for (const deep of ['standard', 'deep']) {
      assert.match(pro(deep), /THE HANDOVER REVIEW/, deep);
    }
  });

  // The whole prompt strategy exists to avoid large repeated payloads typed
  // into a browser tab, and Flash's identity is being terse.
  test('the cost stays proportionate', () => {
    const chars = Object.fromEntries(LADDER.map((e) => [e, pro(e).length]));
    assert.ok(chars.flash < 7000, `flash grew to ${chars.flash}; it is the terse rung`);
    assert.ok(chars.flash < chars['flash-thinking'], 'the ladder stopped being a ladder');
    assert.ok(chars.brief < chars.standard);
    assert.ok(chars.standard < chars.deep);
  });
});

describe('the handover review — asked for, so pin where it appears', () => {
  const pro = (effort, over = {}) =>
    build(new PromptBuilder(ws, ws), { modelConfig: { effort }, ...over });

  test('standard and deep get it', () => {
    for (const effort of ['standard', 'deep']) {
      assert.match(pro(effort), /THE HANDOVER REVIEW/, effort);
    }
  });

  // `brief`'s promise on the ladder is "straight to work", so it gets the
  // four-point version rather than the seven-point one — but not nothing.
  // "Did you run it" and "what did you not do" are worth asking at any size.
  test('brief gets the shorter one instead', () => {
    assert.doesNotMatch(pro('brief'), /THE HANDOVER REVIEW/);
    assert.match(pro('brief'), /BEFORE YOU FINISH/);
  });

  test('the flash tiers never see the pro prompt, so they get their own', () => {
    assert.doesNotMatch(pro('flash'), /THE HANDOVER REVIEW/);
    assert.doesNotMatch(pro('flash-thinking'), /THE HANDOVER REVIEW/);
    assert.match(pro('flash'), /BEFORE YOU FINISH/);
    assert.match(pro('flash-thinking'), /BEFORE YOU FINISH/);
  });

  // The whole prompt strategy exists to avoid large repeated payloads, and
  // this is ~1.8k characters retyped into a browser tab.
  test('it rides turn 0, not every turn', () => {
    const pb = new PromptBuilder(ws, ws);
    const first = build(pb, { modelConfig: { effort: 'deep' } });
    const second = build(pb, { modelConfig: { effort: 'deep' } });
    assert.match(first, /THE HANDOVER REVIEW/);
    assert.doesNotMatch(second, /THE HANDOVER REVIEW/);
  });

  test('it names the checklist that is actually carried back', () => {
    // It asks the model to audit `<task_checklist>`, which rides every turn.
    // Auditing a list it cannot see is the write-only trap that made the
    // original task.md useless.
    assert.match(pro('deep'), /<task_checklist>/);
  });

  test('it demands evidence rather than reassurance', () => {
    const p = pro('deep');
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
