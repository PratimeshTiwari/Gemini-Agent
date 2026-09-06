/**
 * Which registered element a mouse report lands on.
 *
 * Split out of mouse.jsx so the arithmetic can be tested without a terminal —
 * every pty available under test reports `rows === 0`, which is exactly the
 * input that breaks the offset search.
 *
 * Two conventions matter here and they disagree:
 *   - SGR mouse reports are 1-based, and xterm-mouse passes them through raw.
 *   - `getBoundingClientRect` (@ink-tools/ink-mouse) is also 1-based, and its
 *     rects are half-open: a one-line row at the top is {top: 1, bottom: 2}.
 * So the coordinates line up, but `isPointInRect` from that same package
 * compares `y <= bottom`, which makes every row also match the row above it.
 * Hence the local predicate below.
 */

/**
 * What to write after `Mouse.enable()`, which turns on 1000 + 1002 + 1003 + SGR
 * with no way to opt out.
 *
 * All-motion (1003) puts a report on the wire for every cell the pointer
 * crosses, so it has to go — but `\x1b[?1003l` on its own is not "drop back to
 * button tracking". xterm treats 1000/1002/1003 as a priority ladder and would
 * fall back to 1002; xterm.js — which is VS Code's terminal, and the one this
 * is actually used in — keeps a single `activeProtocol` and sets it to NONE
 * when any of the three is reset. So the lone reset turned tracking fully off
 * a millisecond after enabling it: no click ever reached the app, and the
 * terminal kept handling drags as text selection, which is exactly what it
 * looked like.
 *
 * Re-asserting 1002 afterwards lands on button+drag under both readings.
 */
export const BUTTON_TRACKING = '\x1b[?1003l\x1b[?1002h';

/** Half-open containment: `bottom` and `right` belong to the next cell over. */
export function pointInRect(x, y, rect) {
  if (!rect) return false;
  return x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
}

const area = (rect) => Math.max(0, rect.right - rect.left) * Math.max(0, rect.bottom - rect.top);

/**
 * The one element a click belongs to.
 *
 * Clickable rows nest — a row inside a turn inside the transcript — so a point
 * legitimately falls inside several rects. The innermost is the one the user
 * aimed at, and firing the rest as well is how a single click used to toggle a
 * row and its container together.
 *
 * @param {Array<{rect: object|null}>} candidates
 * @returns {object|null} the winning candidate, or null if the point missed
 */
export function pickTarget(candidates, x, y) {
  let best = null;
  for (const candidate of candidates) {
    if (!pointInRect(x, y, candidate.rect)) continue;
    if (!best || area(candidate.rect) < area(best.rect)) best = candidate;
  }
  return best;
}

/**
 * How far down the screen Ink's frame might start, in rows, best guess first.
 *
 * Mouse coordinates are screen rows; the rects are rows within Ink's frame.
 * Everything <Static> has committed scrolls above that frame, so the two only
 * coincide before the transcript has outgrown the screen. Once it has — the
 * normal case — the frame sits flush with the bottom and the gap is the
 * terminal height minus the frame height.
 *
 * A terminal that reports no height tells us nothing, so don't invent an
 * offset from it: guess flush-to-top and let the rects decide.
 */
export function frameOffsets(frameHeight, terminalRows) {
  if (!frameHeight || !terminalRows) return [0];
  const bottomAnchored = Math.max(0, terminalRows - frameHeight);
  return bottomAnchored > 0 ? [bottomAnchored, 0] : [0];
}
