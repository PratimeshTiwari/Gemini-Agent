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
 *   shell?: boolean, detached?: boolean, lead?: string, flash: string|Function,
 *   pro: string|Function}} ToolDoc
 */

/** In prompt order, which is the order the model sees. */
export const TOOL_CATALOG = [
  {
    name: 'ask_question',
    dispatch: 'loop',
    flash: ` — Ask the user to choose. Blocks until they answer. Args: question (string), options (string[], 2-4 concrete choices), header (string, 2-3 word topic). Several at once: questions ([{question, options, header}], max 4)
`,
    pro: `
Put a decision to the user; execution blocks until they answer, so this is the ONLY way to reach
them mid-task — a question written in prose is not a question, it just ends your turn. Ask when
the answer changes what you build and the code cannot settle it; do not ask what read_file would
tell you, and do not ask permission to continue.

Options are concrete courses of action ("Rewrite the parser to stream"), never yes/no. Ask
everything you need in ONE call via \`questions\` — one at a time costs a round trip each.
Parameters:
  - questions (array, max 4, preferred): [{ question, options, header }], same fields as below
  - question (string, required): the decision, in one sentence
  - options (array of strings, required): 2-4 concrete choices
  - header (string, optional): 2-3 words naming the topic, shown as the prompt's title

Example:
\`\`\`json
{"name": "ask_question", "args": {"questions": [
  {"header": "Storage", "question": "Where should the cache live?", "options": ["In .agent/cache", "In the system temp dir"]}
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
Find files by name or path, fuzzy-matched. Use it when you know roughly what a file is called
but not where it lives; use grep_search to search file *contents*.
Parameters:
  - query (string, required): file name or path fragment
  - maxResults (number, optional): default 20

`,
  },
  {
    name: 'grep_search',
    dispatch: 'mcp',
    flash: ` — Search text across files, grouped by file. Args: pattern (string or string[] — pass several terms when unsure of the wording), isRegex? (bool), includes? (string[]), contextLines? (number), maxResults? (number)
`,
    pro: `
Search file contents across the codebase, grouped by file with the busiest first. When you do
not know what *this* codebase calls something, pass several names at once —
\`{"pattern": ["rate limit", "throttle", "quota"]}\` is one search, not three round trips.
Parameters:
  - pattern (string or string[], required): an array matches any of them
  - isRegex (boolean, optional): treat every pattern as a regex
  - includes (string[], optional): globs to restrict the search, e.g. ["*.js"]
  - maxResults (number, optional): default 50, max 500
  - contextLines (number, optional): 0-5, default 0 — cheaper than opening the file to find out
    whether a match is the right one

`,
  },
  {
    name: 'find_symbol',
    dispatch: 'mcp',
    flash: ` — Where a symbol is DEFINED (parses the code, not the text). Args: name (string, exact, case-sensitive)
`,
    pro: `
Find where a symbol is **defined** — class, function, method or const. Parses the code, so it
returns the definition rather than forty call sites, and never a match inside a comment or
string: reach for this instead of grep_search whenever you know the exact name.

JavaScript and JSX only. "No definition found" plus a note about skipped files means *not found
here*, not "does not exist" — follow up with grep_search.
Parameters:
  - name (string, required): exact symbol name, case-sensitive

`,
  },
  {
    name: 'find_references',
    dispatch: 'mcp',
    flash: ` — Every place a symbol is USED — calls, imports, JSX tags. Args: name (string, exact), includeDefinition? (bool)
`,
    pro: `
Find every place a symbol is **used** — calls, imports, JSX tags. This is what answers "who calls
this?" and "what breaks if I change it?", which grep_search answers worst because it cannot tell
a call from the same word in a comment or an object key. Grouped by file, definition marked.
Parameters:
  - name (string, required): exact symbol name, case-sensitive
  - includeDefinition (boolean, optional): default true

`,
  },
  {
    name: 'read_file',
    dispatch: 'mcp',
    flash: ` — Read a file. Args: path (string), startLine? (number), endLine? (number)
`,
    pro: `
Read a file, optionally one line range of it. Read before you edit — \`edit_file\` matches exact
text and fails if you guessed it.
Parameters:
  - path (string, required): relative to the workspace root
  - startLine (number, optional): 1-indexed
  - endLine (number, optional): 1-indexed

`,
  },
  {
    name: 'edit_file',
    dispatch: 'mcp',
    mutates: true,
    flash: ` — Edit a file. Args: path (string), edits ([{oldText, newText}])
`,
    pro: `
Propose edits to an existing file; the user sees a diff and approves or rejects it per hunk.
\`oldText\` must match the file exactly, so read it first — on a mismatch, re-read and retry
rather than guessing.
Parameters:
  - path (string, required)
  - edits (array, required): [{ oldText, newText }] — oldText is found, newText replaces it

`,
  },
  {
    name: 'create_file',
    dispatch: 'mcp',
    mutates: true,
    flash: ` — Create a file. Args: path (string), content (string)
`,
    pro: `
Create a new file. Use edit_file for one that already exists; this replaces the whole thing.
Parameters:
  - path (string, required)
  - content (string, required): the complete file

`,
  },
  {
    name: 'list_directory',
    dispatch: 'mcp',
    flash: ` — List dir contents. Args: path? (string), recursive? (bool), maxDepth? (number)
`,
    pro: `
List what is in a directory. Use it to orient in an unfamiliar tree before guessing at paths.
Parameters:
  - path (string, optional): default the workspace root
  - recursive (boolean, optional)
  - maxDepth (number, optional): default 3

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
Run a shell command; always needs user approval. For anything that does not finish on its own —
a dev server, a watcher, a \`--watch\` build — use run_background instead, or this will time out
and tell you nothing.
Parameters:
  - command (string, required)
  - cwd (string, optional)
  - timeout (number, optional): seconds, default 30

`,
  },
  {
    name: 'manage_memory',
    dispatch: 'loop',
    flash: ` — Remember/forget a durable fact. Args: action ("add"|"remove"), fact? (string), index? (number, the number shown in <memory>)
`,
    pro: `
Remember a durable fact about this project, or forget one. Store what you had to *work out* and
would work out again — that the tests run with pnpm, that a directory is generated — never a
file's contents or anything about this one task. Verify it first: a wrong memory is worse than
none, because it will be believed.
Parameters:
  - action (string, required): "add" or "remove"
  - fact (string): one sentence, for "add"
  - index (number): which fact to forget, numbered as \`<memory>\` shows them

`,
  },
  {
    name: 'run_background',
    dispatch: 'mcp',
    mutates: true,
    shell: true,
    detached: true,
    flash: ` — Spawn background process. Args: command (string), cwd? (string)
`,
    pro: `
Spawn a long-running process — dev server, watcher, build — and return a taskId immediately.
Use manage_task to read its logs, send it input or kill it.
Parameters:
  - command (string, required)
  - cwd (string, optional): default the workspace root

`,
  },
  {
    name: 'manage_task',
    dispatch: 'mcp',
    flash: ` — Manage background tasks. Args: action ("status"|"read_logs"|"send_input"|"kill"|"list"|"watch"|"unwatch"), taskId? (string), lines? (number), pattern? (string, for watch)
`,
    pro: `
Inspect or control a process started by run_background. \`watch\` has the agent woken when that
process logs a failure, with the failing lines already in hand.
Parameters:
  - action (string, required): "status" | "read_logs" | "send_input" | "kill" | "list" | "watch" | "unwatch"
  - taskId (string): required for everything except "list"
  - lines (number, optional): for read_logs, default 50
  - input (string): for send_input
  - pattern (string, optional): for watch — a regex; omit for the built-in failure patterns

`,
  },
  {
    name: 'get_editor_state',
    dispatch: 'mcp',
    flash: ` — Which file the user has open and where the cursor is. Location only, not contents. No args.
`,
    pro: `
Which file the user has open and where the cursor is. Ask when the request points at something
without naming it — "fix this function", "why is this failing" — and you would otherwise guess
which file they mean. Returns the location only, never contents; the answer carries its age, and
the editor moves independently of this conversation.
Parameters: None

`,
  },
  {
    name: 'recall_history',
    dispatch: 'mcp',
    flash: ` — Search earlier turns of this conversation, including ones a summary replaced. Args: query (string), limit? (number)
`,
    pro: `
Search earlier turns of this conversation, including ones a summary replaced and that you can no
longer see. When the context refers to a decision, filename or error whose detail you no longer
have, look it up here instead of asking the user to repeat it. Matching is literal and
case-insensitive.
Parameters:
  - query (string, required): the exact term
  - limit (number, optional): default 5, max 10

`,
  },
  {
    name: 'get_diagnostics',
    dispatch: 'mcp',
    flash: ` — The editor's errors and warnings (VS Code Problems panel). Args: path? (string), severity? ("error"|"warning")
`,
    pro: `
The editor's current errors and warnings — the VS Code Problems panel. Worth a call before
starting, to see what is already broken and not blame your change for it. Needs the companion
extension.
Parameters:
  - path (string, optional): only this file
  - severity (string, optional): "error" to exclude warnings

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
Hand work to a second tab of this model with its **own empty context** — it has not seen this
conversation and cannot see your files, so it knows only what you put in \`prompt\`. Read-only
tools, one answer back, several run at once.

\`role: "research"\` instead of a long serial chain of read_file calls; \`role: "review"\` to have a
finished change read by someone who does not share your assumptions — paste the diff and the
paths, "the fix above" means nothing to it; \`role: "task"\` for a self-contained errand.
Parameters:
  - role (string, required): "review", "research" or "task"
  - prompt (string, required): everything it needs — it has no other context

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
 * Shell tools whose effects outlive the turn that started them.
 *
 * The plan-mode exemption for read-only commands is real — `ls` behind a
 * keystroke is how an approval prompt becomes something people dismiss without
 * reading — but it was written as "any shell tool the classifier calls safe",
 * and `run_background` is a shell tool. So the exemption meant to cover `ls`
 * also covered `run_background npm run dev`: the command text is safe, and the
 * process it spawns is still running after the turn, the mode and possibly the
 * session have ended. The classifier reads the command; it cannot see that.
 *
 * The flag says what is different about the tool, so the exemption can ask.
 */
export const DETACHED_TOOLS = new Set(
  TOOL_CATALOG.filter((t) => t.detached).map((t) => t.name),
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
  const isFlash = tier === 'lite' || tier === 'flash';
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
