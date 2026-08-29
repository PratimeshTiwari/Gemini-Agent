# Gemini Agent - LLM Context & Architecture Guide

Welcome! If you are an LLM or an AI agent reading this file, this document is designed to give you a complete, high-level understanding of this repository's architecture, dependencies, and core concepts. Use this to orient yourself before making code changes.

## 🎯 Project Overview
`Gemini-Agent` is a multimodal, autonomous agent system designed to interact with both the file system (via Node.js) and the web browser (via a custom Chrome Extension). It leverages the Gemini API natively and supports Local LLM fallback. The agent operates through a rich, interactive Command Line Interface (CLI) built with `ink` and React.

## 🏗️ Architecture & Core Components

The repository is split into three main packages:
1. **`server/`**: The core Node.js backend & CLI UI.
2. **`extension/`**: A Manifest V3 Chrome Extension for DOM interaction.
3. **`vscode-companion/`**: A tiny VS Code extension to feed editor state (active file, cursor position) to the agent.

---

### 1. The Server (`server/`)
This is the brain of the agent. It handles the main execution loop, tool executions, and rendering the terminal UI.

- **Stack**: Node.js, `tsx` (for ESM/TypeScript support), `ink` (React for CLI), `marked` & `marked-terminal` (Markdown rendering).
- **Entry Points**: 
  - `server/src/index.js`: The executable bin (maps to `gemini-agent`). It wraps the execution in `tsx` to support JSX.
  - `server/src/main.js`: Initializes the WebSocket server and mounts the `App.jsx` React component.
- **Agent Core**:
  - `server/src/agent-loop.js`: The `AgentLoop` class manages the execution lifecycle. It intercepts user queries, manages the conversation history, processes streaming responses from the LLM, and dispatches tool calls.
  - `server/src/prompt-builder.js`: Dynamically constructs the intricate system prompt. It injects active editor context, AST workspace structures, subagent topology instructions, and handles `/reasoning` profiles.
  - `server/src/local-llm.js`: Wraps `node-llama-cpp` to allow the agent to seamlessly switch from cloud APIs to local models (`/localllm`).
  - `server/src/ui/App.jsx`: The React UI. It uses a virtualized history array to prevent terminal tearing, handles infinite scrolling, and intercepts slash commands (e.g., `/plan`, `/mode`) by rendering interactive `SelectInput` menus.
- **Tooling (MCP)**:
  - Located in `server/src/mcp/tools/`. Implements the Model Context Protocol. Tools include `run_command`, `edit_file`, `read_file`, etc.

### 2. The Browser Extension (`extension/`)
This connects the Node.js backend to the user's Chrome browser, enabling the agent to read DOM structures, inject scripts, and navigate pages.

- **Stack**: Chrome Extension Manifest V3, `esbuild` (for bundling).
- **Key Files**:
  - `extension/src/background/main.js`: The entry point that initializes the WebSocket bridge and state manager.
  - `extension/src/background/socket.js`: Maintains a persistent WebSocket connection to the Node.js server (defaults to port 7777).
  - `extension/src/background/state.js`: Manages the extension's internal state (active tabs, recording status).
  - `extension/content-scripts/gemini-bridge.js`: Injected into webpages to execute arbitrary JavaScript, extract DOM, or click elements on behalf of the agent.

### 3. Context & Intelligence
- **Workspace Indexer** (`server/src/context/WorkspaceIndexer.js`): Uses AST parsing (via `tree-sitter`) to generate a structural map of the user's project, feeding dependencies and exports directly into the system prompt.
- **Risk Classifier** (`server/src/risk-classifier.js`): Intercepts generated commands and tool calls to determine if they require explicit user approval (e.g., `rm -rf`, `git push`) via the `App.jsx` UI.

## 🔄 Data Flow (How an Agent Turn Works)
1. **Input**: The user types a query into the `App.jsx` CLI or the editor state triggers an update.
2. **Prompt Construction**: `agent-loop.js` calls `prompt-builder.js` to assemble the context.
3. **Inference**: The request is sent to the LLM (either Gemini Cloud or Local LLM).
4. **Streaming**: As chunks return, `response_stream` events are emitted to `App.jsx` to render the output dynamically.
5. **Tool Execution**: If the LLM returns JSON tool calls, `agent-loop.js` intercepts them, executes the corresponding script in `server/src/mcp/tools/`, and appends the result back to the LLM context.
6. **Browser Actions**: If a browser tool is called, the request travels via WebSocket to the `extension/src/background/socket.js`, which proxies it to `gemini-bridge.js` in the active tab.

## 🛠️ Styling & UI Quirks
- The CLI uses **raw ANSI escape sequences** for styling instead of relying entirely on `marked-terminal`, specifically to bypass bugs where inline Markdown (`**`) breaks inside list items. If you add UI text, you can use `\x1b[1m` for bold and `\x1b[32m` for green.
- **Performance**: We avoid re-rendering the entire React tree during LLM streaming. The CLI only updates a tiny status string or relies on native stdout piping to maintain high FPS and prevent scroll glitches.

## 📋 Common Commands
- **Start the agent**: `gemini-agent` (or `npm run dev` in `server/`)
- **Slash Commands**: `/reasoning`, `/localllm`, `/mode`, `/restart`, `/clear`. These are parsed in `App.jsx` and affect the `AgentLoop` configuration state.

Read this document whenever you need a mental model of how components interoperate. When fixing bugs, always check if the logic belongs in the UI (`App.jsx`), the brain (`agent-loop.js`), or the browser (`extension/`).
