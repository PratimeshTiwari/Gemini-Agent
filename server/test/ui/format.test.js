/**
 * format — Unit Tests
 */

import { describe, it, test } from 'node:test';
import assert from 'node:assert';
import { oneLine, summarizeResult, subjectOf, clampForDisplay, formatCommandResult, formatTokenExpiry, renderMarkdown, extractCodeBlocks } from '../../src/ui/format.js';

describe('oneLine', () => {
  it('collapses whitespace to a single line', () => {
    assert.strictEqual(oneLine('a\n  b\t c'), 'a b c');
  });

  it('truncates past the limit with an ellipsis', () => {
    const out = oneLine('abcdefghij', 5);
    assert.strictEqual(out, 'abcd…');
    assert.strictEqual(out.length, 5);
  });

  it('stringifies non-strings', () => {
    assert.strictEqual(oneLine({ a: 1 }), '{"a":1}');
    assert.strictEqual(oneLine(null), '{}');
  });
});

describe('summarizeResult', () => {
  it('counts directory entries', () => {
    assert.strictEqual(summarizeResult('list_directory', { totalDirs: 2, totalFiles: 1 }), '2 dirs, 1 file');
    assert.strictEqual(summarizeResult('list_directory', { children: [1, 2] }), '2 entries');
  });

  it('reports file size in lines', () => {
    assert.strictEqual(summarizeResult('read_file', { totalLines: 1, size: '2kb' }), '1 line · 2kb');
  });

  it('counts matches across the search tools', () => {
    assert.strictEqual(summarizeResult('grep_search', { matchCount: 3 }), '3 matches');
    assert.strictEqual(summarizeResult('search_files', { files: ['a'] }), '1 match');
  });

  it('takes the first line of command output', () => {
    assert.strictEqual(summarizeResult('run_command', { stdout: 'first\nsecond' }), 'first');
  });

  it('names the edited file and its hunks', () => {
    assert.strictEqual(summarizeResult('edit_file', { filePath: '/a/b/c.js', hunkCount: 2 }), '2 hunks in c.js');
    assert.strictEqual(summarizeResult('create_file', { filePath: '/a/b/c.js' }), 'c.js');
  });

  it('falls back to a compact snippet for anything else', () => {
    assert.strictEqual(summarizeResult('unknown_tool', { z: 1 }), '{"z":1}');
  });
});

describe('clampForDisplay', () => {
  it('leaves short output alone', () => {
    assert.strictEqual(clampForDisplay('one\ntwo'), 'one\ntwo');
  });

  it('clamps by line count', () => {
    const out = clampForDisplay('a\nb\nc\nd', 2);
    assert.strictEqual(out, 'a\nb\n... [truncated]');
  });

  it('clamps by character count — one long line is what actually tears the terminal', () => {
    const out = clampForDisplay('x'.repeat(50), 15, 10);
    assert.strictEqual(out, `${'x'.repeat(10)}\n... [truncated]`);
  });

  it('pretty-prints non-strings', () => {
    assert.ok(clampForDisplay({ a: 1 }).includes('"a": 1'));
  });
});


describe('formatCommandResult — a shell result should look like a shell', () => {
  test('shows the command, its output and a non-zero exit', () => {
    const out = formatCommandResult({
      command: 'npm run build',
      exitCode: 1,
      stdout: 'building...',
      stderr: 'Error: Cannot find module ./config',
    });
    assert.match(out, /^\$ npm run build/);
    assert.match(out, /Cannot find module/);
    assert.match(out, /✗ exit 1/);
  });

  test('does not shout about a successful command', () => {
    const out = formatCommandResult({ command: 'git add -A', exitCode: 0, stdout: '', stderr: '' });
    assert.ok(!out.includes('exit'), 'exit 0 is the expected case and needs no marker');
    assert.match(out, /\(no output\)/);
  });

  test('says so when the command timed out', () => {
    const out = formatCommandResult({ command: 'sleep 99', exitCode: -1, stdout: '', timedOut: true });
    assert.match(out, /timed out/);
    assert.ok(!out.includes('(no output)'), 'a timeout explains itself');
  });

  test('clamps a wall of output', () => {
    const out = formatCommandResult({ command: 'cat big', exitCode: 0, stdout: 'line\n'.repeat(500) }, 5);
    assert.ok(out.split('\n').length < 12, 'must not paste 500 lines into the frame');
    assert.match(out, /truncated/);
  });

  test('returns null for anything that is not a shell result', () => {
    // The caller falls back to the generic renderer, so this must not guess.
    assert.equal(formatCommandResult({ path: '.', totalFiles: 8 }), null);
    assert.equal(formatCommandResult('plain string'), null);
    assert.equal(formatCommandResult(null), null);
  });
});

