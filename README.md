# Agent CLI 🤖

A powerful, Claude Code-style autonomous coding agent that runs locally and connects directly to web-based AI chat interfaces (Gemini, ChatGPT, and Claude) via a Chrome Extension bridge. It operates in your local workspace, edits your files, and executes commands just like an expert AI pairing programmer.

## ✨ Latest Features

- **Multi-Agent Topologies**: Choose how your agents collaborate to solve complex problems!
  - **Solo Agent**: A single agent handles all planning, research, and implementation.
  - **Duo System**: A primary agent implements, while a Reviewer subagent audits code and checks for security/correctness.
  - **Swarm System**: An Orchestrator coordinates with a Reasoner (for architectural planning) and a Reviewer (for verification).
- **Background Task Manager (Terminal Capabilities)**: 
  - `run_background`: Spawn long-running background processes (dev servers, builds, watchers).
  - `manage_task`: Monitor logs in real-time, send `stdin` inputs to interactive prompts, and kill running background processes.
- **Command Allowlist & Blocklist**: Persistent rules that automatically approve or reject commands based on your preferences, saving you from repetitive prompts. Manage them easily with the `/allowlist` command.
- **Agentic Background RAG & Context Routing**: Automatically chunks and indexes your workspace codebase on startup using a built-in, lightweight TF-IDF indexer. The agent can use `semantic_search` to find code concepts, and automatically routes to detailed flow documentation based on a centralized `summary.md` context index.
- **Self-Correction & Auto-Learning**: If you point out a mistake in a documented flow, the agent verifies it against the code, corrects the markdown file, and permanently commits the verified fact to its long-term RAG memory to avoid making the same mistake twice.
- **Editor State Awareness**: The agent knows what you are currently looking at! A companion VS Code extension tracks your active file, cursor position, and visible text, allowing the agent to read your editor context instantly.
- **Robust Model Bridges**: Improved Chrome Extension bridges for Gemini, ChatGPT, and Claude, complete with smart retries, frozen tab activation, and real-time streaming response handling. The extension is now heavily modularized and bundled automatically via `esbuild`.
- **Tiered Model Profiles**: A dynamic system prompt that adjusts its complexity based on the model tier you select.
  - `⚡ Flash`: Ultra-concise, fast instructions for simple tasks (optimized for Gemini 2.5 Flash).
  - `🧠 Flash Thinking`: Moderate depth with a 3-phase reasoning protocol.
  - `🔬 Pro`: Full principal-engineer protocol with mandatory chain-of-thought, task classification, and anti-hallucination guardrails.
- **GitHub PR Agent**: Integrates deeply with your PR workflows. Features a rigorous 4-phase investigation protocol, task classification, and structured outputs for reviewing PRs autonomously.
- **Interactive CLI UI**: An elegant, terminal-based interface with real-time streaming output, unified diff approvals, long-running process monitors, and a high-performance virtual "sliding window" to gracefully handle infinite scroll history without terminal tearing.
## 🚀 Setup

### 1. Prerequisites

