/**
 * Values the UI shares across modules. No behaviour, no imports.
 */

export /** Slash commands offered by the palette. Keep in sync with the /help output. */
const SLASH_COMMANDS = [
  { name: 'help', desc: 'Show all available commands' },
  { name: 'mode', desc: 'Change agent topology (Single, Duo, Swarm)' },
  { name: 'model', desc: 'Switch model tier (Flash, Flash Thinking, Pro)' },
  { name: 'allowlist', desc: 'Manage auto-approved/blocked command rules' },
  { name: 'config', desc: 'Configure models for specific roles' },
  { name: 'plan', desc: 'Plan Mode — every edit needs approval' },
  { name: 'auto', desc: 'Auto Mode — safe edits apply automatically' },
  { name: 'workspace', desc: 'Change the active workspace' },
  { name: 'memory', desc: 'View current agent memory context' },
  { name: 'context', desc: 'Show current context window usage' },
  { name: 'compact', desc: 'Compact history to save tokens' },
  { name: 'clear', desc: 'Clear local history' },
  { name: 'new', desc: 'Start a new chat session' },
  { name: 'undo', desc: 'Undo the last step/action' },
  { name: 'init-skills', desc: 'Create workspace rules (.agent/rules.md)' },
  { name: 'github', desc: 'Run GitHub commands (e.g. /github refresh)' },
  { name: 'image', desc: 'Attach an image (e.g. /image path/to/img.png)' },
  { name: 'paste-image', desc: 'Attach image from clipboard (macOS)' },
  { name: 'mouse', desc: 'Toggle mouse tracking (clickable rows)' },
  { name: 'agent-dir', desc: 'Open the agent data directory' },
  { name: 'restart', desc: 'Restart the server' },
  { name: 'exit', desc: 'Quit the agent' },
];

export const FOCUS_CHAT = 'chat';
export const FOCUS_INPUT = 'input';
export const FOCUS_TERMINAL = 'terminal';

export const THINKING_MESSAGES = [
  'Thinking...',
  'Gemining...',
  'Vibing...',
  'Analyzing syntax...',
  'Consulting the AI elders...',
  'Pondering the orb...',
  'Brewing code...',
  'Synthesizing logic...',
];
