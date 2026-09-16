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
import { TOOL_CATALOG, toolsFor, toolNames, renderToolDefinitions, toolCatalogDrift }
  from '../../src/core/tool-catalog.js';
import { MCPServer } from '../../src/mcp/mcp-server.js';
import { HEADLESS_SYSTEM_PROMPT } from '../../src/core/agent-loop.js';

/** The five the agent loop dispatches itself; they have no MCP handler. */
const LOOP_DISPATCHED = TOOL_CATALOG.filter((t) => t.dispatch === 'loop').map((t) => t.name);

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

  test('the five loop-dispatched tools are declared', () => {
    for (const name of ['ask_question', 'ask_subagent', 'ask_researcher', 'ask_reviewer', 'manage_memory']) {
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

describe('what each topology is offered', () => {
  test('the reviewer appears only in duo', () => {
    assert.ok(!toolNames('single').includes('ask_reviewer'));
    assert.ok(toolNames('duo').includes('ask_reviewer'));
    assert.equal(toolsFor('single').length + 1, toolsFor('duo').length);
  });

  test('the reviewer block names the model that will actually review', () => {
    const defs = renderToolDefinitions('pro', 'duo', { reviewer: 'chatgpt' });
    assert.match(defs, /Reviewer Subagent \(chatgpt\)/);
  });
});

describe('the rendered block keeps its shape', () => {
  for (const tier of ['flash', 'pro']) {
    for (const topology of ['single', 'duo']) {
      test(`${tier}/${topology} is wrapped, ordered and complete`, () => {
        const defs = renderToolDefinitions(tier, topology, { reviewer: 'chatgpt' });
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
