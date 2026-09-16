/**
 * Agent CLI — Side Panel JavaScript
 *
 * Agent terminal UI: handles user input, displays messages,
 * renders diffs with accept/reject, and manages slash commands.
 */

// ── DOM Elements ─────────────────────────────────────────────────────
const messageStream = document.getElementById('message-stream');
const welcomeMessage = document.getElementById('welcome-message');
const commandInput = document.getElementById('command-input');
const sendBtn = document.getElementById('send-btn');
const inputArea = document.getElementById('input-area');
const connectionDot = document.getElementById('connection-dot');
const connectionText = document.getElementById('connection-text');
const modeToggle = document.getElementById('mode-toggle');
const modeIcon = document.getElementById('mode-icon');
const modeText = document.getElementById('mode-text');

// ── State ────────────────────────────────────────────────────────────
let currentMode = 'plan';
let isConnected = false;
let isWaitingForResponse = false;
let currentWorkspace = '';

// ── Initialization ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  showVersion();
  checkConnectionStatus(true);
  watchConnection();
  setupEventListeners();
});

/**
 * Stamp the loaded build into the status bar.
 *
 * Read from the manifest rather than written here, so it is the version Chrome
 * actually loaded and not a number someone forgot to change. This exists
 * because three artifacts ship from one repo — the bundled service worker, the
 * unbundled content scripts, and the .vsix — and a pull updates none of them in
 * the browser until it is reloaded. "Which one is running" is the first
 * question whenever the answer is "it behaves like the old one".
 */
function showVersion() {
  const el = document.getElementById('ext-version');
  if (!el) return;
  try {
    el.textContent = `v${chrome.runtime.getManifest().version}`;
  } catch {
    el.remove();
  }
}

function setupEventListeners() {
  // Send message
  sendBtn.addEventListener('click', sendMessage);
  commandInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Auto-resize textarea, and light the send button once there is something
  // to send. Muted-until-useful was half the idea; without this half the
  // button looks equally dead whether the box is empty or full.
  commandInput.addEventListener('input', () => {
    commandInput.style.height = 'auto';
    commandInput.style.height = Math.min(commandInput.scrollHeight, 150) + 'px';
    reflectSendState();
  });

  // Mode toggle
  modeToggle.addEventListener('click', toggleMode);

  setupPopout();
  setupWorkspace();
  setupSurfaces();
}

/**
 * One page, three surfaces, and the buttons that move between them.
 *
 * The toolbar icon opens this as a **popup**, which Chrome closes the moment it
 * loses focus — right for asking something, wrong for watching a turn that
 * takes a minute. So the popup offers the two places you can stay: `⊟` docks it
 * to the side panel, `⧉` floats it as its own window.
 *
 * Each button hides itself where it does not apply, so no surface offers to
 * become what it already is.
 */
/**
 * Does the send button look like it can do anything?
 *
 * Three states, not two: nothing typed (inert), something typed (live), and a
 * turn in flight (disabled). The middle one was missing — the button was muted
 * until hover whether the box was empty or not, so the only feedback that a
 * message was ready to go was the text you had just typed.
 */
function reflectSendState() {
  const ready = commandInput.value.trim().length > 0 && !isWaitingForResponse;
  sendBtn.classList.toggle('ready', ready);
}

function setupSurfaces() {
  const mode = new URLSearchParams(location.search);
  const dock = document.getElementById('dock-btn');
  if (!dock) return;

  // The side panel is already the side panel; the floating window is a
  // deliberate choice to leave the browser chrome behind.
  if (!mode.get('popup')) { dock.remove(); return; }

  document.body.classList.add('is-popup');

  dock.addEventListener('click', async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      // `sidePanel.open` needs a user gesture, which this click is.
      await chrome.sidePanel.open({ windowId: tab.windowId });
      window.close();
    } catch (err) {
      appendStatus(`Could not open the side panel: ${err.message}`);
    }
  });
}