describe('formatTokenExpiry', () => {
  const now = Date.parse('2026-09-10T12:00:00Z');
  const inDays = (n) => new Date(now + n * 86400000).toISOString();

  it('says ok when GitHub reports no expiry at all', () => {
    assert.deepEqual(formatTokenExpiry(null, false, now), { label: 'token ok', tone: 'green' });
  });

  it('says ok while the expiry is comfortably far off', () => {
    assert.deepEqual(formatTokenExpiry(inDays(60), false, now), { label: 'token ok', tone: 'green' });
  });

  it('counts down inside the last week, when it becomes a task', () => {
    assert.deepEqual(formatTokenExpiry(inDays(3), false, now), {
      label: 'token expires in 3d', tone: 'yellow',
    });
  });

  it('calls out the last day', () => {
    assert.equal(formatTokenExpiry(inDays(0.5), false, now).label, 'token expires today');
  });

  it('says expired once the date has passed', () => {
    assert.deepEqual(formatTokenExpiry(inDays(-1), false, now), {
      label: 'token expired', tone: 'red',
    });
  });

  // A revoked token and a lapsed one both come back as 401. Only the date can
  // tell them apart, and once the token is refused the date is beside the point.
  it('a refused token outranks whatever the date said', () => {
    assert.deepEqual(formatTokenExpiry(inDays(60), true, now), {
      label: 'token rejected', tone: 'red',
    });
  });

  it('survives a date it cannot parse', () => {
    assert.equal(formatTokenExpiry('not a date', false, now).tone, 'green');
  });
});

