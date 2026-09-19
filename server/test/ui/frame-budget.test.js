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
const budget = (height, extras = 0) =>
  Math.max(1, height - reservedRows(height) - extras);

/** Furniture plus the turn: what Ink is asked to draw. */
const frameHeight = (height, extras = 0) => reservedRows(height) + extras + budget(height, extras);

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

  test('the floor is one row, not three', () => {
    // A floor of 3 does not mean "at least three if there is room" — it means
    // "three even when there is not", and the frame then asks for more rows
    // than the terminal has. It was the bug twice: once from the furniture,
    // once from the notice rows. Whenever there *is* room the subtraction
    // already yields more than three, so flooring at 1 loses nothing.
    assert.ok(budget(10) >= 1, 'the turn still gets a row to draw in');
    assert.equal(frameHeight(10), 10);
    assert.equal(budget(13, 2), 2, 'a floor of 3 here overflows a 13-row terminal');
  });

  test('the turn keeps a real share of an ordinary terminal', () => {
    // Shedding spacing must not become a way to give the transcript less room
    // where there was room all along.
    assert.equal(budget(24), 15);
    assert.equal(budget(40), 31);
  });
});

describe('the notice rows are charged for', () => {
  /**
   * `/update` can draw two one-line notices at the top of the live frame: one
   * for an available update, one for reload steps waiting to be acknowledged.
   * A row that draws without being budgeted is how the frame outgrows the
   * viewport — which is the single most important rule in `ui/`.
   */
  test('one notice still fits, at every height', () => {
    for (let height = 9; height <= 60; height += 1) {
      assert.ok(frameHeight(height, 1) <= height,
        `${height} rows with one notice: frame would be ${frameHeight(height, 1)}`);
    }
  });

  test('both notices still fit, at every height', () => {
    for (let height = 9; height <= 60; height += 1) {
      assert.ok(frameHeight(height, 2) <= height,
        `${height} rows with two notices: frame would be ${frameHeight(height, 2)}`);
    }
  });

  /*
   * Three now, not two: the model-mismatch warning joined them on 2026-09-20.
   * `CLAUDE.md` records the two `/update` rows reproducing the clear-and-repaint
   * path at 13 rows before the floor came down — so a third is exactly the kind
   * of addition that needs the arithmetic checked rather than assumed.
   */
  test('all three notices fit wherever three can be drawn', () => {
    for (let height = COMPACT_BELOW_ROWS; height <= 60; height += 1) {
      assert.ok(frameHeight(height, 3) <= height,
        `${height} rows with three notices: frame would be ${frameHeight(height, 3)}`);
    }
  });

  /*
   * And they cannot all be drawn below that, which is why `App.jsx` sheds the
   * model-mismatch row there. This is the assertion that says the shedding is
   * *required* rather than a preference — delete the guard and the frame is one
   * row taller than a 9-row terminal, which is the clear-and-repaint path.
   */
  test('three do NOT fit a compact terminal — hence the guard', () => {
    assert.ok(frameHeight(9, 3) > 9,
      'if this ever fits, the shed in App.jsx can go');
  });

  test('two still fit there, which is what is left after shedding', () => {
    for (let height = 9; height < COMPACT_BELOW_ROWS; height += 1) {
      assert.ok(frameHeight(height, 2) <= height, `${height} rows with two notices`);
      assert.ok(budget(height, 2) >= 1, `${height} rows: budget ${budget(height, 2)}`);
    }
  });

  test('a notice costs the turn a row, rather than being drawn for free', () => {
    assert.equal(budget(24, 0) - budget(24, 1), 1);
    assert.equal(budget(24, 0) - budget(24, 2), 2);
    assert.equal(budget(24, 0) - budget(24, 3), 3);
  });

  test('at the floor the turn keeps a row and the frame still fits', () => {
    // The notices cannot push the in-flight turn to nothing.
    assert.ok(budget(10, 2) >= 1);
    assert.ok(frameHeight(10, 2) <= 10);
  });
});
