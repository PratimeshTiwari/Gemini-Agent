/**
 * One list, and the prompt assembled from it.
 *
 * There were four places that had to agree about which tools exist: the
 * runnable registry in `mcp/mcp-server.js`, two prose blocks in
 * `prompt-builder.js` (one per tier), a third list inside `runHeadlessTask`,
 * and five tools dispatched straight out of `agent-loop.js` that were declared
 * in none of them. Nothing checked any pair.
 *
 * Both directions have actually failed. `recall_history` and `get_diagnostics`
 * were registered, implemented and tested, and the model was never told they
 * existed — so they could not be called, by anyone, ever. And the system prompt
 * asked for `write_to_file` by name for weeks, which has never been a tool.
 *
 * The first three tests are the guard. The last one is the point: the text
 * moved out of `prompt-builder.js` byte-for-byte, and these pin the shapes so
 * the next edit to a tool description is a one-line diff in one file.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { TOOL_CATALOG, toolsFor, toolNames, renderToolDefinitions, toolCatalogDrift }
  from '../../src/core/tool-catalog.js';
import { MCPServer } from '../../src/mcp/mcp-server.js';
import { HEADLESS_SYSTEM_PROMPT } from '../../src/core/agent-loop.js';

/**
 * The loop-dispatched tools, read out of the **source that dispatches them**.
 *
 * This used to be `TOOL_CATALOG.filter(dispatch === 'loop')` — derived from the
 * catalog and then checked against the catalog, so that half of the drift check
 * could never disagree with itself. The same shape as the `toolCatalogDrift()`
 * bug already recorded in `CLAUDE.md`: an empty list compared to an empty list,
 * green forever.
 *
 * Reading the source is what makes it a check, and it has earned that twice.
 * When `ask_reviewer` and `ask_researcher` were collapsed into one
 * `ask_subagent` the derived list followed silently and only this one noticed;
 * when the three arms moved out of `agent-loop.js`'s `else if` chain into
 * `core/loop-tools.js`, this failed rather than quietly passing against a file
 * that no longer dispatches anything. **The file it reads must be the file with
 * the implementation in it** — point it at the catalog and it stops being a
 * test.
 */
