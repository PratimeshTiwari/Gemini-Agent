/**
 * Making Enter arrive as its own keypress.
 *
 * Ink's input parser deliberately does *not* split `\r` away from the text
 * around it — a carriage return can legitimately sit inside pasted text, so
 * `input-parser.js` keeps the chunk whole (see the comment above
 * `splitBackspaceBytes` there). The consequence is that whenever the terminal
 * delivers the last typed character and the Enter that follows it in a single
 * read — which happens constantly when typing quickly, over ssh, inside tmux,
 * or on key repeat — Ink parses `"i\r"` as one event with
 * `key.return === false`. `ink-text-input` then types the carriage return into
 * the prompt as literal text, and the message is simply never sent.
 *
 * So the trailing newline is peeled off into a chunk of its own before Ink
 * reads it. Only the trailing one: newlines *inside* a chunk still belong to
 * whatever was pasted.
 */

/** Bracketed paste — Ink needs the whole sequence intact, markers and all. */
const PASTE_START = '\x1b[200~';
const ESC = '\x1b';

/**
 * @param {string} text - one raw stdin chunk
 * @returns {string[]} one or two chunks; the second, when present, is the lone
 *   `\r` or `\n` that ended the original.
 */
export function splitTrailingEnter(text) {
  if (text.length < 2) return [text];

  const last = text[text.length - 1];
  if (last !== '\r' && last !== '\n') return [text];

  // A paste that happens to end in a newline is still a paste.
  if (text.includes(PASTE_START)) return [text];

  // Esc+Enter is the terminal's own "newline, do not submit", and every other
  // escape sequence is one key rather than a key plus Enter.
  if (text.includes(ESC)) return [text];

  return [text.slice(0, -1), last];
}
