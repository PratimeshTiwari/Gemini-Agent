import React from 'react';
import { render } from 'ink';
import { PassThrough } from 'node:stream';
import { MouseProvider } from './mouse.jsx';
import { createMouseSequenceFilter } from './stdin-filter.js';
import { App } from './App.jsx';

/**
 * The stream Ink reads: real stdin with mouse reports stripped out.
 *
 * Ink drives it with setEncoding/'readable'/read() and owns raw mode, so the
 * PassThrough has to look enough like a TTY for that: `isTTY` decides whether
 * raw mode is supported at all, and setRawMode/ref/unref forward to the real fd.
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

    const inkStdin = createInkStdin();
    const filter = createMouseSequenceFilter({
      onFlush: (text) => inkStdin.write(text),
    });

    // Both this listener and xterm-mouse's read the same fd — Node delivers
    // 'data' to every listener, so the mouse layer still sees the reports this
    // filter keeps away from Ink's key parser.
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      const text = filter.feed(chunk);
      if (text) inkStdin.write(text);
    });

    // Mouse tracking starts OFF (see mouse.jsx): text selection and the
    // terminal's own scrollback keep working until `/mouse on` asks for clicks.
    const { waitUntilExit } = render(
      <MouseProvider>
        <App agentLoop={this.agentLoop} wsServer={this.wsServer} />
      </MouseProvider>,
      {
        stdin: inkStdin,
        // Terminals report Shift+Enter as a plain Enter unless the kitty
        // keyboard protocol is negotiated. Ink's auto mode asks (CSI ? u) and
        // only enables it if the terminal answers, so terminals that don't
        // support it are unaffected — they can still send Esc+Enter instead.
        kittyKeyboard: { mode: 'auto', flags: ['disambiguateEscapeCodes'] },
      },
    );

    // Optional: await waitUntilExit() if we wanted to block,
    // but the original architecture just launched the UI and let events drive it.
  }
}
