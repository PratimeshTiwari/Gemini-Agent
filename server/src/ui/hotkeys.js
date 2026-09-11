/**
 * Application chords, taken off the wire before Ink sees them.
 *
 * `ink-text-input` types *any* key it does not recognise into the field — its
 * handler special-cases exactly one chord, ctrl+c — so ctrl+e, ctrl+o, ctrl+t
 * and ctrl+v each fired their binding *and* left a stray "e", "o", "t" or "v"
 * in the prompt. There is no way to stop a `useInput` handler from running:
 * Ink calls every listener, and the text field's is registered first because
 * child effects run before the parent's.
 *
 * So these bytes never reach Ink's input channel at all. `cli-ui.jsx` pulls
 * them out of the stdin chunk and emits them here; `use-hotkeys.js` subscribes.
 * That is what keeps typed characters — and only typed characters — in the
 * writing area.
 *
 * ctrl+c is deliberately absent: Ink owns it, and exiting must keep working
 * even if this module has a bug.
 */

import { EventEmitter } from 'node:events';

/** Chord byte -> event name. */
export const HOTKEYS = {
  '\x05': 'expand',       // ctrl+e — expand/collapse the transcript
  '\x0f': 'tabs',         // ctrl+o — agent <-> GitHub
  '\x14': 'terminal',     // ctrl+t — the scratch shell
  '\x16': 'paste-image',  // ctrl+v — attach an image from the clipboard
  '\x15': 'clear-input',  // ctrl+u — wipe the prompt, as readline has always done
  '\x17': 'delete-word',  // ctrl+w — delete the word behind the cursor
};

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/** The one emitter cli-ui writes to and the UI listens on. */
export const hotkeys = new EventEmitter();

/**
 * Pull chord bytes out of one stdin chunk.
 *
 * Bracketed paste is passed through untouched, markers and all: a pasted file
 * can legitimately contain a 0x05, and stripping it would corrupt the paste.
 * The paste state is returned rather than held here because a paste can span
 * several chunks.
 *
 * @param {string} text - one raw stdin chunk
 * @param {{inPaste: boolean}} [state] - carried between chunks
 * @returns {{text: string, hotkeys: string[], state: {inPaste: boolean}}}
 */
export function extractHotkeys(text, state) {
  let inPaste = state?.inPaste ?? false;
  const found = [];
  let out = '';
  let i = 0;

  while (i < text.length) {
    if (inPaste) {
      if (text.startsWith(PASTE_END, i)) {
        inPaste = false;
        out += PASTE_END;
        i += PASTE_END.length;
        continue;
      }
    } else {
      if (text.startsWith(PASTE_START, i)) {
        inPaste = true;
        out += PASTE_START;
        i += PASTE_START.length;
        continue;
      }
      const name = HOTKEYS[text[i]];
      if (name) {
        found.push(name);
        i += 1;
        continue;
      }
    }
    out += text[i];
    i += 1;
  }

  return { text: out, hotkeys: found, state: { inPaste } };
}