/**
 * Change the workspace from the panel.
 *
 * The same act as `/workspace <path>` in the CLI, and the same code behind it
 * — `core/restart.js` owns validation, the supervisor check and the handover
 * file, so the two front-ends cannot disagree about what a usable workspace is.
 *
 * `prompt()` rather than a file picker: a Chrome extension page cannot open a
 * native folder chooser, and `<input type="file" webkitdirectory>` gives you a
 * *copy* of the directory's contents, not its path — the one thing needed
 * here. The CLI has a real picker for people who want one.
 *
 * It restarts the agent, so the socket will drop and come back. That is the
 * honest signal that it worked, and it is why the reply is a status line
 * rather than a silent change.
 */
function setupWorkspace() {
  const btn = document.getElementById('workspace-btn');
  if (!btn) return;

  btn.addEventListener('click', () => {
    if (!isConnected) {
      appendStatus('Not connected — start the agent first.');
      return;
    }
    // Ask the *agent* to open the chooser. An extension page cannot open a
    // native dialog, and `<input webkitdirectory>` gives back a copy of the
    // directory's contents rather than its path — the only thing needed here.
    // The agent runs on this machine, so its dialog is this machine's dialog.
    chrome.runtime.sendMessage({ type: 'pick_workspace' });
  });
}

/**
 * Typing the path, for when there is no chooser to open.
 *
 * Reached only from the server saying so — a headless box, or a Linux session
 * with no display. Offering a text box first would be worse for everyone with
 * a desktop.
 */
function promptForWorkspace() {
  // eslint-disable-next-line no-alert
  const next = window.prompt('Workspace path for the agent to work in:', currentWorkspace || '');
  if (next === null) return;
  const target = next.trim();
  if (!target || target === currentWorkspace) return;
  chrome.runtime.sendMessage({ type: 'set_workspace', payload: { path: target } });
}

/**
 * Open this same page as a floating window.
 *
 * Chrome's side panel is docked and there is no API to float it — Chrome's own
 * Gemini panel sits in the same dock for the same reason. A popup window is a
 * real OS window: movable anywhere, including onto another monitor, and it is
 * this exact page, so nothing about the messaging changes.
 *
 * The button hides itself when we *are* the floating window, because a popup
 * that can spawn another popup is a way to end up with four of them.
 */
function setupPopout() {
  const btn = document.getElementById('popout-btn');
  if (!btn) return;

  if (new URLSearchParams(location.search).get('window') === '1') {
    btn.remove();
    return;
  }

  btn.addEventListener('click', async () => {
    try {
      await chrome.windows.create({
        url: chrome.runtime.getURL('side-panel/panel.html?window=1'),
        type: 'popup',
        width: 460,
        height: 760,
      });
    } catch (err) {
      appendStatus(`Could not open a floating window: ${err.message}`);
    }
  });
}

// ── Connection ──────────────────────────────────────────────────────
/** How often the dot re-reads the truth. */
const STATUS_POLL_MS = 4000;

/**
 * Keep the connection dot honest.
 *
 * `connection_status` is broadcast only when the socket *transitions*, so a
 * panel opened while the socket is already up receives nothing and has exactly
 * one sample to go on: this call, at load. One sample is the bug — a floating
 * window opened at the wrong moment showed "Disconnected" over a working
 * bridge and had no way to ever find out otherwise, while the docked panel two
 * inches away showed "Connected" from its own luckier sample.
 *
 * The moment is easy to lose: MV3 recycles the service worker constantly, and
 * a worker woken *by this very message* has `ws === null` until it reconnects.
 *
 * So it is polled. A status indicator that samples once is wrong by
 * construction, and the read is a boolean from a worker that is awake anyway.
 *
 * @param {boolean} initial - only the first check asks the worker to connect.
 *   Repeating that would restart the retry ladder every few seconds and keep
 *   the backoff permanently at its first rung.
 */
async function checkConnectionStatus(initial = false) {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'get_status' });
    const connected = response?.connected || false;
    updateConnectionUI(connected);

    if (initial && !connected) {
      // Free and idempotent: connectWebSocket returns immediately if one is
      // already open or opening.
      chrome.runtime.sendMessage({ type: 'connect' }).catch(() => {});
    }
  } catch {
    // The worker being unreachable *is* disconnected, as far as the dot goes.
    updateConnectionUI(false);
  }
}

