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

/**
 * The tags nobody listed.
 *
 * The scrape used to be a series of `querySelectorAll` passes finishing with
 * `clone.textContent`, which works for the tags someone thought of and silently
 * mangles the rest. The reported table bug was not a special case — it was the
 * default. Measured on the old version:
 *
 *     <blockquote>      the quote marker vanished
 *     <hr>              vanished entirely
 *     <del>wrong</del>  read as ordinary text — the meaning inverted
 *     <img>             vanished
 *     <details>         "MoreHidden detail"
 *     <dl><dt><dd>      "TermDefinition.After."
 *
 * So these do not test a list of tags. They test the property the old version
 * could not have: **a tag this does not know still comes out readable**, because
 * block elements are separated and inline ones flow.
 */
for (const [label, file] of [['gemini', GEMINI], ['chatgpt', CHATGPT]]) {
  const md = (html) => scrape(file, html);

  test(`${label}: a blockquote keeps its marker`, () => {
    assert.match(md('<blockquote><p>A quoted claim.</p></blockquote><p>After.</p>'),
      /^> A quoted claim\./m);
  });

  test(`${label}: a rule is a rule, not nothing`, () => {
    assert.match(md('<p>Before.</p><hr><p>After.</p>'), /\n---\n/);
  });

  test(`${label}: struck-through text does not read as an assertion`, () => {
    // The worst of the old failures: `<del>wrong</del>` came out as "wrong",
    // so a retraction read as a claim.
    assert.match(md('<p>This is <del>wrong</del> right.</p>'), /~~wrong~~/);
  });

  test(`${label}: an image leaves a reference rather than a gap`, () => {
    assert.match(md('<p>See <img src="/a.png" alt="a diagram"> here.</p>'),
      /!\[a diagram\]\(\/a\.png\)/);
  });

  test(`${label}: a definition list is not one run-on word`, () => {
    const out = md('<dl><dt>Term</dt><dd>Definition.</dd></dl><p>After.</p>');
    assert.ok(!/TermDefinition/.test(out), `still concatenated:\n${out}`);
    assert.match(out, /\*\*Term\*\*/);
  });

  test(`${label}: details and summary separate`, () => {
    const out = md('<details><summary>More</summary><p>Hidden detail.</p></details>');
    assert.ok(!/MoreHidden/.test(out), `still concatenated:\n${out}`);
  });

  test(`${label}: a task list keeps which boxes are ticked`, () => {
    const out = md('<ul><li><input type="checkbox" checked>Done</li>'
      + '<li><input type="checkbox">Todo</li></ul>');
    assert.match(out, /- \[x\] Done/);
    assert.match(out, /- \[ \] Todo/);
  });

  test(`${label}: a bullet list nested in a numbered one`, () => {
    // Three spaces, not two, and the exact number is the whole test. A nested
    // list has to start at or past its parent item's *content* column, which
    // `1. ` puts at three. At two it is below the column, so the parent item
    // closes and the sublist reopens as a sibling of the list — which renders
    // as a flat list. This assertion read ` {2}` until 2026-09-16 and was
    // pinning the bug.
    const out = md('<ol><li>First<ul><li>sub a</li></ul></li><li>Second</li></ol>');
    assert.match(out, /^1\. First/m);
    assert.match(out, /^ {3}- sub a/m);
    assert.match(out, /^2\. Second/m);
  });

  test(`${label}: a numbered list nested in a numbered one`, () => {
    const out = md('<ol><li>Outer<ol><li>Inner</li></ol></li><li>Next</li></ol>');
    assert.match(out, /^1\. Outer/m);
    assert.match(out, /^ {3}1\. Inner/m);
    assert.match(out, /^2\. Next/m);
  });

  test(`${label}: a loose item does not break after its marker`, () => {
    // A loose list item holds block children, and a block child opens with a
    // newline. Landing that straight after the marker leaves the item empty
    // and orphans its own body as a sibling of the list.
    const out = md('<ol><li><p>Run this:</p><pre><code>npm test</code></pre></li></ol>');
    assert.match(out, /^1\. Run this:/m, `the marker was left empty:\n${out}`);
    assert.match(out, /npm test/);
  });

  test(`${label}: a wide marker indents by its own width`, () => {
    // `10. ` is four columns, so nine items in it is not a hypothetical.
    const items = Array.from({ length: 10 }, (_, i) => `<li>item ${i + 1}</li>`).join('');
    const out = md(`<ol>${items.replace('<li>item 10</li>', '<li>item 10<ul><li>deep</li></ul></li>')}</ol>`);
    assert.match(out, /^10\. item 10/m);
    assert.match(out, /^ {4}- deep/m);
  });

  test(`${label}: a numbered list nested in a bullet one`, () => {
    const out = md('<ul><li>Top<ol><li>one</li><li>two</li></ol></li></ul>');
    assert.match(out, /^- Top/m);
    assert.match(out, /^ {2}1\. one/m);
    assert.match(out, /^ {2}2\. two/m);
  });

  test(`${label}: three levels deep`, () => {
    const out = md('<ul><li>A<ul><li>B<ul><li>C</li></ul></li></ul></li></ul>');
    assert.match(out, /^- A/m);
    assert.match(out, /^ {2}- B/m);
    assert.match(out, /^ {4}- C/m);
  });

  test(`${label}: a tag it has never heard of is still separated`, () => {
    // The property, rather than a tag. A custom element between two paragraphs
    // must not weld them together.
    const out = md('<p>a</p><some-widget>widget text</some-widget><p>b</p>');
    assert.ok(!/awidget/.test(out), `unknown block ran into its neighbour:\n${out}`);
    assert.match(out, /widget text/);
  });

  test(`${label}: an inline tag it has never heard of still flows`, () => {
    // The other half: not everything unknown should be given its own line.
    const out = md('<p>a <my-badge>NEW</my-badge> b</p>');
    assert.match(out, /a NEW b/);
  });

  test(`${label}: script and style never reach the reply`, () => {
    const out = md('<p>Visible.</p><script>alert(1)</script><style>.x{color:red}</style>');
    assert.ok(!out.includes('alert'), `script content leaked:\n${out}`);
    assert.ok(!out.includes('color:red'), `style content leaked:\n${out}`);
    assert.match(out, /Visible\./);
  });
}
