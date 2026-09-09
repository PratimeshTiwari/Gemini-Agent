# Gemini-Agent Folder Structure

This document outlines the current folder structure and architecture for the Gemini-Agent project.

## 📁 Root Directory
The workspace is organized into three main monorepo-style packages, along with global configuration files.

```text
.
├── extension/          # Browser Extension (Chrome/Edge)
├── server/             # Node.js Local Server (Core Agent Logic)
├── vscode-companion/   # VS Code Extension (Editor Context Provider)
├── AGENT.md            # Context/Instructions for Agent CLI
├── CLAUDE.md           # Instructions/Guidelines for LLMs
└── package.json        # Root package dependencies and scripts
```

---

## 🧩 1. Browser Extension (`/extension`)
Provides the user interface and interacts with the web browser.

```text
extension/
├── content-scripts/    # Scripts injected into web pages (DOM manipulation)
├── side-panel/         # UI for the browser's side panel (HTML/CSS/JS or framework)
├── src/                # Shared source code/utilities for the extension
├── service-worker.js   # Background script managing state and external API calls
├── manifest.json       # Browser extension manifest (V3)
└── package.json        # Extension specific dependencies
```

## ⚙️ 2. Local Server (`/server`)
The core intelligence layer. It hosts the LLM interactions, tool executions, and file system access.

```text
server/
├── src/                # Core server logic
│   ├── index.js/ts     # Entry point
│   ├── tools/          # Tool implementations (read_file, run_command, etc.)
│   └── agent/          # Agent prompt management and loop logic
├── README.md           # Server specific documentation
└── package.json        # Server dependencies (Express, LLM SDKs, etc.)
```

## 💻 3. Editor Companion (`/vscode-companion`)
A lightweight bridge to fetch context from the developer's IDE.

```text
vscode-companion/
├── extension.js        # Main logic for retrieving active file, cursor position, and visible text
├── package.json        # VS Code extension configuration
└── *.vsix              # Packaged installable extension file
```

---

## 🚀 Planned Refinements / Future Considerations
1. **Shared Types/Utils**: Consider a `/shared` directory at the root if Typescript interfaces or common utility functions are duplicated across `extension`, `server`, and `vscode-companion`.
2. **Artifacts Directory**: A `.agent/` folder could be standardized to hold task plans, logs, and mistakes (as referenced in `AGENT.md`/System Prompt).
3. **Tests**: Establish `__tests__` or `tests/` directories within each package to maintain unit and integration tests.
