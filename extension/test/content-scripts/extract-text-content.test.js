/**
 * The code-block scrape, against the two DOM shapes Gemini actually produces.
 *
 * These fixtures are the regression test for the next time gemini.google.com
 * moves: the bug they pin cost a silently truncated reply on every turn that
 * contained code, and it was invisible from the server side because what arrives
 * is well-formed text — just not the text that was on screen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { loadFunction } from '../load-content-script.js';

const here = dirname(fileURLToPath(import.meta.url));
const GEMINI = resolve(here, '../../content-scripts/gemini-bridge.js');
const CHATGPT = resolve(here, '../../content-scripts/chatgpt-bridge.js');

/** Render a fixture and run the shipped `extractTextContent` over it. */
function scrape(file, html) {
  const dom = new JSDOM(`<body><message-content>${html}</message-content></body>`);
  const { document, Node } = dom.window;
  const extract = loadFunction(file, 'extractTextContent', { document, Node });
  return extract(document.querySelector('message-content'));
}

/**
 * Gemini's shape: <code-block> holds a header chip (language label + copy
 * button) and then the <pre><code>. The language attribute is on the inner
 * <code>. The wrapper sits in a container that also holds prose.
 */
const WRAPPED = `
  <p>Here are two ways to do it.</p>
  <div class="code-container">
    <code-block>
      <div class="header"><span>JavaScript</span><button>content_copy</button></div>
      <pre><code data-language="javascript" class="language-javascript">const x = 1;</code></pre>
    </code-block>
    <p>SIBLING PROSE.</p>
  </div>
  <p>Hope that helps.</p>`;

/** The same block with no wrapping container — a direct child of the response. */
const BARE = `
  <p>Here are two ways to do it.</p>
  <code-block>
    <div class="header"><span>JavaScript</span><button>content_copy</button></div>
    <pre><code data-language="javascript" class="language-javascript">const x = 1;</code></pre>
  </code-block>
  <p>TRAILING PROSE.</p>`;

for (const [label, file] of [['gemini', GEMINI], ['chatgpt', CHATGPT]]) {
  test(`${label}: the fence carries the language from the inner <code>`, () => {
    assert.match(scrape(file, WRAPPED), /```javascript\n/);
    assert.match(scrape(file, BARE), /```javascript\n/);
  });

  test(`${label}: the header chip never reaches the code`, () => {
    for (const html of [WRAPPED, BARE]) {
      const out = scrape(file, html);
      assert.doesNotMatch(out, /content_copy/, 'copy button text leaked');
      assert.doesNotMatch(out, /JavaScriptconst/, 'language label welded to line 1');
      assert.match(out, /```javascript\nconst x = 1;\n```/);
    }
  });

  test(`${label}: prose beside the block survives`, () => {
    // The bug replaced the block's *parent*, taking the parent's other children
    // with it. This is the assertion that fails on the old implementation.
    assert.match(scrape(file, WRAPPED), /SIBLING PROSE\./);
    assert.match(scrape(file, BARE), /TRAILING PROSE\./);
    assert.match(scrape(file, WRAPPED), /Hope that helps\./);
  });

  test(`${label}: a <pre> with no <code> still fences`, () => {
    const out = scrape(file, '<pre>plain block</pre>');
    assert.match(out, /```\nplain block\n```/);
  });

  test(`${label}: inline code is left to the inline pass`, () => {
    const out = scrape(file, '<p>call <code>foo()</code> first</p>');
    assert.match(out, /`foo\(\)`/);
    assert.doesNotMatch(out, /```/);
  });
}

/**
 * Structure the scrape was throwing away: tables and nested lists.
 *
 * Reported from use, with the Gemini tab and the CLI side by side. A
 * three-column comparison table arrived as
 * `FactorNative API Agents (Claude Code, Aider)Gemini-Agent (Browser Bridge)Cost…`
 * — every cell concatenated, because nothing handled `<table>` at all and
 * `clone.textContent` simply runs the cells together. And a two-level bullet
 * list came out flat, because `li.prepend('- ')` gives the same prefix at every
 * depth.
 *
 * Both are losses the server cannot detect: what arrives is well-formed text,
 * just not the text that was on screen.
 */

/** The shape Gemini produces for a comparison table. */
const TABLE = `
  <p>Here is the comparison.</p>
  <table>
    <thead><tr><th>Factor</th><th>Native API</th><th>Browser Bridge</th></tr></thead>
    <tbody>
      <tr><td>Cost</td><td>Metered ($)</td><td>Free</td></tr>
      <tr><td>Fragility</td><td>Low</td><td>High</td></tr>
    </tbody>
  </table>
  <p>That is the trade-off.</p>`;

/** Two levels of bullets, which is how Gemini writes anything structured. */
// Written with no whitespace between tags, the way a real DOM is. Pretty-printed
// HTML puts the indentation into text nodes, and a nested item then *looks*
// indented in the output whatever the scrape did — which is a test that passes
// for the wrong reason.
const NESTED = '<ul>'
  + '<li>Zero Inference Costs: no per-token fees.</li>'
  + '<li>Thoughtful Safety:<ul>'
  + '<li>Diff Engine: edits produce structured diffs.</li>'
  + '<li>Risk Classifier: commands are evaluated first.</li>'
  + '</ul></li>'
  + '<li>Full Local Tooling: ripgrep, git, subagents.</li>'
  + '</ul>';

const ORDERED = `<ol><li>First step</li><li>Second step</li></ol>`;

for (const [label, file] of [['gemini', GEMINI], ['chatgpt', CHATGPT]]) {
  test(`${label}: a table survives as a table`, () => {
    const out = scrape(file, TABLE);
    // The cells must not be run together — that is the reported bug.
    assert.ok(!/FactorNative/.test(out), `cells were concatenated:\n${out}`);
    // Markdown pipe rows, which marked-terminal already knows how to draw.
    assert.match(out, /\|\s*Factor\s*\|\s*Native API\s*\|\s*Browser Bridge\s*\|/);
    assert.match(out, /\|\s*-+\s*\|/, 'no header separator, so it is not a table');
    assert.match(out, /\|\s*Cost\s*\|\s*Metered \(\$\)\s*\|\s*Free\s*\|/);
    assert.match(out, /\|\s*Fragility\s*\|\s*Low\s*\|\s*High\s*\|/);
  });

  test(`${label}: prose either side of a table is kept`, () => {
    const out = scrape(file, TABLE);
    assert.match(out, /Here is the comparison\./);
    assert.match(out, /That is the trade-off\./);
  });

  test(`${label}: nested bullets keep their depth`, () => {
    const out = scrape(file, NESTED);
    const line = (needle) => out.split('\n').find((l) => l.includes(needle)) ?? '';
    const top = line('Zero Inference Costs');
    const sub = line('Diff Engine');
    assert.match(top, /^-\s/, `top-level item was indented: ${JSON.stringify(top)}`);
    assert.match(sub, /^\s{2,}-\s/, `nested item was not indented: ${JSON.stringify(sub)}`);
  });

  test(`${label}: a parent item keeps its own text`, () => {
    // The nested <ul> lives inside the parent <li>, so a naive fix drops the
    // parent's own words or repeats the children under it twice.
    const out = scrape(file, NESTED);
    assert.match(out, /Thoughtful Safety/);
    assert.equal((out.match(/Diff Engine/g) || []).length, 1, 'the child was emitted twice');
  });

  test(`${label}: an ordered list is numbered, not bulleted`, () => {
    const out = scrape(file, ORDERED);
    assert.match(out, /1\.\s*First step/);
    assert.match(out, /2\.\s*Second step/);
  });
}
