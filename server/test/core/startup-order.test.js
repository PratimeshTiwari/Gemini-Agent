/**
 * Nothing the user waits for may sit in front of the first frame.
 *
 * `main.js` waited up to `EXTENSION_GREETING_MS` (1.5s) for the Chrome
 * extension to announce itself, and only then created the Ink UI. Measured
 * under a pty with no extension listening: the prompt box appeared at 2.07s,
 * of which 1.5s was this wait — larger than every module import in the process
 * put together (517ms, 426ms of it ink+react). Moving the wait behind
 * `cli.start()` took first paint to 0.58s with no behaviour change at all: the
 * shim log shows the start tab still opens, just not while someone is watching
 * an empty terminal.
 *
 * It is guarded here because the regression is invisible in review. Awaiting
 * one more thing before `cli.start()` looks like ordinary sequencing, reads
 * correctly, and costs the user a second and a half every single launch —
 * there is no failing behaviour to notice, only a slower start.
 *
 * A source-order assertion rather than a timing one on purpose. Timing tests
 * on a shared CI box are the flakiest thing a suite can own, and the thing
 * actually worth pinning is structural: the UI is constructed before the
 * waits, not after. `src/index.js` is read as *text* for the same reason it is
 * everywhere else in this suite — importing it spawns the agent.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../../src');
const main = readFileSync(join(SRC, 'main.js'), 'utf8');

/** Index of a needle that must appear exactly once, asserted so. */
function at(haystack, needle, label) {
  const first = haystack.indexOf(needle);
  assert.notEqual(first, -1, `${label}: not found — did it get renamed?`);
  assert.equal(
    haystack.indexOf(needle, first + 1), -1,
    `${label}: found more than once, so ordering here proves nothing`,
  );
  return first;
}

/**
 * Lines that are code, paired with their 1-based number.
 *
 * Scanning raw source for `console.` matched this suite's own comment saying
 * not to call it — the same trap as reading a message-shaped string literal as
 * a message. Comment lines are dropped so a warning about a call cannot be
 * mistaken for the call.
 */
function codeLines(source, from, to) {
  return source.slice(from, to).split('\n')
    .map((text, i) => ({ text, line: source.slice(0, from).split('\n').length + i }))
    .filter(({ text }) => {
      const t = text.trim();
      return t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    });
}

describe('startup order', () => {
  const uiStart = at(main, 'cli.start();', 'cli.start()');

  test('the UI is started before the extension-greeting wait', () => {
    const greeting = at(main, 'EXTENSION_GREETING_MS)', 'the greeting timeout');
    assert.ok(
      uiStart < greeting,
      'main.js waits for the extension before painting the UI again — that put '
        + '1.5s in front of every launch. The wait belongs after cli.start().',
    );
  });

  test('the start tab is opened after the UI, not before it', () => {
    const openTab = at(main, "const startUrl = ", 'the start-url decision');
    assert.ok(
      uiStart < openTab,
      'opening the browser tab moved back in front of the first frame',
    );
  });

  test('nothing is awaited between the server starting and the UI', () => {
    // `wsServer.start()` genuinely must finish first — the greeting reads its
    // client list — so it is the boundary. It appears twice: once on the happy
    // path and again inside the EADDRINUSE recovery, which legitimately awaits
    // a confirm() the user is already answering. Measuring from the *last* one
    // steps over that block rather than trying to excise it.
    const serverUp = main.lastIndexOf('await wsServer.start();');
    assert.ok(serverUp !== -1 && serverUp < uiStart, 'wsServer.start() moved');

    // The window ends at the UI's own import, not at cli.start(): that import
    // *is* the first paint, and it is deliberately dynamic so `--sessions` and
    // `--help` never pay ink+react's 426ms.
    const uiImport = at(main, "await import('./ui/cli-ui.jsx')", 'the CliUI import');
    const awaits = codeLines(main, serverUp + 'await wsServer.start();'.length, uiImport)
      .filter(({ text }) => /\bawait\b/.test(text));
    assert.deepEqual(
      awaits.map(({ line, text }) => `${line}: ${text.trim()}`), [],
      'an await crept in between the server starting and the first frame. '
        + 'Each one is time the user spends looking at an empty terminal.',
    );
  });

  test('GitHub watching starts after the UI, not in front of it', () => {
    const start = at(main, 'githubHandler.start()', 'githubHandler.start()');
    assert.ok(
      uiStart < start,
      'the GitHub poller authenticates and runs a full initial poll before it '
        + 'resolves — all network. Awaited before the UI it measured 0.54s for '
        + 'auth alone, plus a per-PR fan-out behind it.',
    );
  });

  test('GitHub starts after the server, so its events have a listener', () => {
    // Not a performance rule. `start()` emits `status` and `auth_rejected`,
    // and the only listener for either is wired in the WebSocketServer
    // constructor. Starting the poller first emitted the 401 message into an
    // EventEmitter with nobody attached, so an expired token produced no
    // GitHub activity and no explanation.
    const server = at(main, 'new WebSocketServer(', 'the WebSocketServer construction');
    const start = at(main, 'githubHandler.start()', 'githubHandler.start()');
    assert.ok(
      server < start,
      'githubHandler.start() moved back in front of the WebSocketServer, which '
        + 'is the only thing listening for auth_rejected — a rejected token '
        + 'would go silent again',
    );
  });

  test('the greeting does not write to the terminal the UI owns', () => {
    // Up to the shutdown handler, whose console.log is fine: by then Ink has
    // been torn down and the terminal is the shell's again.
    const shutdown = at(main, 'const shutdown = async', 'the shutdown handler');
    const writes = codeLines(main, uiStart, shutdown)
      .filter(({ text }) => /console\.(log|error|warn)\s*\(/.test(text));
    assert.deepEqual(
      writes.map(({ line, text }) => `${line}: ${text.trim()}`), [],
      'console output after cli.start() lands inside the frame Ink is '
        + 'repainting and is destroyed by the next render — use logError',
    );
  });
});
