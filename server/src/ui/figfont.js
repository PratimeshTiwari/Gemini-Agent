/**
 * The banner, without twenty megabytes of fonts.
 *
 * `figlet` is 20.8MB — 328 fonts across `fonts/` and `importable-fonts/` —
 * and this app renders exactly one of them, `Standard`, at two call sites.
 * That was 21% of `node_modules` for a wordmark. The font itself is 30KB and
 * is vendored next to this file; what was missing was a renderer.
 *
 * Only what `Standard` actually needs is implemented. Its header is
 * `flf2a$ 6 5 16 15 13 0 24463 229`, and 24463 sets horizontal smushing with
 * rules 1, 2, 4 and 8 — equal character, underscore, hierarchy and opposite
 * pair. The vertical rules it also sets never come into play, because the
 * banner is one line of text. Big-X and hardblank smushing are not set, so
 * they are not here.
 *
 * Correctness is not argued, it is compared: `figfont.test.js` renders a
 * corpus through this and through `figlet` and requires the bytes to match.
 */

/** The characters a FIGfont file stores, in order, from the space. */
const FIRST_CODE = 32;
const LAST_CODE = 126;

/** `_` may be replaced by any of these (rule 2). */
const UNDERSCORE_PARTNERS = '|/\\[]{}()<>';

/** Rule 3: a class later in this list overrides an earlier one. */
const HIERARCHY = ['|', '/\\', '[]', '{}', '()', '<>'];

/** Rule 4: these pairs, in either order, become a vertical bar. */
const OPPOSITE_PAIRS = new Set(['[]', '][', '{}', '}{', '()', ')(']);

function hierarchyClass(ch) {
  for (let i = 0; i < HIERARCHY.length; i += 1) if (HIERARCHY[i].includes(ch)) return i;
  return -1;
}

/**
 * What two touching characters become, or null if they cannot touch.
 *
 * Order matters: the rules are tried as the FIGfont spec numbers them, and
 * the first that applies wins.
 */
function smush(left, right, hardblank) {
  if (left === ' ') return right;
  if (right === ' ') return left;

  // A hardblank only yields to a real character, never to another hardblank —
  // rule 6 (hardblank smushing) is not set for this font.
  if (left === hardblank || right === hardblank) return null;

  if (left === right) return left;                                    // rule 1
  if (left === '_' && UNDERSCORE_PARTNERS.includes(right)) return right;  // rule 2
  if (right === '_' && UNDERSCORE_PARTNERS.includes(left)) return left;

  const l = hierarchyClass(left);
  const r = hierarchyClass(right);
  if (l !== -1 && r !== -1 && l !== r) return l > r ? left : right;    // rule 3

  if (OPPOSITE_PAIRS.has(left + right)) return '|';                    // rule 4
  return null;
}

/** Parse a `.flf` into the rows of each character. */
export function parseFont(text) {
  // The shipped `.flf` files are CRLF. Splitting on \n alone leaves a \r at
  // the end of every row, which becomes the "endmark" and strips nothing —
  // the glyphs then keep their `@` and never overlap.
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const header = lines[0].split(' ');
  const hardblank = header[0].slice(-1);
  const height = Number(header[1]);
  const commentLines = Number(header[5]);

  const glyphs = new Map();
  let at = 1 + commentLines;
  for (let code = FIRST_CODE; code <= LAST_CODE; code += 1) {
    const rows = [];
    for (let r = 0; r < height; r += 1) {
      const raw = lines[at + r];
      if (raw === undefined) return { hardblank, height, glyphs };
      // One or two endmarks close a row; the character itself is what precedes.
      const mark = raw[raw.length - 1];
      let end = raw.length;
      while (end > 0 && raw[end - 1] === mark) end -= 1;
      rows.push(raw.slice(0, end));
    }
    glyphs.set(code, rows);
    at += height;
  }
  return { hardblank, height, glyphs };
}

/** How far `next` can slide left into `rows` before anything collides. */
function overlapFor(rows, next, hardblank, height) {
  let allowed = Infinity;

  for (let r = 0; r < height; r += 1) {
    const left = rows[r];
    const right = next[r];

    let leftEnd = left.length;
    while (leftEnd > 0 && left[leftEnd - 1] === ' ') leftEnd -= 1;
    let rightStart = 0;
    while (rightStart < right.length && right[rightStart] === ' ') rightStart += 1;

    // A row with nothing in it cannot collide, so it must not be what limits
    // the slide. Counting its blanks capped `7,` and `W.` one column wider
    // than figlet draws them — the only four disagreements in a 3,110-string
    // comparison, and all of them a comma or a full stop after a wide glyph.
    if (leftEnd === 0 || rightStart === right.length) continue;

    // Slide over the whitespace between them, plus one more if the two
    // characters that would then touch are able to smush.
    let room = (left.length - leftEnd) + rightStart;
    if (leftEnd > 0 && rightStart < right.length
        && smush(left[leftEnd - 1], right[rightStart], hardblank) !== null) {
      room += 1;
    }
    if (room < allowed) allowed = room;
  }

  return allowed === Infinity ? 0 : Math.max(0, allowed);
}

/** Merge `next` into `rows`, overlapping by `by` columns. */
function merge(rows, next, by, hardblank, height) {
  const out = [];
  for (let r = 0; r < height; r += 1) {
    const left = rows[r];
    const right = next[r];
    const cut = Math.max(0, left.length - by);
    let head = left.slice(0, cut);
    const overlapLeft = left.slice(cut);
    let mid = '';

    for (let i = 0; i < by; i += 1) {
      const a = overlapLeft[i] ?? ' ';
      const b = right[i] ?? ' ';
      mid += smush(a, b, hardblank) ?? a;
    }
    out.push(head + mid + right.slice(by));
  }
  return out;
}

/**
 * Render `text` in the given parsed font. Newlines are not supported — the
 * banner is one line, and pretending otherwise would be untested code.
 */
export function renderFig(text, font) {
  const { hardblank, height, glyphs } = font;
  let rows = Array.from({ length: height }, () => '');

  for (const ch of String(text ?? '')) {
    const glyph = glyphs.get(ch.codePointAt(0)) ?? glyphs.get(32);
    if (!glyph) continue;
    const by = rows[0] === '' ? 0 : overlapFor(rows, glyph, hardblank, height);
    rows = merge(rows, glyph, by, hardblank, height);
  }

  return rows.map((r) => r.split(hardblank).join(' ')).join('\n');
}
