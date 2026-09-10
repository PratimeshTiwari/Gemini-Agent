/**
 * Values the UI shares across modules. No behaviour, no imports.
 */

export /** Slash commands offered by the palette. Keep in sync with the /help output. */
const SLASH_COMMANDS = [
  { name: 'help', desc: 'Show all available commands' },
  { name: 'mode', desc: 'Solo, or Duo with a reviewer on the other model' },
  { name: 'model', desc: 'Switch model tier (Flash, Flash Thinking, Pro)' },
  { name: 'reasoning', desc: 'How hard Pro plans before acting (Brief, Standard, Deep)' },
  { name: 'allowlist', desc: 'Manage auto-approved/blocked command rules' },
  { name: 'config', desc: 'Configure models for specific roles' },
  { name: 'plan', desc: 'Plan Mode — every edit needs approval' },
  { name: 'auto', desc: 'Auto Mode — safe edits apply automatically' },
  { name: 'scope', desc: 'Work on one repo in a group that shares a .agent/' },
  { name: 'workspace', desc: 'Show or set the active workspace' },
  { name: 'set-workspace', desc: 'Pick a workspace from a list of folders' },
  { name: 'memory', desc: 'Turn long-term memory on or off' },
  { name: 'context', desc: 'Show what is in the context window' },
  { name: 'compact', desc: 'Compact history to save tokens' },
  { name: 'clear', desc: 'Forget this conversation, keep the browser chat' },
  { name: 'new', desc: 'Fresh session, and a fresh chat in the browser too' },
  { name: 'undo', desc: 'Undo the last step/action' },
  { name: 'skills', desc: 'List, create and open skills the agent can load' },
  { name: 'github', desc: 'Run GitHub commands (e.g. /github refresh)' },
  { name: 'image', desc: 'Attach an image — a path, or bare for the clipboard' },
  { name: 'logs', desc: 'What has been failing, grouped by flow' },
  { name: 'agent-dir', desc: 'Point the workspace at the agent\'s own source' },
  { name: 'restart', desc: 'Restart the server' },
  { name: 'exit', desc: 'Quit the agent' },
];

/** Where typed input goes. */
export const FOCUS_INPUT = 'input';
export const FOCUS_TERMINAL = 'terminal';

/**
 * Rows the live frame spends on furniture below the transcript: the thinking
 * line (2), the input box with its margin and border (5), the mode chip with
 * the blank row above it (2), the status bar with its rule and its own blank
 * row (4), and a row of slack so a wrapped line cannot tip the frame over the
 * viewport.
 *
 * Overshooting costs a little transcript; undershooting costs the scrollback,
 * because Ink answers an overflowing frame with a full clear-and-repaint on
 * every render. See the note at the top of App.jsx.
 */
export const RESERVED_ROWS = 16;

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
