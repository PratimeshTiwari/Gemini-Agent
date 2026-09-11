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
 * The pastes still referenced by the prompt.
 *
 * `pastes` only grows — a paste is kept after submit so recalling the command
 * from history still expands, and dropping one is done by deleting its marker
 * from the text. So the list is not the answer to "how many are attached";
 * the markers actually present in the prompt are. Counting the list showed
 * "1 paste attached" forever, including after the marker was deleted and after
 * the message had been sent.
 *
 * @param {string} input
 * @param {Array<{marker: string}>} pastes
 */
export function attachedPastes(input, pastes = []) {
  const text = String(input ?? '');
  return pastes.filter((p) => p?.marker && text.includes(p.marker));
}

/**
 * The next id to hand a paste.
 *
 * Monotonic over everything ever pasted, not `length + 1`: dropping a marker
 * and pasting again would otherwise reuse the id, and two different blocks
 * would share one marker.
 */
export function nextPasteId(pastes = []) {
  return pastes.reduce((max, p) => Math.max(max, p?.id || 0), 0) + 1;
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
