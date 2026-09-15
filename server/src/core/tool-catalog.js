/**
 * Every tool the model is told about, declared once.
 *
 * There used to be three hand-kept lists and an array, and nothing made them
 * agree. `mcp/mcp-server.js` holds `TOOL_DEFINITIONS` — name, schema, handler —
 * which is what actually *runs*. What the model is *told* came from two prose
 * blocks in `prompt-builder.js` (one per tier) plus a third inside
 * `agent-loop.js`'s `runHeadlessTask`, all written by hand. And five tools —
 * `ask_question`, `ask_subagent`, `ask_researcher`, `ask_reviewer`,
 * `manage_memory` — are dispatched straight out of `agent-loop.js` and appeared
 * in no array at all.
 *
 * The cost was not hypothetical. `recall_history` and `get_diagnostics` were
 * both registered, implemented, tested and **completely unreachable**: nobody
 * had added them to the prose, and a tool the model is never told about does
 * not exist. A guard test catches that now in both directions, but a guard is a
 * smoke alarm. This is the missing fire escape: one list, and the prompt is
 * assembled from it rather than transcribed alongside it.
 *
 * What is deliberately *not* here: the schemas. `TOOL_DEFINITIONS` keeps those,
 * because they are what `validateArgs` checks and what the handlers receive, and
 * a second copy would be the same drift again in a new place. This file says
 * which tools exist and how each is described to each tier; that file says what
 * each one accepts. `toolCatalogDrift()` is what keeps the two honest.
 *
 * **The text below is the contract.** The model reads it and nothing reconciles
 * a description against what the handler really does, so editing an entry here
 * changes behaviour as surely as editing code. It was moved out of
 * `prompt-builder.js` byte-for-byte; `tool-catalog.test.js` pins that.
 */

/** @typedef {{name: string, dispatch: 'mcp'|'loop', when?: 'duo', lead?: string, flash: string|Function, pro: string|Function}} ToolDoc */

