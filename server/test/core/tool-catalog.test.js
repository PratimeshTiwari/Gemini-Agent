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

/** The five the agent loop dispatches itself; they have no MCP handler. */
/**
 * The loop-dispatched tools, read out of `agent-loop.js` itself.
 *
 * This used to be `TOOL_CATALOG.filter(dispatch === 'loop')` — derived from the
 * catalog and then checked against the catalog, so that half of the drift check
 * could never disagree with itself. The same shape as the `toolCatalogDrift()`
 * bug already recorded in `CLAUDE.md`: an empty list compared to an empty list,
 * green forever.
 *
 * Reading the source is what makes it a check. When `ask_reviewer` and
 * `ask_researcher` were collapsed into one `ask_subagent`, the derived list
 * followed silently and only the hardcoded list below noticed.
 */
const LOOP_DISPATCHED = [...new Set(
  readFileSync(new URL('../../src/core/agent-loop.js', import.meta.url), 'utf8')
    .matchAll(/else if \(call\.name === '([a-z_]+)'/g),
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
  for (const tier of ['flash', 'pro']) {
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
    const flash = renderToolDefinitions('flash', 'single', {});
    const pro = renderToolDefinitions('pro', 'single', {});
    assert.ok(flash.length < pro.length / 2,
      `flash ${flash.length} vs pro ${pro.length} — flash stopped being compact`);
  });
});