function watchConnection() {
  setInterval(() => checkConnectionStatus(), STATUS_POLL_MS);
  // A floating window can sit behind the browser for a long time, where Chrome
  // throttles timers hard. Coming back to it should not mean waiting for the
  // next tick to learn the truth.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) checkConnectionStatus();
  });
  window.addEventListener('focus', () => checkConnectionStatus());
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
  // `●` / `○`, the same two glyphs the CLI's status bar uses for connected and
  // not. Filled means it acts on its own; hollow means it asks first.
  if (currentMode === 'auto') {
    modeIcon.textContent = '●';
    modeText.textContent = 'Auto';
    modeToggle.classList.add('auto-mode');
  } else {
    modeIcon.textContent = '○';
    modeText.textContent = 'Plan';
    modeToggle.classList.remove('auto-mode');
  }
}

// ── Send Message ────────────────────────────────────────────────────
/**
 * What to do when there is no agent to send to.
 *
 * Said only when someone actually tries to send something — the dot has been
 * telling them the state all along, and the panel used to announce it
 * repeatedly, unprompted, until the conversation was off the screen.
 *
 * Both causes are named because the panel genuinely cannot tell them apart: no
 * agent running, or an agent running behind a stale bridge. The second is the
 * one people do not guess, and it is the ordinary outcome of pulling an update
 * — the content scripts and the bundle only change in the browser when it is
 * reloaded.
 */
function explainDisconnected() {
  appendStatus(
    'Not connected to the agent.\n\n'
    + '  Start it in a terminal:  `agent`\n\n'
    + '  Already running? The bridge in this browser is stale — hard-refresh\n'
    + '  the Gemini tab (⌘⇧R), or reload the extension at chrome://extensions.',
  );
}

