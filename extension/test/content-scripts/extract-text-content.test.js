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
