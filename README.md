# Gemini Agent 🤖

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
## 🚀 How to Setup

### 1. Prerequisites
- [Node.js](https://nodejs.org/) (v18 or higher recommended)
- Google Chrome browser

### 2. Install the Server
1. Clone this repository.
2. Install the dependencies for the local server and the extension workspaces:
   ```bash
   npm install
   ```
3. *(Optional)* To make the `gemini-agent` CLI command globally available from anywhere, link the server package:
   ```bash
   npm link --workspace=server
   ```

### 3. Install the Chrome Extension Bridge
1. Open Google Chrome and go to `chrome://extensions/`.
2. Enable **Developer mode** (toggle in the top right corner).
3. Click **Load unpacked** and select the `extension` folder located inside this repository.
4. Ensure the extension is enabled. (You may want to pin it to your toolbar).

### 4. (Optional) Install the VS Code Companion Extension
To enable Editor State Awareness (so the agent knows your cursor position and active file):
1. Open VS Code.
2. Go to the Extensions panel (`Cmd+Shift+X`).
3. Click the `...` menu at the top right and select **Install from VSIX...**
4. Select the `vscode-companion/gemini-agent-companion-1.0.0.vsix` file from this repository.

### 5. Running the Agent
1. Open your terminal and navigate to the project directory you want the agent to work on.
2. Start the agent server:
   ```bash
   npm run start
   ```
   *(If you ran `npm link` earlier, you can simply type `gemini-agent` in any directory).*
3. The server will launch and automatically attempt to open your default model's web interface (e.g., `gemini.google.com`) in Chrome.
4. The Chrome extension will connect to the local server via WebSockets.
5. You're ready to start coding! Use the terminal UI to interact, approve file diffs, and spawn background tasks.

## ⚙️ Configuration & Commands

Once the agent is running, you can use built-in slash commands to manage your session:
- Type `/help` in the CLI to see all available commands.
- Type `/mode` to switch between Solo, Duo, and Swarm agent topologies.
- Type `/config` to configure which web models (Gemini, Claude, ChatGPT) act as your primary, reasoner, and reviewer agents.
- Type `/model <flash|flash-thinking|pro>` to dynamically adjust the cognitive effort and prompt complexity (optimizing for the model you select in your browser tab).
- Type `/allowlist` to view and manage your auto-approved and auto-rejected command rules.
