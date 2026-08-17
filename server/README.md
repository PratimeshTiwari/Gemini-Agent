# Gemini Agent Server

A local orchestration engine that acts as the bridge between your filesystem and the Gemini Web UI. It provides powerful agentic coding capabilities directly in your local terminal.

## Setup Instructions

If you are running this on a corporate or locked-down laptop where `npm install -g` is not allowed, you can run this tool entirely locally.

### 1. Install Dependencies
Navigate to the `server` directory and install the local packages:
```bash
cd server
npm install
```

### 2. Run the Agent Locally
You can start the agent directly using npm scripts. It will default to using the parent directory (`../`) as the workspace.
```bash
npm start
```

**To specify a different workspace:**
```bash
npm start -- --workspace /path/to/your/project
```

### 3. Alternative: `npx` execution
Because this package defines a `bin` entry in `package.json`, you can run it from anywhere using `npx` pointing to this directory:
```bash
npx /path/to/Gemini-Agent/server --workspace .
```

## Features
- **Context Engine:** Automatically tracks tokens, minifies code, and chunks ASTs using Acorn to keep the LLM context lean.
- **Session Persistence:** Conversation histories are automatically saved to `~/.gemini-agent/sessions/`. You can close and reopen the terminal without losing your chat.
- **Workspace File Watcher:** Modifying files externally (e.g. in VS Code) automatically notifies the agent to keep its context fresh.
- **Skills Framework:** Built-in modular skills that the agent can execute securely.
