import { test, describe } from 'node:test';
import assert from 'node:assert';
import { summarizeDiff, previewRows } from './diff-preview.js';

const hunk = (lines, oldStart = 1, newStart = 1) => ({
  oldStart, oldLines: lines.length, newStart, newLines: lines.length, lines,
});

describe('summarizeDiff', () => {
  test('counts additions and removals across hunks', () => {
    const stats = summarizeDiff([
      hunk([' ctx', '-gone', '+new', '+also new']),
      hunk(['-another']),
    ]);
    assert.deepStrictEqual(stats, { hunks: 2, added: 2, removed: 2 });
  });

  test('empty and malformed input counts as nothing, not a throw', () => {
    assert.deepStrictEqual(summarizeDiff(), { hunks: 0, added: 0, removed: 0 });
    assert.deepStrictEqual(summarizeDiff([{}]), { hunks: 1, added: 0, removed: 0 });
  });
});

describe('previewRows', () => {
  test('each hunk gets a header and its lines, tagged for colouring', () => {
    const rows = previewRows([hunk([' ctx', '-gone', '+new'], 10, 10)]);
    assert.strictEqual(rows[0].type, 'header');
    assert.match(rows[0].text, /@@ -10,3 \+10,3 @@/);
    assert.deepStrictEqual(rows.slice(1).map(r => r.type), ['ctx', 'del', 'add']);
  });

  test('a long hunk keeps the changes and drops the context', () => {
    const lines = [
      ...Array.from({ length: 20 }, (_, i) => ` context ${i}`),
      '-removed',
      '+added',
    ];
    const rows = previewRows([hunk(lines)], { maxLines: 4 });
    const kept = rows.filter(r => r.type === 'add' || r.type === 'del');
    assert.strictEqual(kept.length, 2, 'the +/- lines are the point of the preview');
    assert.ok(rows.some(r => r.type === 'more'), 'and the reader is told something was dropped');
  });

  test('a big edit cannot push the approval buttons off screen', () => {
    const many = Array.from({ length: 40 }, (_, i) => hunk(['-a', '+b'], i, i));
    const rows = previewRows(many, { maxLines: 16 });
    const body = rows.filter(r => r.type !== 'header' && r.type !== 'more');
    assert.ok(body.length <= 16, `${body.length} body rows exceeds the cap`);
    assert.strictEqual(rows[rows.length - 1].type, 'more');
    assert.match(rows[rows.length - 1].text, /more hunks/);
  });

  test('no hunks means no preview, not an empty frame of headers', () => {
    assert.deepStrictEqual(previewRows([]), []);
    assert.deepStrictEqual(previewRows(), []);
  });
});
