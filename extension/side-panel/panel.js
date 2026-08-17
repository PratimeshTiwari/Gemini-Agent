/**
 * Gemini Agent — Side Panel JavaScript
 *
 * Agent terminal UI: handles user input, displays messages,
 * renders diffs with accept/reject, and manages slash commands.
 */

// ── DOM Elements ─────────────────────────────────────────────────────
const messageStream = document.getElementById('message-stream');
const welcomeMessage = document.getElementById('welcome-message');
const commandInput = document.getElementById('command-input');
const sendBtn = document.getElementById('send-btn');
const connectionDot = document.getElementById('connection-dot');
const connectionText = document.getElementById('connection-text');
const modeToggle = document.getElementById('mode-toggle');
const modeIcon = document.getElementById('mode-icon');
const modeText = document.getElementById('mode-text');
const contextFill = document.getElementById('context-fill');
const contextLabel = document.getElementById('context-label');

// ── State ────────────────────────────────────────────────────────────
let currentMode = 'plan';
let isConnected = false;
let isWaitingForResponse = false;

// ── Initialization ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  checkConnectionStatus();
  setupEventListeners();
});

function setupEventListeners() {
  // Send message
  sendBtn.addEventListener('click', sendMessage);
  commandInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Auto-resize textarea
  commandInput.addEventListener('input', () => {
    commandInput.style.height = 'auto';
    commandInput.style.height = Math.min(commandInput.scrollHeight, 150) + 'px';
  });

  // Mode toggle
  modeToggle.addEventListener('click', toggleMode);
}

// ── Connection ──────────────────────────────────────────────────────
async function checkConnectionStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'get_status' });
    updateConnectionUI(response?.connected || false);
  } catch {
    updateConnectionUI(false);
  }
}

function updateConnectionUI(connected) {
  isConnected = connected;
  connectionDot.className = `dot ${connected ? 'connected' : 'disconnected'}`;
  connectionText.textContent = connected ? 'Connected' : 'Disconnected';

  if (connected && welcomeMessage) {
    // Don't auto-remove welcome, let first message do it
  }
}

// ── Mode Toggle ─────────────────────────────────────────────────────
function toggleMode() {
  currentMode = currentMode === 'plan' ? 'auto' : 'plan';
  updateModeUI();

  // Send slash command to server
  chrome.runtime.sendMessage({
    type: 'slash_command',
    payload: { command: currentMode, args: [] },
  });
}

function updateModeUI() {
  if (currentMode === 'auto') {
    modeIcon.textContent = '⚡';
    modeText.textContent = 'Auto';
    modeToggle.classList.add('auto-mode');
  } else {
    modeIcon.textContent = '🔒';
    modeText.textContent = 'Plan';
    modeToggle.classList.remove('auto-mode');
  }
}

// ── Send Message ────────────────────────────────────────────────────
function sendMessage() {
  const content = commandInput.value.trim();
  if (!content || isWaitingForResponse) return;

  // Clear welcome message
  if (welcomeMessage) {
    welcomeMessage.remove();
  }

  // Check for slash commands
  if (content.startsWith('/')) {
    handleSlashCommand(content);
    commandInput.value = '';
    commandInput.style.height = 'auto';
    return;
  }

  // Display user message
  appendMessage('user', content);

  // Send to service worker → server
  chrome.runtime.sendMessage({
    type: 'user_message',
    payload: { content },
  });

  // Clear input
  commandInput.value = '';
  commandInput.style.height = 'auto';

  // Show thinking indicator
  showThinking();
  isWaitingForResponse = true;
  sendBtn.disabled = true;
}

function handleSlashCommand(input) {
  const parts = input.slice(1).split(/\s+/);
  const command = parts[0];
  const args = parts.slice(1);

  // Handle local commands
  if (command === 'plan' || command === 'auto') {
    currentMode = command;
    updateModeUI();
  }

  // Display the command
  appendStatus(`/${command} ${args.join(' ')}`.trim());

  // Send to server
  chrome.runtime.sendMessage({
    type: 'slash_command',
    payload: { command, args },
  });
}

// ── Message Rendering ───────────────────────────────────────────────
function appendMessage(role, content) {
  const div = document.createElement('div');
  div.className = `message message-${role}`;

  const contentDiv = document.createElement('div');
  contentDiv.className = 'message-content';
  contentDiv.textContent = content;

  div.appendChild(contentDiv);
  messageStream.appendChild(div);
  scrollToBottom();
}

function appendToolCall(name, args) {
  const div = document.createElement('div');
  div.className = 'message-tool';

  const argsPreview = typeof args === 'object'
    ? Object.entries(args).map(([k, v]) => `${k}: ${typeof v === 'string' ? v.substring(0, 40) : v}`).join(', ')
    : String(args).substring(0, 60);

  div.innerHTML = `
    <div class="tool-header" onclick="this.nextElementSibling.classList.toggle('expanded')">
      <span class="tool-icon">⚙️</span>
      <span class="tool-name">${escapeHtml(name)}</span>
      <span class="tool-args">${escapeHtml(argsPreview)}</span>
    </div>
    <div class="tool-details">${escapeHtml(JSON.stringify(args, null, 2))}</div>
  `;

  messageStream.appendChild(div);
  scrollToBottom();
}

function appendToolResult(name, success, result, error) {
  const lastTool = messageStream.querySelector('.message-tool:last-of-type');
  if (lastTool) {
    lastTool.classList.add(success ? 'tool-result-success' : 'tool-result-error');

    const details = lastTool.querySelector('.tool-details');
    if (details) {
      const resultStr = error || (typeof result === 'string' ? result : JSON.stringify(result, null, 2));
      details.textContent += '\n\n─── Result ───\n' + resultStr.substring(0, 2000);
    }
  }
}

