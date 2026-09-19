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

/**
 * @typedef {{name: string, dispatch: 'mcp'|'loop', when?: 'subagents', mutates?: boolean,
 *   shell?: boolean, lead?: string, flash: string|Function, pro: string|Function}} ToolDoc
 */

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
    flash: ` — Find files by name. Args: query (string), maxResults? (number)
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
    flash: ` — Search text across files, grouped by file. Args: pattern (string or string[] — pass several terms when unsure of the wording), isRegex? (bool), includes? (string[]), contextLines? (number), maxResults? (number)
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
    name: 'find_symbol',
    dispatch: 'mcp',
    flash: ` — Where a symbol is DEFINED (parses the code, not the text). Args: name (string, exact, case-sensitive)
`,
    pro: `
Find where a symbol is **defined** — a class, function, method or const.

This parses the code, so it returns the definition and not the forty call sites, and never the
name inside a comment or a string. Whenever you know the exact name and want to see how something
is written, this is one call where grep_search is a page of matches you then have to read.

JavaScript and JSX only. If a file could not be parsed the result says so — "no definition found"
plus a note about what was skipped means *not found here*, not "does not exist", and the next move
is grep_search.

Parameters:
  - name (string, required): the exact symbol name, case-sensitive

`,
  },
  {
    name: 'find_references',
    dispatch: 'mcp',
    flash: ` — Every place a symbol is USED — calls, imports, JSX tags. Args: name (string, exact), includeDefinition? (bool)
`,
    pro: `
Find every place a symbol is **used** — calls, imports, JSX tags.

"Who calls this?" and "what breaks if I change this?" are the questions grep_search answers worst:
it cannot tell a call from the same word in a comment, or from an object key that happens to
match. This can. Results are grouped by file, busiest first, and the definition is marked.

Parameters:
  - name (string, required): the exact symbol name, case-sensitive
  - includeDefinition (boolean, optional): list the definition too (default true)

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
    mutates: true,
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
    mutates: true,
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
    flash: ` — List dir contents. Args: path? (string), recursive? (bool), maxDepth? (number)
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
    mutates: true,
    shell: true,
    flash: ` — Run shell command (needs approval). Args: command (string), cwd? (string), timeout? (number, ms)
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
    mutates: true,
    shell: true,
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
    flash: ` — Manage background tasks. Args: action ("status"|"read_logs"|"send_input"|"kill"|"list"|"watch"|"unwatch"), taskId? (string), lines? (number), pattern? (string, for watch)
`,
    pro: `
Interact with background tasks spawned by run_background.
Parameters:
  - action (string, required): "status" | "read_logs" | "send_input" | "kill" | "list"
  - taskId (string, optional): Task ID (required for all actions except list)
  - lines (number, optional): Number of log lines to read (default: 50, for read_logs)
  - input (string, optional): Text to send to stdin (required for send_input)
  - pattern (string, optional): for watch — a regex to look for in the output. Omit to use the
    built-in failure patterns (error, failed, exception, traceback, EADDRINUSE, Cannot find module).

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
    when: 'subagents',
    /*
     * A description is a **routing rule**, not a capability list.
     *
     * There used to be three tools here — `ask_subagent`, `ask_researcher` and
     * `ask_reviewer` — and they were the same tool three times:
     * `buildSubagentWrapper(role)` took the role and ignored it, so all three
     * got one generic "you are a helper subagent" wrapper. The names were the
     * only thing implying otherwise.
     *
     * Of the three descriptions only `ask_researcher`'s said *when* to use it
     * ("instead of a long serial chain of your own read_file calls"), which is
     * the half that makes delegation fire at all. `ask_subagent`'s said
     * "Delegate a task to a generic parallel Gemini subagent" — a capability
     * with no trigger, which is the documented reason auto-delegation never
     * happens. Every role below leads with its trigger.
     */
    flash: ` — Delegate to a parallel tab. Args: role ("review"|"research"|"task"), prompt (string)
`,
    pro: `
Hand work to a subagent — a second tab of this model with its **own empty context**. It has not
seen this conversation and cannot see your files, so it knows only what you put in \`prompt\`.
It has read-only tools and returns one answer. Several run at once.

Reach for it when:
  - **role "research"** — you are about to make a long serial chain of read_file calls to answer
    one question ("where is X implemented", "what depends on Y"). Say what to find and where you
    have already looked.
  - **role "review"** — you have finished a non-trivial change and want it read by someone who
    does not share your assumptions. Send the diff, the file paths, and what the change is meant
    to do. Its value is that it has no memory of why you chose any of it, so paste the code —
    a reference to "the fix above" means nothing to it.
  - **role "task"** — a self-contained side errand whose result you need but whose working you
    do not.

Do NOT use it for anything that writes: it cannot edit files or run commands, and the approval
path for those is yours.
Parameters:
  - role (string, required): "review", "research" or "task"
  - prompt (string, required): everything it needs — it has no other context.

`,
  },
];

