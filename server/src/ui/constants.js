/**
 * Values the UI shares across modules. No behaviour, no imports.
 */

export /** Slash commands offered by the palette, and the source `/help` prints from. */
const SLASH_COMMANDS = [
  { name: 'help', desc: 'Keys, and every command' },
  { name: 'settings', desc: 'Everything that is set, on one page' },
  { name: 'effort', desc: 'How hard to work, and which browser tab it expects' },
  { name: 'allowlist', desc: 'Manage auto-approved/blocked command rules' },
  { name: 'config', desc: 'Which model implements, and which one reviews it' },
  { name: 'plan', desc: 'Plan Mode — every edit needs approval' },
  { name: 'auto', desc: 'Auto Mode — safe edits apply automatically' },
  { name: 'workspace', desc: 'Where the agent is working, and where its state lives' },
  { name: 'set-workspace', desc: 'Switch project — restarts into it' },
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
  { name: 'logs', desc: 'What has been failing, grouped by flow' },
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