- [Node.js](https://nodejs.org/) v18 or newer
- Google Chrome
- A logged-in tab on gemini.google.com (the agent has no API key — it drives your own browser session)

### 2. Install

```bash
git clone <this repo>
cd Agent-CLI
npm install                    # installs the server and extension workspaces
```

### 3. Make `agent-cli` work from any folder

```bash
npm link --workspace=server
```

That puts two commands on your `PATH`, both pointing at the same program:

| Command | |
| --- | --- |
| `agent-cli` | the full name |
| `agent` | short alias, type this one |

**The workspace is whatever directory you are standing in.** There is no
per-project setup and no config to point at a folder:

```bash
cd ~/code/xyz
agent-cli            # xyz is now the workspace — it reads and edits files here
```

Check it worked:

```bash
which agent-cli      # -> .../bin/agent-cli
agent-cli --help
```

<details>
<summary>If the command isn't found</summary>

- Your shell may be caching an old lookup. Run `hash -r` (zsh/bash) or open a new terminal.
- `npm link` installs into your **current Node version's** bin directory. If you switch Node
  versions with `nvm`, re-run `npm link --workspace=server` on the new version.
- Upgrading from an older checkout? The command used to be `gemini-agent`. It was renamed —
  use `agent-cli`, and remove any old shell alias pointing at the previous name.

</details>

To work on a different directory without `cd`-ing there, pass it explicitly:

```bash
agent-cli --workspace ~/code/other-project
agent-cli --continue                       # resume the last session here
agent-cli --port 7788                      # if 7777 is taken
```

### 4. Install the Chrome extension bridge

This is what makes the agent work without an API key: it types your prompt into a
real chat tab and scrapes the reply back.

1. Open `chrome://extensions/`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the **`extension/`** folder in this repository.
4. It appears as **Agent CLI Bridge** — pin it to your toolbar so you can see its status.
5. Open [gemini.google.com](https://gemini.google.com) and sign in. Leave the tab open.

The CLI shows `🟢 Agent` in its status bar once the extension connects. While it shows
`🟡`, the tab isn't open or the extension isn't loaded.

> If you edit anything under `extension/src/background/`, rebuild the bundle —
> Chrome loads `extension/service-worker.js`, not the sources:
> ```bash
> npm run build --workspace=extension
> ```

### 5. (Optional) VS Code companion

Four things, all of which the agent can use immediately:

- **Editor state** — the file you're in and where the cursor is.
- **Diagnostics** — the Problems panel. The agent reads your TypeScript and ESLint errors
  with `get_diagnostics` instead of running a build, and uses it to check its own edits.
- **Add to Agent Chat** — select code, hit `cmd+alt+L` (or right-click → *Add to Agent Chat*),
  and it lands on your prompt as `@client.js:12-40`. The full text goes to the model on
  submit; only the marker sits in the terminal.
- **Plan review** — a plan opens with `✅ Approve · 📤 Submit review · ❌ Reject` at the top and
  `💬 Comment` on every heading. Leave comments on the sections that need changing and submit,
  and the agent revises the plan against all of them at once — the way you'd review a PR.
  Approving with no comments is still one click.

To install:

1. In VS Code, open the Extensions panel (`Cmd+Shift+X`).
2. `...` menu → **Install from VSIX...**
3. Pick `vscode-companion/cli-agent-companion-1.2.0.vsix`.

It talks to the CLI through files in `.agent/state/`, so it works whether or not the agent is
running — a selection queued before you start `agent-cli` is waiting for you when you do.

### 6. First run

```bash
cd ~/code/your-project
agent-cli
```

Type a request and press Enter. In **plan mode** (the default) every file edit is shown
as a diff you approve; `shift+tab` switches to **auto mode**, which applies safe edits
on its own.

Handy keys: `ctrl+e` expand/collapse all steps · `ctrl+t` shell · `ctrl+o` GitHub tab ·
`esc` stop the run · `/help` for everything else.

## 🧩 Skills

A skill is a markdown file of instructions the agent reads **only when it is relevant**,
so you can write as many as you like without bloating every prompt. Only the one-line
`description` is ever in the system prompt; the agent opens the file itself when that
description matches what it is doing.

```bash
/skills                       # browse, open, or create
/skills new code-review       # scaffold one for this project and open it
/skills new --global deploy   # one you want in every project
/skills list
/skills dir                   # show the folders skills are loaded from
/skills dir add ~/my-skills   # load skills you keep somewhere else
```

The search walks **up** from your project, the way git finds `.git`. The nearest definition
of a name wins, so a repo overrides its parent and the parent overrides your personal set —
with no configuration:

```
~/.agent/skills/                    yours, everywhere
/work/coindcx/.agent/skills/        every repo under coindcx
/work/coindcx/api/.agent/skills/    just this repo  ← wins
```

That is what makes a monorepo work: put a skill in `/work/coindcx/.agent/skills/` and every
repo underneath picks it up. `/skills dir add` stays for skills kept outside the tree
entirely — a shared git repo of them, say.

A skill looks like this:

```markdown
---
name: code-review
description: Reviewing a diff or a pull request before it merges.
---

# Code review

## When to use it
...

## Steps
1. ...
```

## 🔁 Self-healing background tasks

The agent can start a long-running process and be woken when it breaks, instead of having to
remember to check:

```
run_background   npm run dev          → starts it, returns a task id
manage_task      watch  <task id>     → wake me if this logs a failure
```

When a watched task logs something that looks wrong — `error`, `failed`, `exception`,
`EADDRINUSE`, `Cannot find module`, or a pattern you supply — the agent starts a turn on its
own with the failing lines and their surrounding output already in hand, reads the code, and
fixes it. It fires once per fault, not once per line, and never interrupts a turn already in
progress.

The same instinct applies to ordinary commands: a non-zero exit is marked `status="failed"` in
what the model sees, with an instruction to diagnose and fix rather than report. That is
bounded — four consecutive failing rounds ends the turn, lists the actual errors and asks you,
rather than burning a session on variations of one broken command.

**A limit worth knowing:** the agent cannot read your *other* terminal windows. Those belong to
your terminal emulator and there is no API for them. Run the process through `run_background`
so the agent owns the pipe, or point it at a log file.

## ⚙️ Configuration & Commands

Once the agent is running, you can use built-in slash commands to manage your session:
- Type `/help` in the CLI to see all available commands.
- Type `/mode` to switch between Solo, Duo, and Swarm agent topologies.
- Type `/config` to configure which web models (Gemini, Claude, ChatGPT) act as your primary, reasoner, and reviewer agents.
- Type `/model <flash|flash-thinking|pro>` to dynamically adjust the cognitive effort and prompt complexity (optimizing for the model you select in your browser tab).
- Type `/allowlist` to view and manage your auto-approved and auto-rejected command rules.

## 📂 Where the agent keeps its files

Everything the agent writes into a workspace lives in one directory, `.agent/`:

```
<your project>/.agent/
├── config.json        # topology, model roles, command allowlist, agent name
├── memory.json        # long-term memory (/memory)
├── rules.md           # your custom workspace instructions (/init-skills)
├── skills/            # one .md per skill (/skills)
├── artifacts/         # task.md, plan.md, walkthrough.md — written for you to read
├── state/             # editor.json, github.json, plan-approval.json
├── backups/           # file backups powering /undo
├── context/summary.md # background RAG index
├── github-pr-plans/   # GitHub PR agent output
├── sessions/          # conversation history (local copy)
└── logs/agent.log
```

Your conversation history is saved **twice**: once next to the project in
`.agent/sessions/`, and once in `~/.agent/workspaces/<project>-<hash>/`. The second
copy means a clean checkout or a deleted `.agent/` folder doesn't lose your history —
whichever copy has more turns wins on startup and rebuilds the other. Override the
home location with `AGENT_CLI_HOME`.

Earlier versions spread this across `.gemini/`, `.gemini-agent/` and
`.agent-github-plans/`. The agent migrates those into `.agent/` automatically the
first time it starts in a workspace, and prints a one-line summary when it does.