/** In prompt order, which is the order the model sees. */
export const TOOL_CATALOG = [
  {
    name: 'ask_question',
    dispatch: 'loop',
    flash: ` — Ask the user to choose. Blocks until they answer. Args: question (string), options (string[], 2-4 concrete choices), header (string, 2-3 word topic). Several at once: questions ([{question, options, header}], max 4)
`,
    pro: `
Put a decision to the user. Execution blocks until they answer, so this is the ONLY way to reach
them mid-task — a question written in prose is not a question, it just ends your turn.

Ask when the answer changes what you build and you cannot settle it from the code: which of two
designs they want, which of several files they meant, whether a destructive step is intended.
Do NOT ask what you could find out yourself with read_file or grep_search, and do NOT ask for
permission to continue — that is what plan mode and the approval prompts are for.

Write options the user can choose between without reading your mind: each one a concrete course
of action ("Rewrite the parser to stream"), never a bare yes/no restatement of the question. Two
to four is the useful range. The user can always type an answer you didn't list, or dismiss the
question — if they dismiss it, pick the most reasonable reading, say which assumption you made,
and carry on.

If you have more than one thing to settle, ask them ALL IN ONE CALL via \`questions\`. Asking
them one at a time costs a full round trip each and makes the user answer, wait, answer again.

Parameters — one question:
  - question (string, required): The decision, in one sentence
  - options (array of strings, required): 2-4 concrete choices
  - header (string, optional): 2-3 words naming the topic, shown as the prompt's title

Parameters — several at once (preferred whenever you have more than one):
  - questions (array, max 4): [{ question, options, header }] — same fields as above.
    The user answers them in sequence and you get every answer back in a single result.

Example:
\`\`\`json
{"name": "ask_question", "args": {"questions": [
  {"header": "Storage", "question": "Where should the cache live?", "options": ["In .agent/cache", "In the system temp dir"]},
  {"header": "Eviction", "question": "How should it be bounded?", "options": ["By age", "By total size"]}
]}}
\`\`\`

`,
  },
  {
    name: 'search_files',
    dispatch: 'mcp',
    flash: ` — Find files by name. Args: query (string)
`,
    pro: `
Search for files by name or path pattern using fuzzy matching.
Parameters:
  - query (string, required): File name or path pattern to search for
  - maxResults (number, optional): Max results to return (default: 20)

`,
  },
  {
    name: 'grep_search',
    dispatch: 'mcp',
    flash: ` — Search text across files, grouped by file. Args: pattern (string or string[] — pass several terms when unsure of the wording), isRegex? (bool), includes? (string[]), contextLines? (number)
`,
    pro: `
Search file contents across the codebase, like ripgrep. Results come back grouped by file,
the file with the most matches first.

When you do not know what *this* codebase calls something, search several names at once:
\`{"pattern": ["rate limit", "throttle", "quota"]}\` is one search, not three. Guessing one
term at a time costs a full round trip per guess.

Parameters:
  - pattern (string or array of strings, required): term(s) to find; an array searches for
    any of them
  - isRegex (boolean, optional): treat every pattern as a regex
  - includes (array of strings, optional): globs to restrict the search (e.g. ["*.js"])
  - maxResults (number, optional): max matches (default 50, max 500)
  - contextLines (number, optional): lines of surrounding code per match (0-5, default 0).
    Use it when a bare line would not tell you whether the match is the right one — it is
    cheaper than reading the whole file to find out.

`,
  },
  {
    name: 'read_file',
    dispatch: 'mcp',
    flash: ` — Read a file. Args: path (string), startLine? (number), endLine? (number)
`,
    pro: `
Read the contents of a file with optional line range.
Parameters:
  - path (string, required): File path relative to workspace root
  - startLine (number, optional): Start line (1-indexed)
  - endLine (number, optional): End line (1-indexed)

`,
  },
  {
    name: 'edit_file',
    dispatch: 'mcp',
    flash: ` — Edit a file. Args: path (string), edits ([{oldText, newText}])
`,
    pro: `
Propose edits to an existing file. Generates a diff for user approval.
Parameters:
  - path (string, required): File path to edit
  - edits (array, required): Array of { oldText: string, newText: string } objects.
    oldText is the exact text to find, newText is what to replace it with.

`,
  },
  {
    name: 'create_file',
    dispatch: 'mcp',
    flash: ` — Create a file. Args: path (string), content (string)
`,
    pro: `
Create a new file with specified content.
Parameters:
  - path (string, required): File path to create
  - content (string, required): Full file content

`,
  },
  {
    name: 'list_directory',
    dispatch: 'mcp',
    flash: ` — List dir contents. Args: path? (string), recursive? (bool)
`,
    pro: `
List directory contents.
Parameters:
  - path (string, optional): Directory path (default: workspace root)
  - recursive (boolean, optional): List recursively
  - maxDepth (number, optional): Max depth for recursive listing (default: 3)

`,
  },
  {
    name: 'run_command',
    dispatch: 'mcp',
    flash: ` — Run shell command (needs approval). Args: command (string), cwd? (string)
`,
    pro: `
Execute a shell command. Always requires user approval.
Parameters:
  - command (string, required): Shell command to execute
  - cwd (string, optional): Working directory
  - timeout (number, optional): Timeout in seconds (default: 30)

`,
  },
  {
    name: 'open_in_editor',
    dispatch: 'mcp',
    flash: ` — Open file in editor. Args: path (string), line? (number)
`,
    pro: `
Open a file in the user's code editor.
Parameters:
  - path (string, required): File path to open
  - line (number, optional): Line number to jump to

`,
  },
  {
    name: 'manage_memory',
    dispatch: 'loop',
    flash: ` — Remember/forget a durable fact. Args: action ("add"|"remove"), fact? (string), index? (number, the number shown in <memory>)
`,
    pro: `
Remember a fact about this project, or forget one. Stored in \`.agent/memory.md\` and given
back to you in the \`<memory>\` block at the start of a session.

Remember something you had to *work out* and would have to work out again: that the tests
run with pnpm, that a directory is generated. Not what you can read at any time — a file's
contents, a function's signature — and not anything about this one task, which ends with it.
Verify it against the code before storing it: a wrong memory is worse than no memory,
because it will be believed.

Parameters:
  - action (string, required): "add" or "remove"
  - fact (string, optional): the fact, as one sentence (required for "add")
  - index (number, optional): which fact to forget, numbered as \`<memory>\` shows them
    (required for "remove")

`,
  },
  {
    name: 'run_background',
    dispatch: 'mcp',
    flash: ` — Spawn background process. Args: command (string), cwd? (string)
`,
    pro: `
Spawn a long-running background process (dev servers, watchers, builds). Returns immediately with a taskId.
Use manage_task to monitor, read logs, send input, or kill the background process.
Parameters:
  - command (string, required): The shell command to execute
  - cwd (string, optional): Working directory (default: workspace root)

`,
  },
  {
    name: 'manage_task',
    dispatch: 'mcp',
    flash: ` — Manage background tasks. Args: action ("status"|"read_logs"|"send_input"|"kill"|"list"), taskId? (string)
`,
    pro: `
Interact with background tasks spawned by run_background.
Parameters:
  - action (string, required): "status" | "read_logs" | "send_input" | "kill" | "list"
  - taskId (string, optional): Task ID (required for all actions except list)
  - lines (number, optional): Number of log lines to read (default: 50, for read_logs)
  - input (string, optional): Text to send to stdin (required for send_input)

`,
  },
  {
    name: 'get_editor_state',
    dispatch: 'mcp',
    flash: ` — Get current editor state. No args.
`,
    pro: `
Gets the user's current editor state (active file, cursor position, and visible text) if the VS Code companion extension is installed. Use this to understand what the user is currently looking at.
Parameters: None

`,
  },
  {
    name: 'recall_history',
    dispatch: 'mcp',
    flash: ` — Search earlier turns of this conversation, including ones a summary replaced. Args: query (string), limit? (number)
`,
    pro: `
Search earlier turns of this conversation, including ones that a summary replaced and that you can
no longer see. When the context refers to a decision, a filename, an error or a preference whose
detail you no longer have, look it up here rather than asking the user to repeat it or guessing.
Matching is literal and case-insensitive, so search for the exact term.
Parameters:
  - query (string, required): The exact term to look for.
  - limit (number, optional): How many matches to return. Default 5, maximum 10.

`,
  },
  {
    name: 'get_diagnostics',
    dispatch: 'mcp',
    flash: ` — The editor's errors and warnings (VS Code Problems panel). Args: path? (string), severity? ("error"|"warning")
`,
    pro: `
Read the editor's current errors and warnings — the VS Code Problems panel — for the workspace.
Use it after editing a file to check the change compiles and lints, and before starting work to see
what is already broken. Requires the VS Code companion extension.
Parameters:
  - path (string, optional): Only report problems for this file.
  - severity (string, optional): "error" to exclude warnings.

`,
  },
  {
    name: 'ask_subagent',
    dispatch: 'loop',
    flash: ` — Delegate to Gemini subagent. Args: prompt (string)
`,
    pro: `
Delegate a task to a generic parallel Gemini subagent. It will run in the background and return the result.
Parameters:
  - prompt (string, required): The task for the subagent.

`,
  },
  {
    name: 'ask_researcher',
    dispatch: 'loop',
    flash: ` — Delegate read-only codebase exploration. Args: prompt (string)
`,
    pro: `
Delegate codebase exploration to a read-only researcher subagent — tracing a dependency, finding where
something is implemented, gathering context across many files. Runs in parallel and returns findings with
file paths and line numbers. Use it instead of a long serial chain of your own read_file calls.
Parameters:
  - prompt (string, required): What to find, and where you have already looked.
`,
  },
  {
    name: 'ask_reviewer',
    dispatch: 'loop',
    when: 'duo',
    lead: '\n',
    flash: (modelConfig) => `\nDelegate a code review or verification task to the Reviewer Subagent (${modelConfig.reviewer || 'chatgpt'}).\nParameters:\n  - prompt (string, required): The task, context, and specific questions for the reviewer.\n\n`,
  },
];

