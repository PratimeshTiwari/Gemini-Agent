/**
 * Mouse-report filter for the stream Ink reads.
 *
 * Ink has no mouse parser. When terminal mouse tracking is on, every report
 * (`\x1b[<35;73;20M`) reaches `parse-keypress`, fails to match a key, loses its
 * ESC prefix and arrives at `ink-text-input` as literal typed text — one per
 * mouse *move*. `xterm-mouse` listens on the same fd but cannot remove bytes
 * from it, so the sequences have to be stripped before Ink sees them.
 *
 * `cli-ui.jsx` feeds raw stdin through this filter and hands the cleaned text
 * to Ink via `render(node, { stdin })`, while the mouse layer keeps reading the
 * raw stream. Node broadcasts 'data' to every listener, so both see everything.
 */

/** Complete reports: SGR (1006) and the legacy X10 form. */
const SGR_REPORT = /^\x1b\[<\d{1,3};\d{1,4};\d{1,4}[Mm]/;
const X10_REPORT = /^\x1b\[M[\x20-\x7f]{3}/;

/**
 * Trailing bytes that could still *become* a report once more arrives. A tty
 * write is normally atomic, but a 12-byte report can be split across reads, and
 * half a report is exactly what ends up in the input line.
 */
const SGR_PARTIAL = /^\x1b(\[(<(\d{0,3}(;(\d{0,4}(;\d{0,4})?)?)?)?)?)?$/;
const X10_PARTIAL = /^\x1b(\[(M[\x20-\x7f]{0,2})?)?$/;

/**
 * @param {Object} [options]
 * @param {number} [options.flushDelayMs] - How long a partial sequence is held
 *   before it is treated as ordinary input. This is the classic escape-timeout
 *   trade: a lone `\x1b` is both the Escape key and the start of a mouse
 *   report, so Escape costs this much latency. Keep it well under human
 *   perception (vim's ttimeoutlen defaults far higher).
 * @param {(text: string) => void} [options.onFlush] - Called with a held
 *   fragment once the timeout expires, so it still reaches Ink.
 * @returns {{ feed: (chunk: Buffer|string) => string, flush: () => string,
 *   pending: () => string, dispose: () => void }}
 */
export function createMouseSequenceFilter({ flushDelayMs = 20, onFlush } = {}) {
  let held = '';
  let timer = null;

  const cancelTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const flush = () => {
    cancelTimer();
    const text = held;
    held = '';
    return text;
  };

  const scheduleFlush = () => {
    cancelTimer();
    if (!held || !onFlush) return;
    timer = setTimeout(() => {
      timer = null;
      const text = held;
      held = '';
      if (text) onFlush(text);
    }, flushDelayMs);
    // Never keep the process alive just to release a half-typed escape.
    timer.unref?.();
  };

  const feed = (chunk) => {
    cancelTimer();
    const buffer = held + String(chunk);
    held = '';

    let out = '';
    let i = 0;
    while (i < buffer.length) {
      const esc = buffer.indexOf('\x1b', i);
      if (esc === -1) {
        out += buffer.slice(i);
        break;
      }

      out += buffer.slice(i, esc);
      const rest = buffer.slice(esc);

      const report = rest.match(SGR_REPORT) || rest.match(X10_REPORT);
      if (report) {
        i = esc + report[0].length; // drop the report
        continue;
      }

      if (SGR_PARTIAL.test(rest) || X10_PARTIAL.test(rest)) {
        held = rest; // incomplete: wait for the rest of the read
        break;
      }

      // A real escape sequence (arrow keys, Escape itself): pass it through and
      // keep scanning after the ESC so a report later in the chunk is caught.
      out += '\x1b';
      i = esc + 1;
    }

    scheduleFlush();
    return out;
  };

  return { feed, flush, pending: () => held, dispose: cancelTimer };
}