describe('renderMarkdown — the structure Gemini actually writes', () => {
  // `marked-terminal`'s own list renderer rewrites markers a line at a time and
  // cannot tell a nested item's marker from its parent's, so an ordered list
  // renumbered its own children and kept counting. These pin the token walk
  // that replaced it. ANSI is stripped: the colours are not the subject.
  const plain = (md) => renderMarkdown(md, 72).replace(/\x1b\[[0-9;]*m/g, '');

  it('does not renumber a bullet list nested in a numbered one', () => {
    const out = plain('1. Install\n   - with npm\n   - with pnpm\n2. Run it\n');
    assert.match(out, /^1\. Install$/m);
    assert.match(out, /^ {3}\* with npm$/m);
    assert.match(out, /^ {3}\* with pnpm$/m, `the child took the parent's number:\n${out}`);
    assert.match(out, /^2\. Run it$/m, `the parent kept counting through its child:\n${out}`);
  });

  it('numbers a list nested in a numbered one from one', () => {
    const out = plain('1. Outer\n   1. Inner a\n   2. Inner b\n2. Next\n');
    assert.match(out, /^ {3}1\. Inner a$/m);
    assert.match(out, /^ {3}2\. Inner b$/m);
    assert.match(out, /^2\. Next$/m);
  });

  it('indents to the marker width, not a constant', () => {
    const items = Array.from({ length: 10 }, (_, i) => `${i + 1}. item`).join('\n');
    const out = plain(`${items}\n    - deep\n`);
    assert.match(out, /^ {4}\* deep$/m, `a four-column marker was indented as three:\n${out}`);
  });

  it("keeps a task list's boxes", () => {
    const out = plain('- [ ] not done\n- [x] done\n');
    assert.match(out, /\[ \] not done/);
    assert.match(out, /\[X\] done/);
  });

  it('draws an indented fenced block, and numbering continues past it', () => {
    // A fence inside a list item is indented to that item's content column.
    const out = plain('1. Run this:\n\n   ```sh\n   npm test\n   ```\n\n2. Then check.\n');
    assert.match(out, /^npm test$/m, `the block was left indented or undrawn:\n${out}`);
    assert.match(out, /─ sh/, 'the block lost its rules');
    assert.match(out, /^2\. Then check\.$/m);
  });

  it('separates a list from the paragraph above it by one blank line', () => {
    const out = plain('Here is the plan:\n\n1. First\n2. Second\n');
    assert.doesNotMatch(out, /\n\n\n/, `doubled blank lines cost live-frame rows:\n${out}`);
  });
});

describe('extractCodeBlocks', () => {
  it('finds an indented block and hands it back without the indent', () => {
    // `ctrl+y` copies the last block; an indented one used to be invisible to
    // it, and the copy has to be the code, not the code plus a list's indent.
    const [block] = extractCodeBlocks('1. Run:\n\n   ```sh\n   npm test\n   echo ok\n   ```\n');
    assert.equal(block.lang, 'sh');
    assert.equal(block.code, 'npm test\necho ok');
  });

  it('is unchanged for a block at column zero', () => {
    const [block] = extractCodeBlocks('```js\nconst x = 1;\n```\n');
    assert.equal(block.lang, 'js');
    assert.equal(block.code, 'const x = 1;');
  });
});

/**
 * A tool row has to say what it was about.
 *
 * Reported from use, looking at a turn that read a 134-line file and a
 * 1,155-line file: `⏺ read_file · 134 lines · 4.9 KB` names neither, and two
 * identical rows in one turn are indistinguishable. A turn that read four files
 * reads as a turn that did nothing in particular.
 */
describe('subjectOf', () => {
  test('a file tool names its file', () => {
    assert.equal(subjectOf('read_file', { path: 'server/src/ui/transcript.js' }),
      'server/src/ui/transcript.js');
    assert.equal(subjectOf('edit_file', { path: 'a.js' }), 'a.js');
    assert.equal(subjectOf('list_directory', { path: '.' }), '.');
  });

  test('a search names what it searched for', () => {
    assert.equal(subjectOf('grep_search', { pattern: 'TODO' }), 'TODO');
    assert.equal(subjectOf('grep_search', { patterns: ['rate limit', 'throttle'] }),
      'rate limit, throttle');
    assert.equal(subjectOf('find_references', { symbol: '_findMatch' }), '_findMatch');
  });

  test('a command names the command', () => {
    assert.equal(subjectOf('run_command', { command: 'npm test' }), 'npm test');
  });

  // The role, not the prompt. The prompt is a paragraph; the role is the thing
  // that tells two otherwise identical subagent rows apart.
  test('a subagent names its role', () => {
    assert.equal(subjectOf('ask_subagent', { role: 'review', prompt: 'x'.repeat(400) }), 'review');
  });

  /*
   * Paths keep their tail, everything else keeps its head. The live frame cuts
   * a row from the right, so what must survive goes left — but *within* a path
   * the end is the informative half, and `…/ui/transcript.js` beats
   * `server/src/main/java/com/…`.
   */
  test('a long path is truncated from the left', () => {
    const long = 'server/src/main/java/com/example/deeply/nested/Thing.java';
    const out = subjectOf('read_file', { path: long }, 24);

    assert.ok(out.length <= 24, `${out.length} characters`);
    assert.ok(out.startsWith('…'));
    assert.match(out, /Thing\.java$/, 'the basename is what identifies it');
  });

  test('a long command is truncated from the right', () => {
    const out = subjectOf('run_command', { command: 'npm test -- --reporter=tap --concurrency=1 --timeout=99' }, 20);
    assert.ok(out.length <= 20);
    assert.ok(out.startsWith('npm test'), 'a command is read left to right');
    assert.ok(out.endsWith('…'));
  });

  // Silence rather than noise. A tool with nothing worth naming must add
  // nothing to the row — an empty gap reads as a bug.
  test('nothing to name is an empty string, not a placeholder', () => {
    assert.equal(subjectOf('ask_question', { question: 'which?' }), '');
    assert.equal(subjectOf('read_file', {}), '');
    assert.equal(subjectOf('read_file', null), '');
    assert.equal(subjectOf('read_file', { path: '   ' }), '');
    assert.equal(subjectOf(undefined, undefined), '');
  });

  test('newlines never reach the row', () => {
    assert.doesNotMatch(subjectOf('run_command', { command: 'a\nb\nc' }), /\n/);
  });
});

/*
 * The row is drawn in the live frame, where a row that wraps is charged as one
 * and drawn as two — the bug this frame has had twice. Naming the file makes
 * the row longer, so the subject is budgeted against the real width. This pins
 * the arithmetic the component does.
 */
describe('subjectOf fits the row it is drawn in', () => {
  const room = (width, toolName) => Math.max(12, width - toolName.length - 28);

  for (const width of [60, 72, 80, 100]) {
    test(`a long path still leaves room for the rest at ${width} columns`, () => {
      const tool = 'read_file';
      const subject = subjectOf(tool, { path: 'a/'.repeat(60) + 'Thing.java' }, room(width, tool));
      // glyph + tool + space + subject, against the width less the summary's share
      const drawn = 2 + tool.length + 1 + subject.length;
      assert.ok(drawn <= width, `row head was ${drawn} wide in ${width} columns`);
    });
  }

  /*
   * The floor. A narrow terminal must still say *something*, and whatever
   * survives must be the **end** of the path — at 12 characters even
   * `transcript.js` does not fit whole, so "keeps the basename" is not the
   * invariant. "Keeps the tail" is, and it holds at every width.
   */
  test('whatever survives is the end of the path, at any width', () => {
    const path = 'server/src/ui/transcript.js';
    for (const width of [40, 60, 80, 120]) {
      const out = subjectOf('read_file', { path }, room(width, 'read_file'));
      assert.ok(out.length > 0, `nothing at ${width}`);
      assert.ok(path.endsWith(out.replace(/^…/, '')), `${out} is not the tail of the path`);
    }
  });
});
