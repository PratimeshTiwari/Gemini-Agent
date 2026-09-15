/**
 * Code blocks you can actually copy.
 *
 * `marked-terminal` was configured `tab: 2`, so every line of every fenced
 * block was written with two leading spaces — and a terminal drag-select takes
 * those spaces with it. Every code block this agent produced had to be
 * re-indented by hand after pasting it anywhere.
 *
 * There is no clickable copy button and there cannot be one: that needs mouse
 * tracking, and a terminal that is tracking hands the app the wheel and
 * suppresses drag-select. Fixing the copy by adding a button would remove the
 * selection the button was meant to replace. So: no indent, an edge marked by a
 * rule on its own line, and `ctrl+y` for the common case.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { renderMarkdown, extractCodeBlocks } from '../../src/ui/format.js';

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const lines = (md) => strip(renderMarkdown(md)).split('\n');

const SAMPLE = [
  'Here is the fix:',
  '',
  '```js',
  'const x = 1;',
  'function go() {',
  '  return x;',
  '}',
  '```',
  '',
  'And prose after.',
].join('\n');

describe('a drag-select picks up the code and nothing else', () => {
  test('no line of code is indented', () => {
    const body = lines(SAMPLE);
    assert.ok(body.includes('const x = 1;'), 'the first line kept an indent');
    assert.ok(body.includes('function go() {'));
    // The block's own indentation is the code's, and must survive.
    assert.ok(body.includes('  return x;'), 'the code\'s own indentation was eaten');
  });

  test('prose either side of a block is kept', () => {
    const body = lines(SAMPLE);
    assert.ok(body.includes('Here is the fix:'));
    assert.ok(body.includes('And prose after.'));
  });

  test('the edges are their own lines, so a drag can avoid them', () => {
    const body = lines(SAMPLE);
    const first = body.findIndex((l) => l.startsWith('─'));
    assert.ok(first >= 0, 'no rule was drawn');
    assert.ok(/^─ js ─+$/.test(body[first]), `top rule was ${JSON.stringify(body[first])}`);
    assert.equal(body[first + 1], 'const x = 1;', 'the rule is on the same line as code');
    const last = body.findLastIndex((l) => /^─+$/.test(l));
    assert.equal(body[last - 1], '}', 'the closing rule is not directly under the block');
  });

  test('the rules are the same width, and never wider than the code', () => {
    const body = lines(SAMPLE);
    const rules = body.filter((l) => /^─/.test(l));
    assert.equal(rules.length, 2);
    assert.equal(rules[0].length, rules[1].length);
    const longest = Math.max(...['const x = 1;', 'function go() {', '  return x;', '}'].map((l) => l.length));
    assert.ok(rules[0].length <= Math.max(longest, 8),
      'a rule wider than its block can wrap where the block does not');
  });

  test('the language is shown, because the scrape now keeps it', () => {
    assert.match(strip(renderMarkdown('```python\nx = 1\n```')), /─ python ─/);
  });

  test('a block with no language still gets a solid rule', () => {
    const body = lines('```\nplain text here\n```');
    const rules = body.filter((l) => /^─+$/.test(l));
    assert.equal(rules.length, 2, 'an unlabelled block lost an edge');
  });
});

describe('the document survives the round trip', () => {
  test('a list containing a fenced block stays one list', () => {
    // Rendering segments separately instead of stashing them is what breaks
    // this: the list restarts either side of the code.
    const md = '- first\n- second\n\n```js\nx\n```\n\n- third';
    const body = lines(md);
    assert.ok(body.some((l) => l.includes('first')));
    assert.ok(body.some((l) => l.includes('third')));
    assert.ok(body.includes('x'));
  });

  test('a sentinel that leaks is a code block deleted', () => {
    assert.doesNotMatch(strip(renderMarkdown(SAMPLE)), /codeblock/i);
  });

  test('prose that merely looks like a sentinel is left alone', () => {
    assert.match(strip(renderMarkdown('see x0codeblock7x0 in the log')), /x0codeblock7x0/);
  });

  test('an unterminated fence is not silently swallowed', () => {
    assert.match(strip(renderMarkdown('```js\nconst x = 1;')), /const x = 1;/);
  });
});

describe('extractCodeBlocks — what ctrl+y copies', () => {
  test('every block, in order, without the fences', () => {
    const blocks = extractCodeBlocks(SAMPLE + '\n\n```sh\nnpm test\n```');
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].lang, 'js');
    assert.equal(blocks[0].code, 'const x = 1;\nfunction go() {\n  return x;\n}');
    assert.equal(blocks[1].lang, 'sh');
    assert.equal(blocks[1].code, 'npm test');
  });

  test('no blocks, no crash', () => {
    assert.deepEqual(extractCodeBlocks('just prose'), []);
    assert.deepEqual(extractCodeBlocks(undefined), []);
  });

  test('the copied text carries no indentation of ours', () => {
    const [block] = extractCodeBlocks('```\n  already indented\n```');
    assert.equal(block.code, '  already indented');
  });
});

describe('nested lists and copyable code blocks, which fought over one setting', () => {
  /**
   * `tab` indents lists *and* code blocks in `marked-terminal`, and the two
   * wanted opposite things. It was set to 0 so a drag-select over a fenced
   * block would not take two spaces with it — and that flattened every nested
   * list, reported from use with the Gemini tab and the CLI side by side.
   *
   * It is 2 again, and the code blocks are still clean, because they no longer
   * reach `marked` at all: `renderMarkdown` lifts fenced blocks out first.
   * These two tests are the conflict, so it cannot be resolved by halves again.
   */
  const NESTED = 'Intro.\n\n- Top one\n- Parent:\n  - Child A\n  - Child B\n\nAfter.';

  test('a nested bullet is drawn deeper than its parent', () => {
    const body = lines(NESTED);
    const top = body.find((l) => l.includes('Top one')) ?? '';
    const child = body.find((l) => l.includes('Child A')) ?? '';
    const indent = (l) => l.length - l.trimStart().length;
    assert.ok(indent(child) > indent(top),
      `child indented ${indent(child)}, parent ${indent(top)} — the nesting was flattened`);
  });

  test('and the code in a block is still flush left', () => {
    // The other half. If someone sets tab back to 0 to fix a list, this fails.
    const body = lines('- a list item\n\n```js\nconst x = 1;\n```');
    assert.ok(body.includes('const x = 1;'),
      'the code block picked up an indent, so a drag-select takes it too');
  });

  test('both at once, which is the case that was broken', () => {
    const body = lines(NESTED + '\n\n```js\nconst x = 1;\n```');
    assert.ok(body.includes('const x = 1;'));
    const child = body.find((l) => l.includes('Child A')) ?? '';
    assert.ok(child.startsWith(' '), 'the nested item lost its indent');
  });
});