const LOOP_DISPATCHED = [...new Set(
  readFileSync(new URL('../../src/core/loop-tools.js', import.meta.url), 'utf8')
    .matchAll(/case '([a-z_]+)': return \w+\(/g),
)].map((m) => m[1]);

/** The runnable registry, read the way the prompt builder would have to. */
function registry() {
  const server = new MCPServer('/tmp');
  return server.getToolDefinitions
    ? server.getToolDefinitions()
    : server.tools ?? [];
}

describe('the catalog and the runnable registry agree', () => {
  test('nothing runs that the prompt never names, and nothing is named that cannot run', () => {
    const problems = toolCatalogDrift(registry(), LOOP_DISPATCHED);
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  test('every tool the loop dispatches itself is declared', () => {
    // Read from the source above, so adding a branch to `_executeToolCalls`
    // without a catalog entry fails here rather than shipping a tool the model
    // is never told about.
    assert.ok(LOOP_DISPATCHED.length >= 3,
      `parsed ${LOOP_DISPATCHED.length} dispatch branches — the shape of that chain changed`);

    // `run_command` is branched on in the loop *and* registered with MCP — the
    // branch is the approval path, not the dispatch. The registry is what tells
    // the two apart, so a name it knows is not a loop tool.
    const mcp = new Set(registry().map((t) => t.name));
    const loopOnly = LOOP_DISPATCHED.filter((n) => !mcp.has(n));
    assert.ok(loopOnly.length >= 3, `only ${loopOnly.length} loop-only tools parsed`);

    for (const name of loopOnly) {
      const entry = TOOL_CATALOG.find((t) => t.name === name);
      assert.ok(entry, `${name} is dispatched in agent-loop.js and declared nowhere`);
      assert.equal(entry.dispatch, 'loop');
    }
  });

  test('the headless subset names only tools that exist', () => {
    // Its text is deliberately its own — a smaller, read-only set in a different
    // shape. Membership is what is checked, because that is the half that broke.
    const named = [...HEADLESS_SYSTEM_PROMPT.matchAll(/^- ([a-z_]+)\(/gm)].map((m) => m[1]);
    assert.ok(named.length >= 5, `parsed ${named.length} tool names — the prose shape changed`);
    const known = new Set(TOOL_CATALOG.map((t) => t.name));
    for (const name of named) {
      assert.ok(known.has(name), `runHeadlessTask offers "${name}", which is not a tool`);
    }
  });
});

describe('the subagent toggle', () => {
  test('ask_subagent is the only tool it gates', () => {
    assert.ok(!toolNames(false).includes('ask_subagent'));
    assert.ok(toolNames(true).includes('ask_subagent'));
    assert.equal(toolsFor(false).length + 1, toolsFor(true).length);
  });

  /*
   * A description is a routing rule. `ask_subagent`'s used to read "Delegate a
   * task to a generic parallel Gemini subagent" — a capability with no trigger,
   * which is the documented reason auto-delegation never fires. Each role has
   * to say *when*.
   */
  test('the description says when to reach for each role, not just what it is', () => {
    const defs = renderToolDefinitions('pro', true);

    assert.match(defs, /own empty context/, 'the one property that matters is unstated');
    assert.match(defs, /long serial chain of read_file calls/, 'research has no trigger');
    assert.match(defs, /does not share your assumptions/, 'review has no trigger');
    assert.match(defs, /role \(string, required\)/, 'the role is not a declared parameter');
  });

  // The negative control: with subagents off the model must not be told about a
  // tool it was never given — the drift `toolCatalogDrift` exists to catch.
  test('with subagents off it is told nothing about them', () => {
    const defs = renderToolDefinitions('pro', false);
    assert.doesNotMatch(defs, /ask_subagent/);
    assert.doesNotMatch(defs, /own empty context/);
  });
});

describe('the rendered block keeps its shape', () => {
  for (const tier of ['lite', 'pro']) {
    for (const topology of ['single', 'duo']) {
      test(`${tier}/${topology} is wrapped, ordered and complete`, () => {
        const defs = renderToolDefinitions(tier, topology, { reviewer: 'gemini' });
        assert.ok(defs.startsWith('<available_tools>\n'));
        assert.ok(defs.endsWith('</available_tools>'));
        const rendered = [...defs.matchAll(/^## ([a-z_]+)/gm)].map((m) => m[1]);
        assert.deepEqual(rendered, toolNames(topology), 'order or membership drifted');
      });
    }
  }

  test('flash is the cheaper rendering, which is the whole reason it exists', () => {
    const flash = renderToolDefinitions('lite', 'single', {});
    const pro = renderToolDefinitions('pro', 'single', {});
    assert.ok(flash.length < pro.length / 2,
      `flash ${flash.length} vs pro ${pro.length} — flash stopped being compact`);
  });
});

/**
 * Which tiers get the terse tool list.
 *
 * `isFlash` read `tier === 'lite'`, which is false for `flash-thinking` — so
 * the rung whose own description says "still a short prompt" was handed the
 * full 9,786-character block instead of the 2,048 one. 22,538 characters
 * against the 14,800 it should be, on the rung written for a model that
 * follows short prompts and ignores long ones.
 *
 * Nothing caught it, because nothing pinned it: the property held by accident
 * of what that one line said. A typo of intent rather than syntax — "lite"
 * meant the cheap tiers and there turned out to be two of them.
 */
describe('the terse tool list goes to the cheap tiers', () => {
  const size = (tier) => renderToolDefinitions(tier, true).length;

  test('both flash tiers get the same terse block', () => {
    assert.equal(size('lite'), size('flash'),
      'flash-thinking is paying for a tool list it was never meant to carry');
  });

  // The control: it must still be genuinely terse, not "both got the long one".
  test('and pro gets the full one, which is much larger', () => {
    assert.ok(size('pro') > size('lite') * 3,
      `pro is ${size('pro')} against flash's ${size('lite')} — the split has collapsed`);
  });

  test('an unknown tier falls back to the full block, not the terse one', () => {
    // Safer direction to be wrong in: too much guidance costs characters, too
    // little costs a misused tool.
    assert.equal(size('something-new'), size('pro'));
  });
});

/**
 * A parameter the model is never told about cannot be used.
 *
 * The drift check joined `flash` and `pro` and looked for the name in the pair,
 * so a parameter documented in one and missing from the other passed. Five did
 * — `maxResults` on `search_files` and `grep_search`, `maxDepth` on
 * `list_directory`, `timeout` on `run_command`, `lines` on `manage_task` — all
 * invisible to the two flash rungs, which could not reach a feature the tool
 * had. And it only checked `required`, so `manage_task`'s `pattern`, a real
 * implemented option on `watch`, was missing from **both** forms: a working
 * feature nobody was ever told about.
 */
describe('every declared parameter is documented in both forms', () => {
  test('nothing in the registry is undocumented', () => {
    const problems = toolCatalogDrift(registry(), LOOP_DISPATCHED);
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  /*
   * Negative controls, one per branch — without them this passes for a catalog
   * that documents nothing, which is the shape of the bug this check already
   * had once and CLAUDE.md records.
   */
  test('a parameter missing from only the terse form is caught', () => {
    const fake = [{ name: 'read_file', parameters: { notInEitherForm: { required: false } } }];
    const problems = toolCatalogDrift(fake, []);
    assert.ok(problems.some((p) => /flash description/.test(p)), problems.join('\n'));
    assert.ok(problems.some((p) => /pro description/.test(p)), problems.join('\n'));
  });

  test('an optional parameter counts, not only a required one', () => {
    const fake = [{ name: 'read_file', parameters: { someOptional: { required: false } } }];
    assert.ok(toolCatalogDrift(fake, []).length > 0,
      'optional parameters slipping through is how manage_task.pattern stayed unreachable');
  });

  /*
   * A tool whose text is computed used to be filtered out as "not a string",
   * silently exempting it from the check entirely.
   *
   * Only the *parameter* findings are looked at: a one-tool fixture registry
   * makes every other catalogued tool report as undispatched, which is true and
   * has nothing to do with what this asserts.
   */
  test('a computed description is rendered, not skipped', () => {
    const params = (out) => out.filter((p) => /parameter "/.test(p));
    const fake = [{ name: 'ask_subagent', parameters: { role: { required: true } } }];
    assert.deepEqual(params(toolCatalogDrift(fake, ['ask_subagent'])), [],
      'ask_subagent documents `role`, so rendering its function form must find it');

    // The control: a parameter it genuinely does not document must still be
    // caught through the same function-rendering path.
    const bad = [{ name: 'ask_subagent', parameters: { nosuchthing: { required: true } } }];
    assert.ok(params(toolCatalogDrift(bad, ['ask_subagent'])).length > 0);
  });
});