function appendDiff(diffData) {
  const { diffId, filePath, patch, hunks, riskLevel, riskReason } = diffData;

  const div = document.createElement('div');
  div.className = 'diff-container';
  div.id = `diff-${diffId}`;

  // Parse patch into lines
  const diffLines = (patch || '').split('\n').map(line => {
    let cls = 'context';
    if (line.startsWith('+') && !line.startsWith('+++')) cls = 'add';
    else if (line.startsWith('-') && !line.startsWith('---')) cls = 'del';
    else if (line.startsWith('@@')) cls = 'hunk-header';
    return `<div class="diff-line ${cls}">${escapeHtml(line)}</div>`;
  }).join('');

  div.innerHTML = `
    <div class="diff-header">
      <span class="diff-file-path">📄 ${escapeHtml(filePath)}</span>
      <span class="diff-status pending">PENDING</span>
    </div>
    <div class="diff-content">${diffLines}</div>
    <div class="diff-actions">
      <button class="diff-btn accept" onclick="respondToDiff('${diffId}', 'accept')">
        ✅ Accept
      </button>
      <button class="diff-btn reject" onclick="respondToDiff('${diffId}', 'reject')">
        ❌ Reject
      </button>
    </div>
  `;

  messageStream.appendChild(div);
  scrollToBottom();
}

function appendStatus(text) {
  const div = document.createElement('div');
  div.className = 'message message-status';
  div.innerHTML = `<span class="status-text">${escapeHtml(text)}</span>`;
  messageStream.appendChild(div);
  scrollToBottom();
}

function appendError(text) {
  const div = document.createElement('div');
  div.className = 'message message-error';
  div.innerHTML = `<div class="message-content">❌ ${escapeHtml(text)}</div>`;
  messageStream.appendChild(div);
  scrollToBottom();
}

function showThinking() {
  removeThinking();
  const div = document.createElement('div');
  div.className = 'thinking';
  div.id = 'thinking-indicator';
  div.innerHTML = `
    <div class="thinking-dots"><span></span><span></span><span></span></div>
    <span>Thinking...</span>
  `;
  messageStream.appendChild(div);
  scrollToBottom();
}

function removeThinking() {
  const el = document.getElementById('thinking-indicator');
  if (el) el.remove();
}

// ── Diff Actions ────────────────────────────────────────────────────
// Exposed globally for onclick handlers
window.respondToDiff = function(diffId, action) {
  chrome.runtime.sendMessage({
    type: 'diff_response',
    payload: { diffId, action },
  });

  // Update UI immediately
  const container = document.getElementById(`diff-${diffId}`);
  if (container) {
    const status = container.querySelector('.diff-status');
    const actions = container.querySelector('.diff-actions');

    if (action === 'accept') {
      status.className = 'diff-status accepted';
      status.textContent = 'ACCEPTED';
    } else {
      status.className = 'diff-status rejected';
      status.textContent = 'REJECTED';
    }

    if (actions) actions.remove();
  }
};

// ── Context Bar ─────────────────────────────────────────────────────
function updateContextBar(used, total) {
  const pct = total > 0 ? Math.round((used / total) * 100) : 0;
  contextFill.style.width = `${pct}%`;
  contextLabel.textContent = `${pct}%`;

  contextFill.classList.remove('warning', 'danger');
  if (pct > 75) contextFill.classList.add('danger');
  else if (pct > 50) contextFill.classList.add('warning');
}

// ── Incoming Message Handler ────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, payload } = message;

  switch (type) {
    case 'connection_status':
      updateConnectionUI(payload.connected);
      if (payload.connected) {
        appendStatus('🟢 Connected to agent server');
      } else {
        appendStatus('🔴 Disconnected from agent server');
      }
      break;

    case 'status':
      if (payload.status === 'connected') {
        updateConnectionUI(true);
        if (payload.workspace) {
          appendStatus(`📂 Workspace: ${payload.workspace}`);
        }
        if (payload.mode) {
          currentMode = payload.mode;
          updateModeUI();
        }
      } else if (payload.status === 'waiting_for_gemini') {
        // Already showing thinking indicator
      } else if (payload.message) {
        appendStatus(payload.message);
      }
      break;

    case 'agent_response':
      removeThinking();
      isWaitingForResponse = false;
      sendBtn.disabled = false;
      appendMessage('agent', payload.content);
      break;

    case 'tool_call':
      appendToolCall(payload.name, payload.args);
      break;

    case 'tool_result':
      appendToolResult(payload.name, payload.success, payload.result, payload.error);
      break;

    case 'diff_request':
      removeThinking();
      appendDiff(payload);
      break;

    case 'diff_result':
      if (payload.message) appendStatus(payload.message);
      break;

    case 'diff_auto_applied':
      appendStatus(`✅ Auto-applied: ${payload.filePath}`);
      break;

    case 'command_result':
      removeThinking();
      isWaitingForResponse = false;
      sendBtn.disabled = false;
      if (payload.message) {
        appendStatus(payload.message);
      }
      break;

    case 'error':
      removeThinking();
      isWaitingForResponse = false;
      sendBtn.disabled = false;
      appendError(payload.message);
      break;
  }

  sendResponse({ received: true });
  return false;
});

// ── Helpers ──────────────────────────────────────────────────────────
function scrollToBottom() {
  requestAnimationFrame(() => {
    messageStream.scrollTop = messageStream.scrollHeight;
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