/** The tools offered for this topology, in prompt order. */
export function toolsFor(topology) {
  return TOOL_CATALOG.filter((t) => !t.when || t.when === topology);
}

/** Just the names — what the anchor and the reminder index need. */
export function toolNames(topology) {
  return toolsFor(topology).map((t) => t.name);
}

/**
 * The `<available_tools>` block for a tier.
 *
 * Two oddities are preserved rather than tidied, because this file's job was to
 * stop the lists drifting and not to change what the model reads on the way
 * past. `ask_reviewer` carries no `pro` text because it never had any — the duo
 * block was appended outside the tier branch, so both tiers got the same
 * paragraph — and it carries a `lead` newline, which is the blank line that
 * separated that appended block from the list above it.
 */
export function renderToolDefinitions(tier, topology, modelConfig = {}) {
  const isFlash = tier === 'flash';
  let out = '<available_tools>\n';
  for (const tool of toolsFor(topology)) {
    const text = (isFlash ? tool.flash : (tool.pro ?? tool.flash));
    out += `${tool.lead || ''}## ${tool.name}${typeof text === 'function' ? text(modelConfig) : text}`;
  }
  return `${out}</available_tools>`;
}

/**
 * Where the catalog and the runnable registry disagree.
 *
 * Three ways they can, each of which has actually happened or nearly has:
 * a tool that runs but is never described (`recall_history`), one described but
 * not dispatchable anywhere (`write_to_file`, which the system prompt asked for
 * by name for weeks), and a required parameter the prose does not mention, which
 * the model then never sends.
 *
 * Returned rather than thrown: the caller is a test, and a list of every
 * disagreement is more useful than the first one.
 *
 * @param {Array<{name: string, parameters?: Object}>} registry - TOOL_DEFINITIONS
 * @param {string[]} loopDispatched - tool names agent-loop handles itself
 */
export function toolCatalogDrift(registry, loopDispatched) {
  const problems = [];
  const runnable = new Set([...registry.map((t) => t.name), ...loopDispatched]);
  const described = new Set(TOOL_CATALOG.map((t) => t.name));

  for (const name of runnable) {
    if (!described.has(name)) problems.push(`${name} runs but the prompt never names it`);
  }
  for (const name of described) {
    if (!runnable.has(name)) problems.push(`${name} is described but nothing dispatches it`);
  }
  for (const tool of registry) {
    const doc = TOOL_CATALOG.find((t) => t.name === tool.name);
    if (!doc) continue;
    const text = [doc.flash, doc.pro].filter((v) => typeof v === 'string').join('\n');
    for (const [param, spec] of Object.entries(tool.parameters || {})) {
      if (spec?.required && !text.includes(param)) {
        problems.push(`${tool.name}: required parameter "${param}" is in no description`);
      }
    }
  }
  return problems.sort();
}