function sendMessage() {
  const content = commandInput.value.trim();
  if (!content || isWaitingForResponse) return;

  // Asked at the point of use, not announced beforehand.
  if (!isConnected) {
    if (welcomeMessage) welcomeMessage.remove();
    appendMessage('user', content);
    explainDisconnected();
    commandInput.value = '';
    commandInput.style.height = 'auto';
    return;
  }

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
  reflectSendState();

  // Show thinking indicator
  showThinking();
  isWaitingForResponse = true;
  sendBtn.disabled = true;
  reflectSendState();
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
/**
 * Markdown, to the small extent the panel needs it.
 *
 * The reply is model output, so **escaping comes first** and the formatting is
 * applied to the already-escaped string — a `<` in the text can never become a
 * tag, whatever the model wrote.
 *
 * Deliberately not a markdown library: the panel is a plain page with no build
 * step, and the whole of what a reply actually uses is fenced blocks, inline
 * code and bold. Lists and tables are left as their source, which reads fine
 * in a monospace column; the alternative was shipping a parser to the browser
 * for two constructs.
 */
function renderMarkdownish(text) {
  const escaped = escapeHtml(String(text ?? ''));
  const blocks = [];

  // Fenced blocks are lifted out first so their contents are never treated as
  // inline markup — a `**` inside a shell command is not bold.
  const withoutFences = escaped.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    blocks.push(`<pre class="md-code"${lang.trim() ? ` data-lang="${lang.trim()}"` : ''}>`
      + `<code>${code.replace(/\n$/, '')}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });

  const inline = withoutFences
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`\n]+)`/g, '<code class="md-inline">$1</code>');

  return inline.replace(/\u0000(\d+)\u0000/g, (_m, i) => blocks[Number(i)] ?? '');
}

function appendMessage(role, content) {
  const div = document.createElement('div');
  div.className = `message message-${role}`;

  const contentDiv = document.createElement('div');
  contentDiv.className = 'message-content';
  // The user's own message is shown exactly as typed; only the agent's reply
  // is formatted, and that path escapes before it formats.
  if (role === 'user') contentDiv.textContent = content;
  else contentDiv.innerHTML = renderMarkdownish(content);

  div.appendChild(contentDiv);
  messageStream.appendChild(div);
  scrollToBottom();
}

function appendToolCall(name, args) {
  const div = document.createElement('div');
  div.className = 'message-tool';

  // A one-line summary of the arguments.
  //
  // The old version interpolated non-strings straight into a template, so an
  // array of objects — `ask_question`'s `questions`, every time — rendered as
  // `[object Object],[object Object]`, which tells the reader nothing at all
  // and looks like a bug in the agent rather than in this line.
  const preview = (value) => {
    if (typeof value === 'string') return value.length > 40 ? `${value.slice(0, 39)}…` : value;
    if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
    if (value && typeof value === 'object') {
      // The field people actually recognise, if it has one.
      const named = value.name ?? value.path ?? value.question ?? value.label;
      return typeof named === 'string' ? preview(named) : '{…}';
    }
    return String(value);
  };

  const argsPreview = args && typeof args === 'object'
    ? Object.entries(args).map(([k, v]) => `${k}: ${preview(v)}`).join(', ')
    : preview(args);

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

/**
 * A status line, or — when it is not a line at all — a block.
 *
 * `status-text` is a small rounded pill, which is right for "🧹 history
 * cleared" and wrong for the answer to `/effort`, a multi-line listing that
 * arrives on the same channel. Crammed into a pill with no `pre-wrap` it came
 * out as a wall of run-together prose with its markdown showing.
 */
let lastStatusText = '';

function appendStatus(text) {
  const body = String(text ?? '');

  // Identical consecutive statuses collapse. Nothing should be able to fill
  // this panel with one repeated sentence again, whatever starts doing it.
  if (body && body === lastStatusText) return;
  lastStatusText = body;
  const isBlock = body.includes('\n') || body.length > 120;

  const div = document.createElement('div');
  div.className = `message message-status${isBlock ? ' status-block' : ''}`;
  div.innerHTML = isBlock
    ? `<div class="status-body">${renderMarkdownish(body)}</div>`
    : `<span class="status-text">${escapeHtml(body)}</span>`;
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

/**
 * The agent's own checklist, pinned as one row you can open.
 *
 * The terminal draws this above the prompt because it reads `task.md` off
 * disk; the panel is a browser page and cannot, so the server pushes it at
 * turn boundaries. Kept to a single row collapsed, because the value is
 * "3 of 5, and which one is next" at a glance — the full list is a click away
 * and should not push the conversation off the screen to show you a plan you
 * have already read.
 *
 * Replaced rather than appended. A checklist is a *current state*, not an
 * event, and a transcript of sixteen versions of the same list is the mistake
 * the connection rows already made once.
 */
function renderTaskList(payload) {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  if (items.length === 0) return;

  const existing = document.getElementById('task-list');
  const wasOpen = existing?.classList.contains('open');
  existing?.remove();

  const done = Number(payload.done ?? items.filter((i) => i.done).length);
  const total = Number(payload.total ?? items.length);
  const next = items.find((i) => !i.done);

  const div = document.createElement('div');
  div.className = `task-list${wasOpen ? ' open' : ''}`;
  div.id = 'task-list';
  div.innerHTML = `
    <button class="task-summary" type="button">
      <span class="task-caret">▸</span>
      <span class="task-count">${done}/${total}</span>
      <span class="task-next">${escapeHtml(done === total ? 'all done' : (next?.text ?? ''))}</span>
    </button>
    <div class="task-items">
      ${items.map((i) => `
        <div class="task-item${i.done ? ' done' : ''}">
          <span class="task-box">${i.done ? '[x]' : '[ ]'}</span>
          <span class="task-text">${escapeHtml(i.text)}</span>
        </div>`).join('')}
    </div>`;

  div.querySelector('.task-summary').addEventListener('click', () => {
    div.classList.toggle('open');
    div.querySelector('.task-caret').textContent = div.classList.contains('open') ? '▾' : '▸';
  });
  if (wasOpen) div.querySelector('.task-caret').textContent = '▾';

  // Above the input, not in the transcript: it is state, and state does not
  // scroll away.
  inputArea.parentNode.insertBefore(div, inputArea);
}

/**
 * The handover review, folded.
 *
 * Every pro-tier reply now ends with a fixed `## Review` block — checklist,
 * what ran, callers checked, what is not done. It is the most important four
 * lines of the turn and also the least interesting to re-read, so it is
 * collapsed to its first fact with the rest a click away.
 *
 * Matched on the shape the prompt asks for rather than on wording, so
 * rephrasing the prompt does not silently stop this working.
 */
function splitReview(content) {
  const text = String(content ?? '');
  const at = text.search(/(^|\n)#{1,3}\s*Review\s*(\n|$)/i);
  if (at === -1) return { body: text, review: '' };
  return { body: text.slice(0, at).trimEnd(), review: text.slice(at).trim() };
}

function appendReview(review) {
  const div = document.createElement('div');
  div.className = 'review-block';
  const lines = review.split('\n').filter((l) => /^\s*[-*]\s/.test(l));
  const first = lines[0]?.replace(/^\s*[-*]\s*/, '') ?? 'Review';

  div.innerHTML = `
    <button class="review-summary" type="button">
      <span class="review-caret">▸</span>
      <span class="review-label">Review</span>
      <span class="review-first">${escapeHtml(first)}</span>
    </button>
    <div class="review-body">${renderMarkdownish(review)}</div>`;

  div.querySelector('.review-summary').addEventListener('click', () => {
    div.classList.toggle('open');
    div.querySelector('.review-caret').textContent = div.classList.contains('open') ? '▾' : '▸';
  });

  messageStream.appendChild(div);
  scrollToBottom();
}

// ── Blocking prompts ────────────────────────────────────────────────
//
// `ask_question` and a risky `run_command` park the turn on an unresolved
// promise server-side and send the prompt here. Until these existed the panel
// ignored both types, so the turn hung forever and the send button never came
// back — the panel looked like it had stopped sending prompts, which is how
// this was reported. Answering is therefore not a nicety: it is the only way
// the turn ever ends.

/**
 * Render a question the turn is parked on.
 *
 * The payload is **normalised by the server** (`core/question.js`), so a
 * question is always `{header, question, options: [{label, description}]}` and
 * `payload.questions` is always a non-empty array. That is deliberate: these
 * args are parsed out of model prose and nothing in them is guaranteed, and
 * the panel cannot import the server's rules, so the alternative was a second
 * copy of them here that would drift from the terminal's.
 *
 * The fallbacks below are for an *older server* talking to a newer panel, not
 * for a malformed model — one surface upgrading before the other is the
 * ordinary case when the extension is reloaded and the agent is not.
 */
function appendQuestion(payload) {
  removeThinking();
  const set = Array.isArray(payload?.questions) && payload.questions.length
    ? payload.questions
    : [payload || {}];

  const div = document.createElement('div');
  div.className = 'message message-question';
  div.id = 'question-prompt';

  div.innerHTML = set.map((q, i) => {
    const text = (typeof q === 'string' ? q : q?.question)
      || 'The agent asked a question, but sent no text.';
    const opts = (Array.isArray(q?.options) ? q.options : [])
      .map((o) => (typeof o === 'string' ? o : o?.label ?? o?.value ?? ''))
      .filter(Boolean);
    const header = typeof q === 'object' ? (q?.header || '') : '';
    return `
      <div class="question-block" data-q="${i}" data-question="${escapeHtml(text)}">
        ${header ? `<div class="question-header">${escapeHtml(header)}</div>` : ''}
        <div class="question-text">${escapeHtml(text)}</div>
        <div class="question-options">
          ${opts.map((o) => `<button class="question-option" data-value="${escapeHtml(o)}">${escapeHtml(o)}</button>`).join('')}
        </div>
        <input class="question-freeform" type="text" placeholder="or type your own answer…" />
      </div>`;
  }).join('');

  div.innerHTML += `
    <div class="question-actions">
      <button class="question-submit">Send answer</button>
      <button class="question-dismiss">Dismiss</button>
    </div>`;

  // Picking an option fills the free-text box, so there is exactly one place
  // the answer is read from and no way to submit two conflicting ones.
  div.querySelectorAll('.question-option').forEach((btn) => {
    btn.addEventListener('click', () => {
      const block = btn.closest('.question-block');
      block.querySelectorAll('.question-option').forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
      block.querySelector('.question-freeform').value = btn.dataset.value;
    });
  });

  // One answer per question, enforced here rather than by the disabled
  // attribute the close sets. A real browser will not fire click on a disabled
  // button, but that is the DOM enforcing a *protocol* invariant, and the cost
  // of being wrong is a second `question_response` for a promise that is
  // already resolved. A flag is one line and does not depend on the rendering.
  let answered = false;

  div.querySelector('.question-submit').addEventListener('click', () => {
    if (answered) return;
    const answers = [...div.querySelectorAll('.question-block')].map((block) => ({
      question: block.dataset.question,
      answer: block.querySelector('.question-freeform').value.trim(),
    }));
    if (answers.some((a) => !a.answer)) return;   // nothing to send yet
    answered = true;
    chrome.runtime.sendMessage({
      type: 'question_response',
      // One question answers as a bare string; several answer as the paired
      // array `answerQuestion` echoes back, because the model asked them
      // several tool results ago and pairing them itself is what it gets wrong.
      payload: { answer: answers.length === 1 ? answers[0].answer : answers },
    });
    closeQuestion(div, 'answered');
  });

  div.querySelector('.question-dismiss').addEventListener('click', () => {
    if (answered) return;
    answered = true;
    chrome.runtime.sendMessage({ type: 'question_response', payload: { cancelled: true } });
    closeQuestion(div, 'dismissed');
  });

  messageStream.appendChild(div);
  scrollToBottom();
}

/** Leave the question on screen as a record, but stop it being answerable twice. */
function closeQuestion(div, how) {
  div.removeAttribute('id');
  div.querySelectorAll('button, input').forEach((el) => { el.disabled = true; });
  const note = document.createElement('div');
  note.className = 'question-closed';
  note.textContent = how === 'dismissed' ? 'dismissed' : 'answered';
  div.appendChild(note);
  showThinking();
}

function appendCommandApproval(payload) {
  removeThinking();
  const { command = '', cwd = '', riskLevel = '', riskReason = '' } = payload || {};

  const div = document.createElement('div');
  div.className = 'message message-approval';
  div.innerHTML = `
    <div class="approval-head">Run this command? <span class="approval-risk risk-${escapeHtml(riskLevel)}">${escapeHtml(riskLevel)}</span></div>
    <pre class="approval-command">${escapeHtml(command)}</pre>
    ${cwd ? `<div class="approval-cwd">in ${escapeHtml(cwd)}</div>` : ''}
    ${riskReason ? `<div class="approval-reason">${escapeHtml(riskReason)}</div>` : ''}
    <div class="approval-actions">
      <button data-action="allow_once">Allow once</button>
      <button data-action="allow_always">Always allow</button>
      <button data-action="reject_once">Reject</button>
      <button data-action="reject_always">Never allow</button>
    </div>`;

  div.querySelectorAll('.approval-actions button').forEach((btn) => {
    btn.addEventListener('click', () => {
      chrome.runtime.sendMessage({
        type: 'command_approval_response',
        // The command rides along: `allow_always` / `reject_always` write it
        // into the persistent rules, and the server does not keep a copy.
        payload: { action: btn.dataset.action, command },
      });
      div.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      btn.classList.add('selected');
      showThinking();
    });
  });

  messageStream.appendChild(div);
  scrollToBottom();
}

/**
 * Streamed reply text, replacing the thinking dots as soon as there is any.
 *
 * Without this the panel showed "Thinking..." for the whole turn and then the
 * finished answer in one jump — every chunk crossed the socket to be dropped.
 */
function appendStreamChunk(payload) {
  const text = payload?.content ?? payload?.chunk ?? payload?.text ?? '';
  if (!text) return;
  removeThinking();
  let el = document.getElementById('stream-partial');
  if (!el) {
    el = document.createElement('div');
    el.className = 'message message-agent streaming';
    el.id = 'stream-partial';
    el.innerHTML = '<div class="message-content"></div>';
    messageStream.appendChild(el);
  }
  // The server sends the reply so far, not a delta.
  el.querySelector('.message-content').textContent = text;
  scrollToBottom();
}

function clearStreamPartial() {
  const el = document.getElementById('stream-partial');
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

// ── Incoming Message Handler ────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, payload } = message;

  switch (type) {
    // The dot in the status bar *is* the connection indicator. Writing a line
    // into the transcript as well meant the retry ladder — which fires
    // repeatedly by design while the agent is not running — filled the panel
    // with identical red rows and pushed the conversation off the top. A
    // status nobody asked for, repeated, is not information.
    case 'connection_status':
      updateConnectionUI(payload.connected);
      break;

    case 'status':
      if (payload.status === 'connected') {
        updateConnectionUI(true);
        if (payload.workspace) {
          currentWorkspace = payload.workspace;
          appendStatus(`Workspace: ${payload.workspace}`);
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

    case 'agent_response': {
      removeThinking();
      clearStreamPartial();
      isWaitingForResponse = false;
      sendBtn.disabled = false;
      reflectSendState();
      const { body, review } = splitReview(payload.content);
      if (body) appendMessage('agent', body);
      if (review) appendReview(review);
      break;
    }

    // State, not an event — see renderTaskList.
    case 'task_list':
      renderTaskList(payload);
      break;

    // Streaming text. Every chunk used to cross the socket and land in the
    // `default:` branch below, which drops it — so the panel sat on "Thinking…"
    // for the whole turn and then jumped to the finished answer.
    case 'response_stream':
      appendStreamChunk(payload);
      break;

    // The two that park the turn. Neither was handled, and neither can time
    // out, so the first one to arrive ended the panel's usefulness for the
    // rest of the session.
    case 'ask_question':
      appendQuestion(payload);
      break;

    case 'request_command_approval':
      appendCommandApproval(payload);
      break;

    // Sent when the CLI answers an approval, so both surfaces agree.
    case 'command_approval':
      removeThinking();
      break;

    // The one GitHub message that actually reaches here. `processing_started`,
    // `processing_finished` and `notification` are pushed to a CLI-only buffer
    // and never broadcast, so there is nothing for the panel to handle.
    case 'github_plan_generated': {
      const who = payload?.comment?.author ? `@${payload.comment.author} commented` : 'plan written';
      appendStatus(`PR #${payload?.prNumber ?? '?'} · ${who}`);
      break;
    }

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
      reflectSendState();
      if (payload.message) {
        appendStatus(payload.message);
      }
      break;

    // No native chooser on that machine, so fall back to typing the path.
    case 'error':
      if (payload?.op === 'pick_workspace' && payload?.unavailable) {
        appendStatus(payload.message);
        promptForWorkspace();
        break;
      }
      removeThinking();
      isWaitingForResponse = false;
      sendBtn.disabled = false;
      reflectSendState();
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

/**
 * Escape for HTML, **including attribute context**.
 *
 * This used to be `div.textContent = str; return div.innerHTML`, which is the
 * idiom everyone reaches for and which does not escape quotes — that round trip
 * only has to survive re-parsing as *text*. Every template here interpolates
 * into attributes as well (`data-value="…"`, `class="risk-…"`), and a quote
 * there closes the attribute and everything after it is parsed as markup:
 *
 *     options: ['" onmouseover="…']   ->   <button data-value="" onmouseover="…">
 *
 * Verified, not theorised — jsdom parsed exactly that into a real event
 * handler on the button. It matters here more than on an ordinary page: this
 * text is *scraped off gemini.google.com*, so it is third-party input, and the
 * side panel is an extension page with `chrome.*` in scope.
 *
 * Explicit replacement rather than the DOM round trip, so the rule is visible
 * and the function does not need a document.
 */
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
