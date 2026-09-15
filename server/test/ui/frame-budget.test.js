/**
 * The frame may not outgrow the viewport, at any height.
 *
 * When Ink's dynamic output is taller than the terminal it switches to writing
 * `ESC[2J ESC[3J` plus a full repaint on *every* render — which is what
 * "it flickers and I can't scroll or copy" was: the terminal's scrollback and
 * the user's selection deleted several times a second.
 *
 * `RESERVED_ROWS` and the conditional rows in `App.jsx` handle that from above.
 * What they could not handle was from *below*: `liveBudget` has a floor, so the
 * frame had a minimum height of `RESERVED_ROWS + 3 = 12` and any terminal
 * shorter than that overflowed however much the in-flight turn gave up.
 * Measured under a pty with one turn, extension connected, no palette:
 * 13 rows → 0 clears, 12 → 1, 10 → **166**.
 *
 * These are the arithmetic half of that measurement. The pty sweep is the other
 * half and cannot live here; `UX-PLAN.md` has the recipe.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { RESERVED_ROWS, COMPACT_BELOW_ROWS, reservedRows, isCompactHeight } from '../../src/ui/constants.js';

/** What App.jsx computes, with no conditional rows in play. */
const budget = (height) =>
  Math.max(isCompactHeight(height) ? 1 : 3, height - reservedRows(height));

/** Furniture plus the turn: what Ink is asked to draw. */
const frameHeight = (height) => reservedRows(height) + budget(height);

describe('the live frame fits the viewport at every usable height', () => {
  test('an ordinary terminal keeps all nine furniture rows', () => {
    assert.equal(reservedRows(24), RESERVED_ROWS);
    assert.equal(reservedRows(COMPACT_BELOW_ROWS), RESERVED_ROWS);
    assert.equal(isCompactHeight(24), false);
  });

  test('below the threshold the three blank rows are dropped, nothing else', () => {
    assert.equal(reservedRows(COMPACT_BELOW_ROWS - 1), RESERVED_ROWS - 3);
    assert.equal(isCompactHeight(COMPACT_BELOW_ROWS - 1), true);
  });

  test('the frame never exceeds the terminal, 9 rows and up', () => {
    for (let height = 9; height <= 60; height += 1) {
      assert.ok(
        frameHeight(height) <= height,
        `${height} rows: frame would be ${frameHeight(height)} — Ink clears the screen on every render`,
      );
    }
  });

  test('the floor comes down with the furniture, or it overflows anyway', () => {
    // The whole bug: a floor of 3 on a 10-row terminal asks for 6 + 3 = 9 and
    // that fits, but a floor of 3 against nine rows of furniture asks for 12.
    assert.ok(budget(10) >= 1, 'the turn still gets a row to draw in');
    assert.equal(frameHeight(10), 10);
  });

  test('the turn keeps a real share of an ordinary terminal', () => {
    // Shedding spacing must not become a way to give the transcript less room
    // where there was room all along.
    assert.equal(budget(24), 15);
    assert.equal(budget(40), 31);
  });
});
