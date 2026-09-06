import { test, describe } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import { render, Box, Text } from 'ink';
import { getBoundingClientRect } from '@ink-tools/ink-mouse';
import { pointInRect, pickTarget, frameOffsets, BUTTON_TRACKING } from './hit-test.js';

const rect = (top, height, left = 1, width = 80) => ({
  top, bottom: top + height, left, right: left + width,
  x: left, y: top, width, height,
});

describe('pointInRect', () => {
  test('a one-line row owns its own line and nothing else', () => {
    const row = rect(1, 1);
    assert.ok(pointInRect(5, 1, row));
    assert.ok(!pointInRect(5, 0, row));
    assert.ok(!pointInRect(5, 2, row), 'bottom is the next row, not this one');
  });

  test('columns are half-open too', () => {
    const row = rect(1, 1, 1, 10);
    assert.ok(pointInRect(1, 1, row));
    assert.ok(pointInRect(10, 1, row));
    assert.ok(!pointInRect(11, 1, row));
  });

  test('a missing rect is a miss, not a throw', () => {
    assert.ok(!pointInRect(1, 1, null));
  });
});

describe('pickTarget', () => {
  test('adjacent rows never both match — the bug that made clicks feel dead', () => {
    const rows = [
      { name: 'a', rect: rect(1, 1) },
      { name: 'b', rect: rect(2, 1) },
      { name: 'c', rect: rect(3, 1) },
    ];
    assert.strictEqual(pickTarget(rows, 5, 1).name, 'a');
    assert.strictEqual(pickTarget(rows, 5, 2).name, 'b');
    assert.strictEqual(pickTarget(rows, 5, 3).name, 'c');
  });

  test('the innermost element wins when rows nest inside a container', () => {
    const candidates = [
      { name: 'turn', rect: rect(1, 6) },
      { name: 'row', rect: rect(3, 1) },
    ];
    assert.strictEqual(pickTarget(candidates, 5, 3).name, 'row');
    assert.strictEqual(pickTarget(candidates, 5, 5).name, 'turn');
  });

  test('a miss returns null rather than the nearest thing', () => {
    assert.strictEqual(pickTarget([{ name: 'a', rect: rect(1, 1) }], 5, 9), null);
  });
});

describe('frameOffsets', () => {
  test('a frame shorter than the screen is bottom-anchored, with no-offset as fallback', () => {
    assert.deepStrictEqual(frameOffsets(3, 20), [17, 0]);
  });

  test('a frame filling the screen needs no offset', () => {
    assert.deepStrictEqual(frameOffsets(20, 20), [0]);
  });

  test('a terminal reporting no height invents no offset', () => {
    // Every pty available under test reports rows === 0. Deriving an offset
    // from that used to shift every hit test by the frame height.
    assert.deepStrictEqual(frameOffsets(3, 0), [0]);
    assert.deepStrictEqual(frameOffsets(3, undefined), [0]);
  });
});

describe('against real Ink geometry', () => {
  // Renders actual Boxes and hit-tests the rects yoga computes, so the
  // half-open assumption above is checked against the library, not restated.
  test('each stacked row is hit exactly once, by itself', async () => {
    const rects = await new Promise((resolve) => {
      const refs = [React.createRef(), React.createRef(), React.createRef()];
      function Probe() {
        React.useEffect(() => {
          resolve(refs.map((r) => getBoundingClientRect(r.current)));
        }, []);
        return React.createElement(
          Box, { flexDirection: 'column' },
          ...refs.map((ref, i) =>
            React.createElement(Box, { key: i, ref }, React.createElement(Text, null, `row ${i}`))),
        );
      }
      const stdout = { write() {}, columns: 80, rows: 20, on() {}, off() {}, removeListener() {} };
      const app = render(React.createElement(Probe), { stdout, patchConsole: false });
      app.unmount();
    });

    const candidates = rects.map((r, i) => ({ name: `row${i}`, rect: r }));
    for (let i = 0; i < rects.length; i++) {
      const hit = pickTarget(candidates, 5, rects[i].top);
      assert.ok(hit, `row ${i} at y=${rects[i].top} hit nothing`);
      assert.strictEqual(hit.name, `row${i}`,
        `y=${rects[i].top} resolved to ${hit.name}; rects=${JSON.stringify(rects)}`);
    }
  });
});

describe('the tracking sequence written after enable()', () => {
  // xterm-mouse's enable() turns on 1000 + 1002 + 1003 + SGR. Suppressing the
  // motion spam with a bare `1003l` reset the whole protocol to NONE under
  // xterm.js (VS Code's terminal), so no click ever reached the app.
  test('ends by asserting a tracking mode, never by disabling one', () => {
    assert.ok(BUTTON_TRACKING.endsWith('h'), `sequence ends in a reset: ${JSON.stringify(BUTTON_TRACKING)}`);
  });

  test('drops all-motion and re-asserts button+drag', () => {
    assert.ok(BUTTON_TRACKING.includes('[?1003l'), 'all-motion should be turned off');
    assert.ok(BUTTON_TRACKING.includes('[?1002h'), 'button+drag should be turned back on');
    assert.ok(
      BUTTON_TRACKING.indexOf('[?1003l') < BUTTON_TRACKING.indexOf('[?1002h'),
      'the re-assert has to come after the reset, or the reset wins',
    );
  });
});