/**
 * Tools that change the machine, and therefore need approval in plan mode.
 *
 * A named set rather than a literal list at the call site, because the literal
 * list drifted. Plan mode gated `edit_file`, `create_file` and `run_command`
 * and **not** `run_background`, which spawns a shell process that outlives the
 * turn: `needsApproval` starts false, nothing in the plan branch set it, so
 * plan mode ran it immediately — while auto mode, through the classifier's
 * "Unknown tool" default, asked. The careful mode was the permissive one, for
 * the tool whose effects last longest.
 *
 * Declared on the catalog entry, so adding a tool that writes means saying so
 * once beside its description rather than remembering a list in another file.
 */
export const MUTATING_TOOLS = new Set(
  TOOL_CATALOG.filter((t) => t.mutates).map((t) => t.name),
);

/**
 * Tools that hand a string to a shell.
 *
 * Separate from `MUTATING_TOOLS` because they need more than an approval
 * prompt: risk classification of the command text, the `critical` block, and a
 * line in the command log. All three were gated on `call.name === 'run_command'`
 * literally, so `run_background` reached none of them — it was never risk
 * classified, never blocked however destructive the command, and never audited,
 * for a process that outlives the turn.
 */
export const SHELL_TOOLS = new Set(
  TOOL_CATALOG.filter((t) => t.shell).map((t) => t.name),
);

/**
 * The tools offered, in prompt order.
 *
 * `when` used to name a topology (`'duo'`), which meant the catalog knew about
 * a two-model world. There is one model and one gate now: are subagents on.
 *
 * Accepts a boolean or `{subagents}` so the many call sites that pass one
 * value do not each need an object literal.
 *
 * @param {boolean|{subagents?: boolean}} [ctx]
 */
export function toolsFor(ctx) {
  const subagents = typeof ctx === 'object' && ctx !== null ? Boolean(ctx.subagents) : Boolean(ctx);
  return TOOL_CATALOG.filter((t) => !t.when || (t.when === 'subagents' && subagents));
}

/** Just the names — what the anchor and the reminder index need. */
export function toolNames(ctx) {
  return toolsFor(ctx).map((t) => t.name);
}

/**
 * The `<available_tools>` block for a tier.
 *
 * `ask_reviewer` used to be an oddity here — no `pro` text, a `lead` newline —
 * both artefacts of the duo block having been appended outside the tier branch.
 * It is gone: one `ask_subagent` with a role covers what three names pretended
 * to.
 */
export function renderToolDefinitions(tier, ctx, modelConfig = {}) {
  /*
   * Both cheap tiers get the terse list, not just the one called `flash`.
   *
   * This read `tier === 'flash'`, which is false for `flash-thinking` — so the
   * rung whose own description says "still a short prompt" was handed the full
   * 9,786-character block instead of the 2,048 one. Measured: 22,538 characters
   * against the 14,800 it should be, with 7,738 of the difference being a tool
   * list it was never meant to carry, on the rung written for a model that
   * follows short prompts and ignores long ones.
   *
   * A typo of intent rather than of syntax: "flash" meant the cheap tiers, and
   * there turned out to be two of them.
   */
  const isFlash = tier === 'flash' || tier === 'flash-thinking';
  let out = '<available_tools>\n';
  for (const tool of toolsFor(ctx)) {
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
  /**
   * Every declared parameter, in **each** form separately.
   *
   * This used to join `flash` and `pro` and look for the name in the pair — so
   * a parameter documented in one and missing from the other passed. Five did:
   * `maxResults` on `search_files` and `grep_search`, `maxDepth` on
   * `list_directory`, `timeout` on `run_command`, `lines` on `manage_task`.
   * All five were invisible to the two flash rungs, which could not use a
   * feature the tool had.
   *
   * It also only checked `required`, and `manage_task`'s `pattern` — a real,
   * implemented option on `watch` — was in neither form. A working feature the
   * model was never told about at any rung. Optional is not the same as
   * unnecessary: a parameter nobody is told about cannot be used.
   *
   * Function-form descriptions are called rather than skipped. They used to be
   * filtered out as "not a string", which silently exempted every tool whose
   * text is computed.
   */
  const render = (v) => {
    if (typeof v === 'function') { try { return v({}) ?? ''; } catch { return ''; } }
    return typeof v === 'string' ? v : '';
  };

  for (const tool of registry) {
    const doc = TOOL_CATALOG.find((t) => t.name === tool.name);
    if (!doc) continue;
    const forms = { flash: render(doc.flash), pro: render(doc.pro ?? doc.flash) };
    for (const param of Object.keys(tool.parameters || {})) {
      for (const [which, text] of Object.entries(forms)) {
        if (!text.includes(param)) {
          problems.push(`${tool.name}: parameter "${param}" is missing from the ${which} description`);
        }
      }
    }
  }
  return problems.sort();
}
