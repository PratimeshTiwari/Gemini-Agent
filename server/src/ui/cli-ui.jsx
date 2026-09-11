import React from 'react';
import { render } from 'ink';
import { PassThrough } from 'node:stream';
import { splitTrailingEnter } from './enter-splitter.js';
import { extractHotkeys, hotkeys } from './hotkeys.js';
import { App } from './App.jsx';

/**
 * The stream Ink reads: real stdin, with a trailing Enter delivered separately.
 *
 * Ink drives it with setEncoding/'readable'/read() and owns raw mode, so the
 * PassThrough has to look enough like a TTY for that: `isTTY` decides whether
 * raw mode is supported at all, and setRawMode/ref/unref forward to the real fd.
 *
 * This used to strip mouse reports as well. It no longer needs to — the app
 * never turns terminal mouse tracking on — and with the mouse went the 20ms
 * escape timeout that stripping required, so Escape now stops the agent the
 * instant it is pressed.
 */
function createInkStdin() {
  const stream = new PassThrough();
  stream.isTTY = Boolean(process.stdin.isTTY);
  stream.isRaw = false;
  stream.setRawMode = (mode) => {
    process.stdin.setRawMode?.(mode);
    stream.isRaw = mode;
    return stream;
  };
  stream.ref = () => {
    process.stdin.ref?.();
    return stream;
  };
  stream.unref = () => {
    process.stdin.unref?.();
    return stream;
  };
  return stream;
}

export class CliUI {
  constructor(agentLoop, wsServer) {
    this.agentLoop = agentLoop;
    this.wsServer = wsServer;
  }

  start() {
    console.clear();

    // A terminal left in a tracking mode by a previous crashed run would still
    // be spraying mouse reports into our stdin, and Ink has no parser for them:
    // they would be typed into the prompt as literal text. Turning every mode
    // off once on the way up is a no-op when tracking was never on.
    if (process.stdout.isTTY) {
      process.stdout.write('\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?9l');
    }

    const inkStdin = createInkStdin();
    let pasteState = { inPaste: false };

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      // Application chords come out first and are dispatched on the side. They
      // must never reach Ink: `ink-text-input` types any key it does not
      // recognise straight into the prompt, so ctrl+e used to leave an "e"
      // behind on its way to toggling the transcript.
      const stripped = extractHotkeys(String(chunk), pasteState);
      pasteState = stripped.state;
      for (const name of stripped.hotkeys) hotkeys.emit(name);
      if (!stripped.text) return;

      const [text, enter] = splitTrailingEnter(stripped.text);
      if (text) inkStdin.write(text);
      // Deferred, not written back to back: Ink's read() drains everything
      // buffered at once, so two immediate writes would arrive as the single
      // chunk this is here to take apart.
      if (enter) setImmediate(() => inkStdin.write(enter));
    });

    render(<App agentLoop={this.agentLoop} wsServer={this.wsServer} />, {
      stdin: inkStdin,
      // Terminals report Shift+Enter as a plain Enter unless the kitty
      // keyboard protocol is negotiated. Ink's auto mode asks (CSI ? u) and
      // only enables it if the terminal answers, so terminals that don't
      // support it are unaffected — they can still send Esc+Enter instead.
      kittyKeyboard: { mode: 'auto', flags: ['disambiguateEscapeCodes'] },
    });
  }
}
