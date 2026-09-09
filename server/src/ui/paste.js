/**
 * Multi-line paste.
 *
 * A paste goes into the prompt as a short marker rather than its text, for two
 * reasons. The obvious one is legibility — forty lines of YAML in the input box
 * is not something anyone can edit. The load-bearing one is that the input box
 * sits in Ink's live frame, and a frame taller than the terminal puts Ink back
 * on the clear-and-repaint path that destroys the scrollback on every render
 * (see the note at the top of App.jsx). A paste is the easiest way for a user
 * to blow that budget, so it is never rendered at full height.
 *
 * The marker is expanded back to the real text on submit, so the model always
 * receives what was actually pasted.
 */

/** Above either of these a paste is worth collapsing rather than showing. */
export const PASTE_MAX_LINES = 4;
export const PASTE_MAX_CHARS = 400;

/**
 * Terminals send CR for newlines inside a paste. Left alone those render as a
 * cursor jump rather than a line break, so the text looks corrupted.
 */
export function normalizePaste(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n');
}

export function countLines(text) {
  return text.length === 0 ? 0 : text.split('\n').length;
}

export function shouldCollapse(text) {
  return countLines(text) > PASTE_MAX_LINES || text.length > PASTE_MAX_CHARS;
}

/** The token that stands in for a collapsed paste. Distinctive enough not to collide. */
export function pasteMarker(id, text) {
  const lines = countLines(text);
  return `[Pasted text #${id} +${lines} line${lines === 1 ? '' : 's'}]`;
}

/**
 * Put the real text back before the message is sent.
 *
 * A marker the user deleted simply does not expand, which is the right
 * behaviour: removing the marker is how you drop the paste.
 *
 * @param {string} input - the prompt as typed, markers and all
 * @param {Array<{marker: string, text: string}>} pastes
 */
export function expandPastes(input, pastes) {
  let out = String(input ?? '');
  for (const paste of pastes) {
    if (out.includes(paste.marker)) out = out.split(paste.marker).join(paste.text);
  }
  return out;
}

/**
 * Fold a paste into the prompt.
 *
 * @returns {{ value: string, paste: {id: number, marker: string, text: string}|null }}
 *   the new prompt value, and the paste to remember if one was collapsed.
 */
export function applyPaste(value, raw, nextId) {
  const text = normalizePaste(raw);
  if (!text) return { value, paste: null };

  if (!shouldCollapse(text)) {
    return { value: value + text, paste: null };
  }

  const marker = pasteMarker(nextId, text);
  return { value: value + marker, paste: { id: nextId, marker, text } };
}
