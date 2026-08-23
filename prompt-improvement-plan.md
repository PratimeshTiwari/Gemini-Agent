# System Prompt Improvement Plan

## 1. Dynamic Tool Injection (Decoupling)
Currently, the tool definitions inside `server/src/prompt-builder.js` (specifically `_buildToolDefinitions`) are hardcoded as strings.
* **Action:** Refactor this method to fetch tool descriptions dynamically from `server/src/skills/SkillRegistry.js` or the MCP server tools.
* **Benefit:** Whenever a new tool is added to the codebase, the system prompt will automatically include it without requiring manual updates to `prompt-builder.js`.

## 2. Strict XML Structuring & Context Tagging
While the prompt currently uses tags like `<system>` and `<available_tools>`, other context injections are appended as plain text brackets (e.g., `[Workspace: ... | Mode: ...]`).
* **Action:** Standardize all context injections into strictly formatted XML with attributes (e.g., `<system mode="plan" topology="single" workspace="/path/to/workspace">`). Ensure that `<workspace_context>`, `<workspace_rules>`, and `<agent_instructions>` are perfectly aligned and nested.
* **Benefit:** Large language models parse strict XML boundaries more effectively, reducing context bleed and improving instruction adherence.

## 3. Enhanced Self-Correction Guidelines
The current prompt tells the agent: *"If a tool call fails, analyze the error and retry."* This is a good baseline but can be heavily optimized.
* **Action:** Add explicit self-correction patterns to the Core Principles.
  * *Example 1:* "If `edit_file` fails due to an `oldText` mismatch, you MUST use `read_file` to fetch the exact lines before retrying."
  * *Example 2:* "If `run_command` throws a missing dependency error, you MUST install it using npm."
* **Benefit:** Prevents the agent from getting stuck in looping errors or repeatedly guessing file contents.

## 4. Context-Aware Condensed Reminders
The `_buildCondensedReminder` (sent every 10 turns to save tokens) is currently entirely static.
* **Action:** Inject the **current task state** or active goal into this condensed reminder. If the agent is working on a long-running sub-task, this ensures it doesn't lose sight of the overarching objective when the full system prompt is compacted.
* **Benefit:** Improves focus and continuity in long chat sessions.

## 5. Role & Sub-Agent Prompt Refinement
If the agent is running in `duo` or `swarm` topologies, the sub-agent wrappers (Reasoner/Reviewer) can be improved.
* **Action:** Enhance `buildSubagentWrapper` to force the sub-agents to output their responses in a structured JSON or strict markdown format that the primary agent can easily parse and synthesize.
* **Benefit:** Streamlines inter-agent communication and reduces formatting errors.
