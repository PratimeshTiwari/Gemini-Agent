/**
 * The scrape, as a property rather than a list of fixtures.
 *
 * The site renders the model's markdown into HTML and we scrape that HTML back
 * into markdown, so the walker's job is to *invert a markdown renderer*. That
 * is testable directly: md -> HTML -> extractTextContent -> md', then render
 * both to HTML and compare. Anything the walker drops shows up as a difference
 * in meaning, and surface choices (`*` vs `-`, how many blank lines) do not
 * count because both sides go through the renderer again.
 *
 * `marked` stands in for the site's renderer. It is not the same renderer —
 * that is what `extract-text-content.test.js` is for, with fixtures of the DOM
 * Gemini and ChatGPT actually emit. The split is deliberate: those fixtures
 * pin the shapes we have seen, and this pins the general property, which is
 * the half that catches a construct nobody thought to write a fixture for.
 *
 * This found four real losses on the day it was written, all of them list
 * nesting under a numbered parent — see the LI branch in the bridges.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { marked } from 'marked';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { loadFunction } from '../load-content-script.js';

const here = dirname(fileURLToPath(import.meta.url));
const BRIDGES = {
  gemini: resolve(here, '../../content-scripts/gemini-bridge.js'),
  chatgpt: resolve(here, '../../content-scripts/chatgpt-bridge.js'),
};

function scrape(file, html) {
  const dom = new JSDOM(`<body><message-content>${html}</message-content></body>`);
  const { document, Node } = dom.window;
  const extract = loadFunction(file, 'extractTextContent', { document, Node });
  return extract(document.querySelector('message-content'));
}

/** Compare meaning, not layout. */
const meaning = (md) => marked.parse(md).replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim();

const CASES = {
  'inline marks': 'A paragraph with **bold**, *italic*, `code` and a [link](https://x.dev).',
  'headings': '# One\n\nText.\n\n## Two\n\nMore.\n\n### Three\n\nEnd.',
  'bullet list': '- first\n- second\n- third',
  'numbered list': '1. first\n2. second\n3. third',
  'nested bullets': '- outer\n  - inner\n    - deepest\n- outer two',
  'bullets under a number': '1. Install it\n   - with npm\n   - with pnpm\n2. Run it',
  'numbers under a number': '1. Outer\n   1. Inner one\n   2. Inner two\n2. Outer two',
  'table': '| Col | Meaning |\n| --- | --- |\n| a | first |\n| b | second |',
  'table of inline code': '| Flag | What |\n| --- | --- |\n| `-v` | verbose |\n| `-q` | quiet |',
  'code block': '```js\nconst x = 1;\nif (x) { return; }\n```',
  'code block in a list': '1. Run this:\n\n   ```sh\n   npm test\n   ```\n\n2. Then this.',
  'blockquote': '> A quoted line.\n> And another.',
  'task list': '- [ ] not done\n- [x] done',
  'horizontal rule': 'Above.\n\n---\n\nBelow.',
  'all of it at once': '## Results\n\nThree things:\n\n1. **First** — see `a.js`\n'
    + '   - a detail\n2. **Second**\n\n| n | v |\n| --- | --- |\n| 1 | x |\n\n'
    + '```js\nfoo();\n```\n\n> Note this.',
};

for (const [label, file] of Object.entries(BRIDGES)) {
  describe(`${label}: markdown survives the round trip`, () => {
    for (const [name, md] of Object.entries(CASES)) {
      test(name, () => {
        const recovered = scrape(file, marked.parse(md));
        assert.equal(
          meaning(recovered),
          meaning(md),
          `structure was lost.\n\n--- sent ---\n${md}\n\n--- recovered ---\n${recovered}\n`,
        );
      });
    }
  });
}
