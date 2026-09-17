# Gemini-Agent as a Personal "Cursor-like" Tool

This tool is highly useful as a "Cursor-like" assistant for personal projects, but it takes a fundamentally different architectural approach. It functions more like Cursor's "Composer" feature rather than its inline autocomplete.

Here is a breakdown of why it fits that use case, and the trade-offs involved:

## Why it is great for personal projects
1. **Zero API Costs:** By driving a real browser tab via a Chrome extension (`extension/`), it leverages the Gemini web interface directly. This bypasses the heavy API costs usually associated with autonomous coding agents.
2. **Deep System Access:** It is built to execute real work. It has tools to read/search the codebase, edit files (via a safe diff engine that requires approval), and execute terminal commands.
3. **Editor Awareness:** It includes a `vscode-companion/` extension that allows the CLI agent to read your current active file, cursor position, and visible text, giving it context similar to an integrated IDE.
4. **Autonomous Workflows:** Unlike a simple chat window, it operates in an "agent loop" and can autonomously plan, investigate, and implement multi-step changes.

## How it differs from Cursor (The Trade-offs)
1. **CLI vs. Native IDE:** Cursor is a customized fork of VS Code with integrated UI panels. This tool is a Terminal UI (built with React/Ink) that runs *alongside* your standard editor.
2. **No Inline Autocomplete:** Cursor provides real-time "ghost text" as you type. This tool does not; it is designed for conversational task execution (e.g., "Refactor this module" or "Find and fix this bug").
3. **Brittle Transport Layer:** Because it scrapes the streamed reply from `gemini.google.com` rather than using a stable API, it is inherently more brittle. If Google changes their DOM structure, the Chrome extension bridge may temporarily break until updated.

## The Verdict
If you want a powerful, autonomous coding assistant for personal projects without paying a monthly subscription or racking up LLM API bills—and you don't mind working via a terminal CLI alongside your editor—this is an excellent tool. If seamless, zero-latency inline autocomplete is your main priority, Cursor remains the better fit.
