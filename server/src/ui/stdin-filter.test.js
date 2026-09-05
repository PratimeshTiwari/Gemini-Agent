/**
 * Mouse-report filter — Unit Tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createMouseSequenceFilter } from './stdin-filter.js';

const SGR_MOVE = '\x1b[<35;73;20M';
const SGR_RELEASE = '\x1b[<0;12;4m';

describe('createMouseSequenceFilter', () => {
  it('passes ordinary typed text through untouched', () => {
    const filter = createMouseSequenceFilter();
    assert.strictEqual(filter.feed('/help'), '/help');
  });

  it('drops a complete SGR report', () => {
    const filter = createMouseSequenceFilter();
    assert.strictEqual(filter.feed(SGR_MOVE), '');
  });

  it('drops several reports and keeps the text between them', () => {
    const filter = createMouseSequenceFilter();
    assert.strictEqual(filter.feed(`a${SGR_MOVE}b${SGR_RELEASE}c`), 'abc');
  });

  it('drops the legacy X10 report', () => {
    const filter = createMouseSequenceFilter();
    assert.strictEqual(filter.feed('\x1b[M abc'), 'c');
  });

  it('reassembles a report split across two reads', () => {
    const filter = createMouseSequenceFilter();
    assert.strictEqual(filter.feed('a\x1b[<35;7'), 'a');
    assert.strictEqual(filter.pending(), '\x1b[<35;7');
    assert.strictEqual(filter.feed('3;20Mb'), 'b');
    assert.strictEqual(filter.pending(), '');
  });

  it('holds a report split immediately after the ESC byte', () => {
    const filter = createMouseSequenceFilter();
    assert.strictEqual(filter.feed('\x1b'), '');
    assert.strictEqual(filter.feed('[<35;73;20M'), '');
  });

  it('passes arrow keys and other escape sequences through', () => {
    const filter = createMouseSequenceFilter();
    assert.strictEqual(filter.feed('\x1b[A'), '\x1b[A');
    assert.strictEqual(filter.feed('\x1b[B\x1b[C'), '\x1b[B\x1b[C');
  });

  it('releases a held Escape once the flush timeout expires', async () => {
    const flushed = [];
    const filter = createMouseSequenceFilter({
      flushDelayMs: 1,
      onFlush: (text) => flushed.push(text),
    });

    assert.strictEqual(filter.feed('\x1b'), '');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepStrictEqual(flushed, ['\x1b']);
    assert.strictEqual(filter.pending(), '');
  });

  it('flush() returns the held fragment synchronously', () => {
    const filter = createMouseSequenceFilter();
    filter.feed('\x1b[<35');
    assert.strictEqual(filter.flush(), '\x1b[<35');
    assert.strictEqual(filter.pending(), '');
  });

  it('accepts Buffers as well as strings', () => {
    const filter = createMouseSequenceFilter();
    assert.strictEqual(filter.feed(Buffer.from(`x${SGR_MOVE}y`, 'utf8')), 'xy');
  });
});
