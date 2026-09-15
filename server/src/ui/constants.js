/**
 * Values the UI shares across modules. No behaviour, no imports.
 */

export /** Slash commands offered by the palette, and the source `/help` prints from. */
const SLASH_COMMANDS = [
  { name: 'help', desc: 'Keys, and every command' },
  { name: 'settings', desc: 'Everything that is set, on one page' },
  { name: 'open', desc: 'Open a file in your editor' },
  { name: 'effort', desc: 'How hard to work, and which browser tab it expects' },
  { name: 'allowlist', desc: 'Manage auto-approved/blocked command rules' },
  { name: 'config', desc: 'Which model implements, and which one reviews it' },
  { name: 'plan', desc: 'Plan Mode — every edit needs approval' },
  { name: 'auto', desc: 'Auto Mode — safe edits apply automatically' },
  { name: 'workspace', desc: 'Where the agent works — and switch, which restarts' },
  { name: 'memory', desc: 'What the agent has learned about this project' },
  { name: 'context', desc: 'Show what is in the context window' },
  { name: 'compact', desc: 'Compact history to save tokens' },
  { name: 'clear', desc: 'Forget this conversation, keep the browser chat' },
  { name: 'new', desc: 'Fresh session, and a fresh chat in the browser too' },
  { name: 'undo', desc: 'Undo the last step/action' },
  { name: 'skills', desc: 'List, create and open skills the agent can load' },
  { name: 'github', desc: 'Run GitHub commands (e.g. /github refresh)' },
  { name: 'image', desc: 'Attach an image — a path, or bare for the clipboard' },
  { name: 'plans', desc: 'Past plans, newest first' },
  { name: 'commands', desc: 'Every shell command the agent has run, by day' },
  { name: 'name', desc: 'Name the agent — shown in the banner' },
  { name: 'update', desc: 'Pull the agent\'s own repo, and say what to reload' },
  { name: 'logs', desc: 'What has been failing — `/logs rates` for how often' },
  { name: 'restart', desc: 'Restart the server' },
  { name: 'exit', desc: 'Quit the agent' },
];

/** Where typed input goes. */
export const FOCUS_INPUT = 'input';
export const FOCUS_TERMINAL = 'terminal';

/**
 * Rows the live frame always spends on furniture below the transcript: the
 * thinking line with its margin (2, and the artifacts summary costs the same 2
 * in the idle state that replaces it), the breathing room above the prompt (1),
 * the input box with its two borders (3), the status bar with the blank row
 * above it (2), and a row of slack so a wrapped line cannot tip the frame over
 * the viewport (1).
 *
 * **Always** is the load-bearing word, and it is the bug this constant used to
 * carry. It was 17 and written as a single number covering everything, but some
 * of the furniture is conditional and one piece of it is *tall*: the slash
 * palette is up to six rows, the disconnected-extension warning one, the
 * "taking a while" note one. 17 did not cover them either — type `/` during a
 * run on a disconnected extension and the frame was eight rows over budget,
 * which is the clear-and-repaint bug waiting for an unusual afternoon.
 *
 * So the constant is now only the base, and App.jsx adds the conditional rows
 * to it for the frame it is actually about to draw. Removing the mode chip (2),
 * the permanent keybindings row (1) and the rule above the status bar (1) is
 * what took the base from 13 to 9.
 *
 * Both numbers are measured, not derived: `scratchpad/stress.py` under a pty
 * with a seeded transcript and a fake extension client holding a turn open,
 * expecting 0 ESC[2J at 24×72, 24×100 and 40×140 — idle, running, and with the
 * palette open. The one clear on ctrl+e is deliberate and documented in App.jsx.
 */
export const RESERVED_ROWS = 9;

/**
 * Below this many rows the furniture no longer fits, so some of it is dropped.
 *
 * `liveBudget` has a floor — the in-flight turn is given at least a few rows
 * however short the terminal is — which means the frame has a *minimum* height
 * of `RESERVED_ROWS + floor`, and a terminal shorter than that overflows on
 * every render however much the turn gives up. That is Ink's clear-and-repaint
 * path, the one that deletes the scrollback seven times a second.
 *
 * Measured under a pty, one turn, extension connected, no palette:
 *
 * ```
 * rows  13  →   0 ESC[2J
 * rows  12  →   1
 * rows  10  → 166
 * ```
 *
 * 13 is where `terminalHeight - RESERVED_ROWS` stops clearing the floor of 3,
 * which is why the threshold is a measurement and a derivation agreeing rather
 * than a guess.
 *
 * After: 0 at 10, 12, 13, 14, 24 and 30 rows. The floor moved from 13 to **9**
 * — 9 rows still costs one clear and 8 costs thirty, because six rows of
 * furniture and a one-row turn is the least this UI can draw and an 8-row
 * terminal cannot hold even that. That is a documented floor rather than a
 * silent one: a terminal that small should be cramped, not quietly destroying
 * its own scrollback.
 */
export const COMPACT_BELOW_ROWS = 13;

/**
 * Rows of furniture for the frame about to be drawn at this height.
 *
 * Three of the nine are blank: the margin above the prompt, the margin above
 * the status bar, and the one under the thinking line. They are there so the
 * transcript, the thing you type into and the state line read as three blocks
 * rather than one — worth three rows at any ordinary size, and worth nothing at
 * all on a terminal that cannot fit the blocks they separate.
 *
 * Spacing is what gets dropped, never a row carrying information: a short
 * terminal should be cramped, not lying about what the agent is doing.
 */
export function reservedRows(terminalHeight) {
  return terminalHeight < COMPACT_BELOW_ROWS ? RESERVED_ROWS - 3 : RESERVED_ROWS;
}

/** Whether the frame at this height is dropping its spacing. */
export const isCompactHeight = (terminalHeight) => terminalHeight < COMPACT_BELOW_ROWS;

export const THINKING_MESSAGES = [
  'Thinking…',
  'Gemining…',
  'Vibing…',
  'Analyzing syntax…',
  'Consulting the AI elders…',
  'Pondering the orb…',
  'Brewing code…',
  'Synthesizing logic…',
];
