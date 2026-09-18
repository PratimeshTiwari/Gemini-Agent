/**
 * The vendored FIGfont renderer must draw exactly what `figlet` drew.
 *
 * `figlet` was 20.8MB — 328 fonts — for the one this app uses, `Standard`,
 * at a single call site: 21% of `node_modules` for a wordmark. The font is
 * 30KB and now sits in `ui/fonts/`; the renderer is `ui/figfont.js`.
 *
 * Correctness here is not an argument, it is a comparison. While `figlet`
 * was still installed, 25,110 strings — every printable character alone,
 * the banner itself, and 25,000 random strings of 1 to 12 characters — were
 * rendered through both and required to match byte for byte. They did.
 *
 * `figlet` is gone now, so what remains is a snapshot of what it produced
 * for the strings that matter. If the renderer drifts, this says so.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { bannerText } from '../../src/ui/banner-text.js';

/** Captured from `figlet.textSync(…, { font: 'Standard' })`. */
const EXPECTED = {
  'Agent CLI': [
    '     _                    _      ____ _     ___ ',
    '    / \\   __ _  ___ _ __ | |_   / ___| |   |_ _|',
    "   / _ \\ / _` |/ _ \\ '_ \\| __| | |   | |    | | ",
    '  / ___ \\ (_| |  __/ | | | |_  | |___| |___ | | ',
    ' /_/   \\_\\__, |\\___|_| |_|\\__|  \\____|_____|___|',
    '         |___/                                  ',
  ].join('\n'),
  // The four strings that disagreed before blank rows stopped constraining
  // the slide — a comma or full stop after a wide glyph.
  '7,': [
    '  _____ ',
    ' |___  |',
    '    / / ',
    '   / /  ',
    '  /_( ) ',
    '    |/  ',
  ].join('\n'),
};

test('the banner is byte-identical to what figlet produced', () => {
  assert.equal(bannerText('Agent CLI'), EXPECTED['Agent CLI']);
});

test('a comma after a wide glyph slides all the way in', () => {
  // The regression that took the comparison from 3,106/3,110 to 25,110/25,110:
  // a row where one side is entirely blank cannot collide, so it must not be
  // what limits the slide. Counting its blanks drew `7,` a column too wide.
  // I wrote this expectation into the file and then forgot to assert it —
  // dead test data, which is the same fault as the dead fields elsewhere.
  assert.equal(bannerText('7,'), EXPECTED['7,']);
});

test('a single character renders', () => {
  const a = bannerText('A');
  assert.equal(a.split('\n').length, 6, 'Standard is six rows tall');
  assert.match(a, /\/ _ \\/);
});

test('the hardblank never reaches the output', () => {
  // `$` is this font's hardblank and must be replaced by a space, or the
  // banner prints currency symbols through the middle of the letters.
  for (const s of ['Agent CLI', 'W', 'm n o', '||||', '____']) {
    assert.ok(!bannerText(s).includes('$'), `hardblank leaked for ${JSON.stringify(s)}`);
  }
});

test('every printable character renders without throwing', () => {
  for (let c = 32; c <= 126; c += 1) {
    const ch = String.fromCharCode(c);
    assert.doesNotThrow(() => bannerText(ch), `threw on ${JSON.stringify(ch)}`);
    assert.equal(bannerText(ch).split('\n').length, 6, `wrong height for ${JSON.stringify(ch)}`);
  }
});

test('an unknown character falls back to a space rather than throwing', () => {
  // Names are user-supplied via `agentName`, so this is reachable.
  assert.doesNotThrow(() => bannerText('héllo 🙂'));
});

test('empty input gives empty rows, not a crash', () => {
  assert.equal(bannerText(''), Array(6).fill('').join('\n'));
});
