/**
 * Prompt Builder
 *
 * Constructs the system prompt with tool definitions, workspace context,
 * and conversation history. Manages what gets injected into each Gemini interaction.
 *
 * Smart prompt management strategy (similar to how Claude Code handles context):
 * - Gemini Web maintains its OWN chat history, so we DON'T resend conversation_history.
 * - Full system prompt + tools sent on: first turn, after /compact, and every Nth turn.
 * - On regular turns: just the user message (or tool results) with a brief context line.
 * - This prevents double-counting context and avoids triggering Gemini's repetitive filters.
 */

import path from 'path';
import * as paths from './paths.js';
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'fs';
import { randomUUID } from 'crypto';
import os from 'os';
import { resolve, relative, join, dirname } from 'path';
import { CodeMinifier } from '../context/code-minifier.js';
import { allocate, headAndTail, planSpoolPruning } from './result-budget.js';
import { skillCatalogue } from './skills.js';
import { resolveEffort } from './effort.js';
import { renderToolDefinitions } from './tool-catalog.js';
import { prompt } from './prompt-loader.js';
import { parseMemory, readMemoryEnabled } from '../context/memory-manager.js';

// How often to send the condensed reminder, counted in MESSAGES pushed to the tab —
// not user turns. One user turn can be a dozen tool round-trips, so a turn-based
// counter drifts by an order of magnitude in tool-heavy work and fires far too
// eagerly in a chatty Q&A session.
const REFRESH_INTERVAL_MESSAGES = 20;

/**
 * Is this file saying anything?
 *
 * `loaded` is the ordinary case. `empty` is a file that exists and has nothing
 * in it. `template` is the one worth naming: the stock `AGENT.md` ships with six
 * headings and five HTML comments reading "describe your project here", and
 * `_loadAgentMd` only skips a file whose *trimmed body* is empty — a template
 * full of headings is not empty, so it goes into every turn-0 prompt, presented
 * to the model as this project's context. This repo's own AGENT.md is one.
 */
export function agentMdState(body) {
  if (!body) return 'empty';
  const placeholders = (body.match(/<!--[^>]*-->/g) || []).length;
  const prose = body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^#.*$/gm, '')
    .replace(/^```[\s\S]*?```$/gm, '')
    .trim();
  if (placeholders >= 3 && prose.length < 400) return 'template';
  return 'loaded';
}

/** The checklist is model-written and nothing prunes it, so it is bounded. */
const MAX_TASK_ITEMS = 40;
const MAX_TASK_CHARS = 2000;

/**
 * Characters the tool results of one prompt may occupy between them.
 *
 * Not a token budget: this is about what a content script types into a
 * composer, and the cost that matters is paid on the wire and in Gemini's
 * repetition heuristics.
 *
 * **It must not be tighter than the tightest per-tool cap it is composing.**
 * This was 16 KB, chosen against `run_command`'s 50 KB — and `read_file`'s own
 * page is 800 lines, about 44 KB, so a single read was being cut to a third of
 * what the tool had already decided to give. That is this ceiling silently
 * overruling a considered decision made one layer down, and it cost a real
 * turn: the model saw "45,000 characters cut", concluded the file was
 * unreadable, and answered from guesswork instead of paging it.
 *
 * 48 KB fits one `read_file` page whole. The case this exists for — five
 * parallel `run_command`s at 50 KB each — is still cut from 250 KB to 48.
 */
const RESULT_BUDGET_CHARS = 48000;

export class PromptBuilder {
  constructor(workspace, agentSourceDir) {
    this.workspace = workspace;
    this.agentSourceDir = agentSourceDir;
    this.agentMdContent = this._loadAgentMd();
    this.messagesSinceRefresh = 0; // Messages sent to the tab since the last reminder
    this.hasSeenSystemPrompt = false; // Has the current chat session received a system prompt?
    this.hasSeenHandover = false;     // ...and the full handover review, once
    this.pendingToolRedeclare = false; // Does the next prompt owe the model its tools back?
  }

  /**
   * Reset prompt state (call after /compact or /clear which start a new Gemini chat).
   */
  resetPromptState() {
    this.messagesSinceRefresh = 0;
    this.hasSeenSystemPrompt = false;
    // A new thread has not seen the handover either, whatever the old one did.
    this.hasSeenHandover = false;
    // A full prompt carries the definitions anyway, so any outstanding
    // redeclaration is already satisfied by the turn this reset causes.
    this.pendingToolRedeclare = false;
  }

  /**
   * The model denied having tools: put the definitions back, and nothing else.
   *
   * This used to go through `resetPromptState()`, which makes the next turn a
   * *turn-0* prompt — system instructions, tool definitions, `AGENT.md`,
   * memory and the skill catalogue, all of it again. The model had not
   * forgotten what project it was in or what it had learned here; it had
   * forgotten it has tools, which is one block of that payload.
   *
   * Resending the rest is not merely wasteful. The whole reason
   * `PromptBuilder` tiers its prompts is that a large repeated payload trips
   * Gemini's repetition and A/B-test filters — so the heaviest possible
   * recovery prompt is a plausible *cause* of the next failure, fired
   * precisely when the session is already unhealthy.
   *
   * The condensed reminder still rides along, because a model that has lost
   * its tools has usually lost the framing with them, and that block is small.
   */
  requestToolRedeclaration() {
    this.pendingToolRedeclare = true;
  }

  /**
   * Build the prompt for a Gemini interaction.
   *
   * Strategy:
   * - Turn 0 (first message or after reset): Full system prompt + tools + workspace + user message
   * - Every SYSTEM_PROMPT_REFRESH_INTERVAL turns: Condensed system reminder + tools + user message
   * - All other turns: Just the user message with a brief context line
   *
   * We NEVER re-send conversation_history because Gemini Web already has it in its chat thread.
   *
   * @param {object} options
   * @param {string} options.userMessage - The user's current message
   * @param {string} options.mode - 'plan' or 'auto'
   * @returns {string} The complete prompt to inject
   */
  buildPrompt({ userMessage, mode = 'plan', subagents = true, modelConfig = {}, objective = '' }) {
    const parts = [];

    const needsFullPrompt = !this.hasSeenSystemPrompt;
    // A repair outranks the periodic refresh: the refresh sends names only,
    // which is exactly what the model has just demonstrated is not enough.
    const needsToolRedeclare = !needsFullPrompt && this.pendingToolRedeclare;
    const needsRefresh = !needsFullPrompt && !needsToolRedeclare
      && this.messagesSinceRefresh >= REFRESH_INTERVAL_MESSAGES;

    if (needsFullPrompt) {
      // First turn in this chat session — send everything
      parts.push(`<system_state mode="${mode}" subagents="${subagents ? 'on' : 'off'}">`);
      parts.push(this._buildSystemInstructions(mode, subagents, modelConfig));
      parts.push(this._buildToolDefinitions(subagents, modelConfig));
      
      if (objective && objective.trim() !== userMessage.trim()) {
        parts.push(`<current_objective>\n${objective}\n</current_objective>`);
      }

      // Workspace context removed to save tokens, rely on `search_files` tool instead.
      if (this.agentMdContent) {
        parts.push(`<agent_instructions>\n${this.agentMdContent}\n</agent_instructions>`);
      }

      // What the agent learned here on earlier runs. This is the half that was
      // missing: `manage_memory` wrote facts to disk and no prompt ever carried
      // them, so the model paid a tool call per fact and got nothing back.
      const memory = this._loadMemory();
      if (memory) {
        parts.push(`<memory>\n${memory}\n</memory>`);
      }

      // Names and one-line descriptions only. The bodies stay on disk and are
      // fetched with read_file when the model judges one relevant, so writing
      // twenty skills costs twenty lines of prompt rather than twenty files of
      // it — which matters when the prompt is retyped into a browser tab.
      const skills = skillCatalogue(this.workspace, this._configuredSkillFolders());
      if (skills) {
        parts.push(`<skills>\n${skills}\n</skills>`);
      }
      parts.push(`</system_state>`);

      this.hasSeenSystemPrompt = true;
      this.messagesSinceRefresh = 0;
      this.pendingToolRedeclare = false;
    } else if (needsToolRedeclare) {
      // The targeted repair: the framing and the full definitions, without
      // AGENT.md, memory or the skill catalogue, which the model never lost.
      parts.push(this._buildCondensedReminder(mode, objective, modelConfig));
      parts.push(this._buildToolDefinitions(subagents, modelConfig));
      this.pendingToolRedeclare = false;
      this.messagesSinceRefresh = 0;
    } else if (needsRefresh) {
      // Periodic refresh — a reminder, not a re-teach. Gemini Web still has the full
      // definitions in its own thread, so resending them buys nothing and resending a
      // large block is what trips the A/B-test modal. Names only.
      parts.push(this._buildCondensedReminder(mode, objective, modelConfig));
      parts.push(this._buildToolIndex(subagents, modelConfig));
      this.messagesSinceRefresh = 0;
    } else {
      // Regular turn — just a brief context line
      // The objective only earns its place when it is NOT the message being
      // sent. AgentLoop sets it to the latest user message, so today it never
      // is — this used to put the same sentence in the prompt twice, every turn.
      let contextLine = `[Workspace: ${this.workspace} | Mode: ${mode}]`;
      if (objective && objective.trim() !== userMessage.trim()) {
        contextLine += ` [Objective: ${objective.substring(0, 100)}]`;
      }
      // The anchor goes on the same line as the workspace: one short bracketed
      // context line, not two competing headers.
      const anchor = this._buildToolAnchor(subagents, modelConfig);
      parts.push(anchor ? `${contextLine} ${anchor}` : contextLine);
    }

    // The checklist it wrote, so it can tick the exact line rather than guess
    // at one. Every turn, because ticking is a per-turn act — see _loadTaskList.
    //
    /**
     * A **finished** list is labelled as finished.
     *
     * `task.md` is one file reused for every task, so a completed checklist
     * keeps arriving on every later prompt — including the first prompt of
     * something entirely unrelated. Handed a list of ticked boxes with no
     * other framing, the model has no way to tell "you already did this" from
     * "this is the plan for what you are being asked now", and the natural
     * mistakes are both bad: tick nothing because it all looks done, or edit
     * the old file instead of writing a new plan.
     *
     * Reported from use — a finished round-2 list still sitting under an
     * unrelated prompt. Saying so costs one attribute and removes the
     * ambiguity, where dropping the block entirely would take the handover
     * review's "re-read `<task_checklist>`" with it.
     */
    /**
     * A resumed conversation the browser tab was never part of.
     *
     * The model's memory *is* the chat thread — `conversationHistory` is never
     * replayed into a tab. So resuming a session into a different thread gives
     * you a transcript the model has no knowledge of, and it answers
     * confidently about work it never did.
     *
     * Set only when the threads differ (see `planResume`), and cleared after
     * one turn: it is an introduction, not context to carry forever. Bounded,
     * because the whole prompt strategy exists to avoid large repeated payloads
     * typed into a browser.
     */
    if (this.pendingRecap?.length) {
      const RECAP_TURNS = 12;
      const RECAP_CHARS = 4000;
      let recap = this.pendingRecap
        .filter((t) => (t.role === 'user' || t.role === 'assistant' || t.role === 'agent')
          && typeof t.content === 'string' && t.content.trim())
        .slice(-RECAP_TURNS)
        .map((t) => `[${t.role === 'agent' ? 'assistant' : t.role}] ${t.content.trim()}`)
        .join('\n\n');
      if (recap.length > RECAP_CHARS) recap = `…\n${recap.slice(-RECAP_CHARS)}`;
      if (recap) {
        parts.push('<resumed_conversation note="This happened in an earlier chat you were '
          + 'not part of. Treat it as background, not as something you remember doing.">\n'
          + `${recap}\n</resumed_conversation>`);
      }
      this.pendingRecap = null;
    }

    const taskList = this._loadTaskList();
    if (taskList) {
      const pending = /^\s*[-*]\s*\[ \]/m.test(taskList);
      const state = pending
        ? ''
        : ' state="complete" note="This was finished. If the request below is a'
          + ' new task, write a new list rather than reusing these items."';
      parts.push(
        `<task_checklist path=".agent/artifacts/task.md"${state}>\n${taskList}\n</task_checklist>`,
      );
    }

    // Current user message. Nothing follows it: the last thing the model reads
    // should be what the user asked, not a formatting rule it has already been
    // given twice.
    parts.push(`<user_message>\n${userMessage}\n</user_message>`);

    this.messagesSinceRefresh++;

    return '\u200B' + parts.join('\n\n');
  }

  /**
   * Record that a message was pushed to the tab outside buildPrompt (the joined
   * tool-result batch). The agent loop calls this once per message, not once per
   * result, so a parallel fan-out still counts as the one message it is.
   */
  noteMessageSent() {
    this.messagesSinceRefresh++;
  }

  /**
   * The model produced something it should not have — a tool call that would
   * not parse, most often. Refresh the instructions on the next prompt instead
   * of waiting out the rest of the message budget.
   */
  noteDrift() {
    this.messagesSinceRefresh = REFRESH_INTERVAL_MESSAGES;
  }

  /**
   * Build the follow-up prompt carrying tool results back to the model.
   *
   * One envelope, however many results — the previous shape appended the whole
   * "continue with your analysis / give exactly ONE response" trailer to each
   * result and joined them, so a three-tool fan-out sent one message telling
   * the model three separate times to produce exactly one response. Repetition
   * like that is what Gemini's filters react to, and it argues with itself.
   *
   * @param {Array<{name: string, result: any}>} results
   */
  /**
   * @param {object[]} results
   * @param {string} [turnEvidence] - what has actually run this turn, from
   *   `AgentLoop.turnEvidence`. Derived from dispatched calls, never from
   *   anything the model said.
   */
  /**
   * The handover review, for the round that has earned it.
   *
   * `brief` gets the four-point version, not nothing and not the seven-point
   * one. Its promise is "straight to work", and a long review on a one-line fix
   * is ceremony people learn to skip — but "did you run it" and "what did you
   * not do" are worth asking at any size.
   *
   * The flash rungs are unaffected: their handover is a few lines inside their
   * own reasoning prompt, small enough that moving it would cost more in
   * machinery than it saves in characters.
   *
   * @param {string} effort
   * @returns {string} '' for a rung that carries its own
   */
  buildHandoverBlock(effort) {
    const { tier, level } = resolveEffort(effort);
    if (tier !== 'pro') return '';

    /**
     * Full once per chat, a pointer after — the tool anchor's shape.
     *
     * Measured on real use rather than on the test fixtures, which flattered
     * it: turns are short (median 1 message) and 29% change something, so
     * "once per working turn" sends this **five times** where the old
     * every-20-messages refresh sent it once. Five times a small block beats
     * once inside a 26,000-character payload, but it still grows with session
     * length, and repeated payloads are the thing this project's whole prompt
     * strategy exists to avoid.
     *
     * So: the definitions once, the reminder thereafter. 1,879 characters the
     * first time a turn has something to hand over, 96 every time after.
     */
    if (this.hasSeenHandover) {
      return 'Before you finish: close with the `## Review` block — checklist, what you ran, '
        + 'callers checked, what you did not do.';
    }
    this.hasSeenHandover = true;
    /*
     * `handover-lite` used to be `brief`'s four-point version. With one pro
     * rung there is no `brief`, so pro always gets the full review — and the
     * lite copy is not orphaned: `_getReasoningInstructions` still hands it to
     * `flash-thinking`, which is the rung it now belongs to.
     */
    return prompt('pro-handover-review');
  }

  buildToolResultBatch(results = [], turnEvidence = '', handover = '') {
    const failures = results.filter((r) => r.failed);

    /**
     * One ceiling for the whole batch, divided fairly.
     *
     * The per-tool caps do not compose — `run_command` allows 50 KB *each* and
     * `_executeToolCalls` runs calls in parallel, so five commands was 250 KB
     * typed into a browser composer by a content script. Nothing capped the
     * batch, in the project whose entire prompt strategy exists to avoid large
     * payloads.
     *
     * Serialised first, because the budget is about what is *typed*, and a
     * minified object is a different size from the object.
     */
    const serialised = results.map(({ name, result, failed }) => ({
      name,
      // `status="failed"` is the point: a non-zero exit code inside minified
      // JSON is easy to skim past, and the model would summarise a failed
      // command back to the user as though it had worked.
      failed,
      // Minified, not pretty-printed. Every tool result goes into the prompt,
      // and indentation is the single largest avoidable cost there — a plain
      // list_directory result is 40% smaller without it. The model does not
      // read the whitespace; the token budget does.
      text: typeof result === 'string' ? result : CodeMinifier.minifyJson(result),
    }));
    const allowances = allocate(serialised.map((r) => r.text.length), RESULT_BUDGET_CHARS);

    const body = serialised.map(({ name, text, failed }, i) => [
      failed ? `<result tool="${name}" status="failed">` : `<result tool="${name}">`,
      allowances[i] >= text.length
        ? text
        : headAndTail(text, allowances[i], this._spool(name, text)),
      `</result>`,
    ].join('\n'));


    const instruction = failures.length > 0
      // Fix, do not narrate. Left to itself the model reports the error back to
      // the user and stops, which wastes the one thing it has that the user
      // does not: the ability to read the output and try the next thing.
      ? `${failures.length === 1 ? 'That call' : `${failures.length} of those calls`} failed. `
        + 'Read the error above, work out the cause, and fix it yourself — run the diagnostic '
        + 'you need, correct the file, or try the next approach. Only stop and tell the user if '
        + 'the fix needs a decision that is theirs to make, or if you have already tried and it '
        + 'failed the same way. Reply once, with either the next tool call or your final answer.'
      : 'Reply once, with exactly one of: the next tool call, or your final answer to the '
        + 'user. To change a file, use edit_file or create_file — do not paste code at them.';

    /**
     * The turn's own record, handed back before it reports on itself.
     *
     * `pro-handover-review.md` asks it to say what it ran and whose callers it
     * checked, and nothing ever checked the answer — so prose was always
     * cheaper than a tool call and looked identical on screen. One observed
     * review claimed `Ran: adversarial analysis` having run nothing, and
     * `Callers checked: …` having called `find_references` zero times.
     *
     * This is the prevention half, and it rides here rather than on
     * `buildPrompt` for a simple reason: `buildPrompt` runs once, at the top of
     * the turn, when nothing has happened yet. The place where the tally is
     * both non-empty and about to matter is the round where the model decides
     * whether to tick a box, claim a check, or answer.
     *
     * A dozen characters, derived, and it cannot be wrong about itself the way
     * the model's own account can.
     */
    const evidence = turnEvidence
      ? ['', `<turn_so_far>${turnEvidence}</turn_so_far>`,
        'Report only what is in that list. Anything else is "not checked".']
      : [];

    // After the evidence and before the closing instruction. The model reads
    // the last thing hardest, and the last thing must stay "what to do next" —
    // the review is a condition on finishing, not the next action.
    const review = handover ? ['', handover] : [];

    return [
      '<tool_results>',
      ...body,
      '</tool_results>',
      ...evidence,
      ...review,
      '',
      instruction,
    ].join('\n');
  }

  /**
   * Write a result that did not fit, and say where it went.
   *
   * This is what makes truncation non-lossy, and it is the difference between
   * a batch ceiling and the per-tool caps that already existed: the model can
   * `read_file` the rest if it turns out to need it. Without it, a cut result
   * is a decision made on the model's behalf about what mattered.
   *
   * Best-effort. A workspace we cannot write to is not a reason to fail a turn
   * — the excerpt is still useful — so a failure here just drops the pointer.
   *
   * @returns {string} a note for the cut marker, or '' if nothing was written
   */
  _spool(name, text) {
    try {
      const dir = paths.tmpDir(this.workspace);
      mkdirSync(dir, { recursive: true });
      const file = `${name}-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}.txt`;
      writeFileSync(path.join(dir, file), text, 'utf-8');

      // Or `.agent/tmp/` grows by one file per over-budget batch, forever.
      // Pruned after the write rather than before, so the one just written is
      // counted and the newest is never the one deleted.
      for (const old of planSpoolPruning(readdirSync(dir))) {
        try { rmSync(path.join(dir, old), { force: true }); } catch { /* it can wait */ }
      }
      return `full output: \`.agent/tmp/${file}\` (read_file it)`;
    } catch {
      return '';
    }
  }

  /** Single-result convenience wrapper over {@link buildToolResultBatch}. */
  buildToolResultPrompt(toolName, result) {
    return this.buildToolResultBatch([{ name: toolName, result }]);
  }

  /**
   * Build a compaction prompt.
   */
  buildCompactionPrompt(conversationHistory, focusInstruction = '') {
    return [
      'Please summarize the following conversation history into a concise but complete summary.',
      'Preserve:',
      '- All file paths that were read, edited, or created',
      '- All key decisions and their rationale',
      '- Current task state (what is done, what remains)',
      '- Any constraints, requirements, or user preferences expressed',
      '- Specific technical details (function names, variable names, error messages)',
      '',
      focusInstruction ? `Focus especially on: ${focusInstruction}` : '',
      '',
      '<conversation_to_summarize>',
      conversationHistory.map(turn => `[${turn.role}]: ${turn.content}`).join('\n\n'),
      '</conversation_to_summarize>',
      '',
      'Provide a structured summary in markdown:',
    ].filter(Boolean).join('\n');
  }

  // ── Private Methods ──────────────────────────────────────────────

  _buildSystemInstructions(mode, subagents = true, modelConfig = {}) {
    const modeInstructions = mode === 'auto'
      ? 'You are in AUTO MODE. Safe operations (reads, searches, small additions) will be auto-applied. Risky operations (large rewrites, deletions, commands) will still require user approval.'
      // "Require user approval before being applied" is true and reads as
      // "obtain approval before you call the tool" — so the model stops and
      // asks in prose ("Ready to exit PLAN MODE and implement the fixes?"),
      // which spends a turn on a question the user cannot answer with a
      // keypress. The tool catalog already forbids that in as many words; it
      // was being contradicted by this line. Saying what actually happens
      // costs nothing and removes the reason to ask.
      : 'You are in PLAN MODE. Call edit_file, create_file and run_command exactly as you '
        + 'normally would — the user is shown the diff or the command and approves or rejects '
        + 'it before anything happens. Do not ask in prose for permission to proceed or to '
        + 'change mode; propose the change and let them answer it.';

    // One setting decides both. They used to be stored separately and could
    // disagree — "flash tier, deep reasoning" was representable and meant
    // nothing, because the flash profile has no reasoning section to deepen.
    const effort = resolveEffort(modelConfig.effort);
    const modelTier = effort.tier;
    const reasoningLevel = effort.level || 'standard';

    // Tier-adaptive core instructions
    const coreInstructions = modelTier === 'flash'
      ? this._buildFlashCoreInstructions()
      : this._buildFullCoreInstructions(modelTier);

    const reasoningInstructions = this._getReasoningInstructions(modelTier, reasoningLevel, subagents);

    // Tool call format (Flash gets examples, Pro gets description only)
    const toolCallFormat = this._buildToolCallFormat(modelTier);

    const selfAwareness = `
<self_awareness>
You are currently operating in the user's workspace at: \`${this.workspace}\`
Your OWN source code (the Gemini-Agent server) is at: \`${this.agentSourceDir}\`
If the user asks you to modify yourself, you can read/write files directly in \`${this.agentSourceDir}\`.
Effort: ${effort.id} — ${effort.blurb}
</self_awareness>`;

    const combined = `
${selfAwareness}
${coreInstructions}

${reasoningInstructions}
`;

    // Topology-specific instructions
    /*
     * One block, not two.
     *
     * There were a Solo and a Duo version, and Duo's told the model it was
     * "the PRIMARY coding agent in a 2-agent system" with a "Security Reviewer
     * subagent (powered by gemini, but abstract this detail)" — a two-model
     * framing that outlived the second model, a reviewer narrowed to security
     * that `deep` then asked for general review, and an instruction to abstract
     * a detail it was being given in the same sentence.
     *
     * Its one genuinely load-bearing line survives, moved into the subagent
     * paragraph below: give the reviewer the specific paths and the purpose.
     * That is what makes a reader with no context useful rather than decorative.
     */
    const subagentParagraph = subagents ? `
You can fan work out to parallel tabs of yourself with \`ask_subagent\` — \`role: "research"\` for
read-only exploration you would otherwise do with a long serial chain of read_file calls,
\`role: "review"\` to have a finished change read by someone who does not share your assumptions,
\`role: "task"\` for a self-contained errand. Each one starts empty: it has not seen this
conversation, so send the specific file paths, the change itself, and what it is meant to do.
A reference to "the fix above" means nothing to it. They run in parallel and return to you.
Delegating judgement about what to *write* is what you cannot do — every edit is yours.` : `
There are no subagents available in this session, so planning, research, implementation and
review are all yours. Nothing can be delegated; say what you have not checked rather than
implying it was checked elsewhere.`;

    const topologyInstructions = `
## Role: Coding Agent
You are the only agent on this task — planning, implementation, review and testing are yours.
${subagentParagraph}

- When tasks are complex, create a plan first (save it to \`.agent/artifacts/implementation_plan.md\`)
- When tasked with a complex or multi-step objective, ALWAYS proactively create a \`.agent/artifacts/task.md\` checklist using the \`create_file\` tool to plan your work, similar to Antigravity IDE. Its current contents are given back to you in \`<task_checklist>\` on every turn — tick an item the moment it is done, with \`edit_file\` replacing that exact line's \`- [ ]\` with \`- [x]\`. The user is reading that file to see where you are.
- After completing all implementation and verification, summarize your work by creating a walkthrough document (save it to \`.agent/artifacts/walkthrough.md\`). Document changes made, what was tested, and validation results.
- After implementing changes, self-review: re-read the edited files and verify correctness
- If you're not confident in a change, tell the user explicitly rather than guessing`;

    // toolCallFormat goes last: <available_tools> is appended straight after
    // this block, and the format is the contract for reading that list.
    return `<system_instructions>
${modeInstructions}

${combined}

${topologyInstructions}

${toolCallFormat}
</system_instructions>`;
  }

  /**
   * Build a wrapper prompt for subagent delegation.
   * This is prepended to the user's prompt when sending to a subagent.
   */
  /**
   * What the subagent is told it is.
   *
   * This took a `role` and **ignored it**: every subagent — reviewer,
   * researcher, generic — got one "you are a HELPER SUBAGENT … return a clear,
   * concise result" wrapper. So `ask_reviewer`, `ask_researcher` and
   * `ask_subagent` were the same tool three times, and the cold adversarial
   * read that `deep` promised was never asked for anywhere. The three names
   * were the only thing implying otherwise.
   *
   * Each wrapper below leads with the one thing that role must not forget. For
   * `review` that is **read before judging**: the failure this exists to catch
   * is a reviewer reading enough to cite and then reasoning from the citation,
   * which is exactly what an unbriefed helper does with a diff.
   */
  buildSubagentWrapper(role) {
    const ROLES = {
      review: `<role>
You are a REVIEWER. You have not seen the conversation that produced this work and you cannot
see the repository state the author sees — you have only what is below, plus read-only tools.

**Read before you judge.** If the request claims something about a file, open that file and
check the claim before agreeing or disagreeing with it. Do not reason from a line number
someone quoted at you; go and read around it. A review that repeats the author's assumptions
back to them is worth nothing, and that is the failure this role exists to prevent.

Report what you found, with file and line for every claim you make. If you did not check
something, say so plainly rather than hedging — "not checked" is a useful answer and "this
should be fine" is not.
</role>

`,
      research: `<role>
You are a RESEARCHER. You have read-only tools and no memory of the conversation that sent you.

Your job is to find things and report where they are, not to judge or fix them. Answer with
file paths and line numbers; a finding without a location cannot be acted on. Cover breadth
before depth — the caller usually wants to know everywhere something appears, not everything
about the first place it appears. If you cannot find it, say where you looked, because that is
what stops the caller repeating your search.
</role>

`,
      task: `<role>
You are a HELPER SUBAGENT. The main coding agent has delegated a self-contained task to you to
run in parallel. You have read-only tools and only the context below.

Do the task and return the result, not a narration of how you got it. If the task is
underspecified, say what you assumed rather than guessing silently.
</role>

`,
    };
    // An unknown role is the generic one rather than an error: the role comes
    // from the model, and a turn should not die because it invented a word.
    return ROLES[String(role || '').toLowerCase()] || ROLES.task;
  }

  /**
   * Flash-specific ultra-concise core instructions (~300 tokens).
   * Flash models struggle with long prompts — keep it minimal.
   */
  /**
   * Flash-specific ultra-concise core instructions (~300 tokens).
   * Flash models struggle with long prompts — keep it minimal.
   */
  _buildFlashCoreInstructions() {
    return prompt('core-flash');
  }

  /**
   * Full core instructions for flash-thinking and pro tiers.
   */
  _buildFullCoreInstructions(modelTier) {
    return `## Core Principles
1. **DON'T GUESS WHEN GUESSING IS EXPENSIVE.** If a requirement is ambiguous and the wrong reading would cost real work — deleting data, rewriting a file, committing to an architecture — call the \`ask_question\` tool. It blocks until the user answers. Asking in prose does NOT reach the user; it just ends your turn. When the ambiguity is cheap to get wrong, state your reading as **⚠️ ASSUMPTION** and keep working.
2. **INVESTIGATE BEFORE ACTING.** Always read relevant files before making edits. Never edit blind.
3. **VERIFY YOUR WORK.** After making changes, re-read the file or run tests to confirm correctness.
4. **ONE STEP AT A TIME.** Break complex tasks into atomic steps. Execute them sequentially.
5. **BE SURGICAL.** Make the smallest edit that solves the problem. Don't refactor unrelated code.
6. **NEVER GUESS PATHS OR NAMES.** If you're unsure about a file path, function name, or API, use search_files or grep_search to find out.
7. **Tool Retry Logic**: If a tool call fails, analyze the error and retry with different arguments. Don't give up.
8. **NO FLUFF AROUND TOOL CALLS**: Don't narrate them ("I will now run the command", "Let me check"). Emit the JSON block plainly. A \`<thought>\` block is the one thing that may precede a tool call — it is reasoning, not fluff. Save prose for when you are actually answering the user.
9. **ONE ANSWER PER TURN.** Give a single, definitive response. Where two approaches are both reasonable, choose one, say in a line why you chose it, and name the alternative — do not hand the user a menu of drafts to pick between. If the choice is genuinely theirs to make, that is what \`ask_question\` is for.

## 2. Source Code and Execution
- ONLY reference code that you have explicitly read using \`read_file\` or \`grep_search\`.
- Never guess line numbers, function signatures, or variable names.
- When running commands, ensure the \`cwd\` is correct.

## 3. Documentation & Context Maintenance
- **Project instructions**: \`AGENT.md\` is where a project's standing rules live, walked from the code upward. If the user tells you a convention that should hold for every future turn, offer to add it there — do not keep it only in your own memory.
- **Self-Correction**: If the user states that a documented flow is wrong, you MUST: (1) Ask clarifying questions if the claim is vague. (2) Verify the claim by reading the actual source code. (3) Use \`edit_file\` to correct the document so it matches reality. (4) Once verified against the codebase, use the \`manage_memory\` tool to store the fact so you don't make the same mistake twice — it is read back to you next session.

${modelTier === 'pro' ? `## 4. Communication
- Be exceptionally concise. Skip greetings and filler.
- Format all technical output (code, file paths) in markdown.
- Give a brief summary of completed steps at the end of your turn.` : ''}

## Self-Correction Guardrails
- **edit_file mismatch**: If \`edit_file\` fails with an \`oldText\` mismatch, DO NOT guess the new text. Immediately use \`read_file\` to fetch the correct current contents, then issue a new \`edit_file\` call.
- **run_command failure**: If a command fails due to a missing dependency, install it if appropriate, or ask the user. If it fails due to syntax, fix it and run again.
- **Blocklisted commands**: If a command is rejected with "Command blocked by user blocklist", you must either find an alternative command to achieve your goal, or ask the user to remove it from their blocklist using \`/allowlist remove <cmd>\`.
- **search_files failure**: If search returns no results, broaden your query.`;
  }

  /**
   * Tier-adaptive tool call format section.
   * Flash gets concrete examples. Pro gets just the format spec.
   */
  /**
   * How to write a tool call.
   *
   * Flash gets worked examples and pro gets the spec: the smaller model copies
   * a shape far more reliably than it follows a description, and the larger one
   * does not need the tokens spent on showing it.
   */
  _buildToolCallFormat(tier) {
    return prompt(tier === 'flash' ? 'tool-call-format-flash' : 'tool-call-format-full');
  }

  /**
   * Tier-specific reasoning instructions.
   * This is the core differentiation between model tiers.
   */
  _getReasoningInstructions(tier, level = 'standard', subagents = true) {
    switch (tier) {
      case 'flash':
        return this._getFlashInstructions();
      case 'flash-thinking':
        return this._getFlashThinkingInstructions();
      case 'pro':
      default:
        return this._getProInstructions(this._normalizeLevel(level), subagents);
    }
  }

  /**
   * Reasoning levels only mean anything for the pro tier — the flash tiers are
   * defined by *not* having room for the scaffolding.
   *
   * There is one pro level since 2026-09-20, so this now has one job: turn
   * whatever it is handed — including a `brief` or `deep` left in a config
   * written by an older version — into the one level that exists. Kept as a
   * function rather than inlined because every caller reaching it is a caller
   * that would otherwise branch on a level, which is the thing being removed.
   */
  // eslint-disable-next-line class-methods-use-this
  _normalizeLevel() {
    return 'standard';
  }

  /** One-line protocol reminder. One level, so one line. */
  // eslint-disable-next-line class-methods-use-this
  _reminderLineForLevel() {
    return '- Restate the task and decompose it into a checklist first, then Investigate → Analyze → Implement → Verify.';
  }

  /**
   * FLASH tier: Ultra-concise. No thought blocks. Direct action.
   * Optimized for 2.5 Flash — short attention, weak instruction-following.
   * Budget: ~400 tokens of reasoning instructions.
   */
  /**
   * The flash tier's reasoning protocol: there is deliberately almost none.
   *
   * The handover check is the exception, and it is two lines. Flash is the
   * weakest model on the ladder, which makes it the *most* likely to report a
   * thing as done without having looked — so excluding it, which was the first
   * instinct, would have left the check off the rung that needs it most.
   *
   * Two lines rather than the pro tier's seven because this rung is 5.6k
   * characters and its whole identity is being terse: the full review is +33%
   * here against +11% on the tiers above, and a protocol that fights what the
   * tier is for is one the model follows worse, not better.
   */
  _getFlashInstructions() {
    return `${prompt('reasoning-flash')}\n\n${prompt('handover-micro')}`;
  }

  /**
   * FLASH-THINKING tier: Moderate depth. Short thought blocks. 3-phase protocol.
   * Optimized for 2.5 Flash with thinking — decent reasoning, moderate context window.
   * Budget: ~1200 tokens of reasoning instructions.
   */
  /**
   * Flash-thinking: a three-phase protocol, still a short prompt.
   *
   * The four-point handover, not the two-point one: this rung already has a
   * protocol and a context budget twice Flash's, so the check costs ~2% here.
   */
  _getFlashThinkingInstructions() {
    return `${prompt('reasoning-flash-thinking')}\n\n${prompt('handover-lite')}`;
  }

  /**
   * PRO tier: the principal-engineer protocol, at three depths.
   *
   * `reasoningLevel` scales how hard the prompt works to slow the model down.
   * More is not free — Gemini follows a short protocol more reliably than a long
   * one — so `brief` exists for small edits where the ceremony costs more than it
   * catches, and `deep` for work where being wrong is expensive.
   *
   *   brief    — investigate, implement, verify.
   *   standard — restate and decompose first, then the 4-phase protocol. (default)
   *   deep     — standard, plus approach enumeration and adversarial self-review.
   */
  _getProInstructions(level = 'standard', subagents = true) {
    /*
     * `isBrief` and `isDeep` used to live here, gating the blocks that told
     * three pro rungs apart. One rung since 2026-09-20, so both were constants:
     * every `isBrief ? a : b` took `b` and every `isDeep ? a : ''` took `''`.
     * Collapsed rather than left reading as a choice — a branch that can only
     * go one way is a comment that lies, and this file is the one with the
     * never-bulk-edit warning on it.
     *
     * What went with them: `brief`'s three-phase protocol and its shorter
     * investigation, `deep`'s CRITICAL ANALYSIS phase and its ASSUMPTION
     * LEDGER. `deep`'s third block — the review step — stayed, and is now
     * gated on `hasReviewer` alone. See `core/effort.js` for why those two and
     * not the third.
     */
    // A second *model*, not a second persona. See the review step below.
    const hasReviewer = Boolean(subagents);

    const header = `## Cognitive Mode: PRINCIPAL ENGINEER

You are operating as a SENIOR PRINCIPAL ENGINEER. Every action is deliberate, verified, and
defensible in review. You DO NOT guess. You VERIFY.
Reasoning level: **${level}**.`;

    // The heart of it: decide what you are doing before you touch anything.
    const planFirst = `\n${prompt('pro-plan-first')}\n`;

    const investigate = `
### PHASE 1: INVESTIGATION (never skip)

Before forming an opinion or writing code:

1. **Read the relevant files** — not just the target. Imports, callers, tests, configs.
2. **Trace the execution path** — who CALLS this, what it CALLS, what SIDE EFFECTS it has.
3. **Check existing tests** — what IS covered and what is NOT.
4. **Search for the project's own patterns** before deviating from them.
5. **Map the blast radius** — every file that a change here could affect.

**Chain-of-Thought**: Open each phase with a <thought> block — what you know, what you need
next, what you expect the next call to show. One per phase, not one per call: a four-point
preamble in front of every read turns a five-file investigation into twenty round-trips.

${prompt('pro-hypothesis')}`;

    const analyse = `
### PHASE 2: ANALYSIS

In a <thought> block: the root cause (not the symptom), the approach you have chosen and why,
and what could go wrong with it — empty inputs, concurrent access, scale, error propagation.`;

    const implement = `
### PHASE 3: SURGICAL IMPLEMENTATION

1. The SMALLEST change that solves the problem correctly.
2. Handle every error case explicitly — no empty catch blocks, no swallowed errors.
3. Preserve behavior on all unchanged paths.
4. Comment only non-obvious logic ("why", not "what").
5. Mark any assumption you must make: **⚠️ ASSUMPTION**: [what] — and what changes if wrong.`;

    const verify = `
### PHASE 4: VERIFICATION (never skip)

1. **Re-read the edited file** — confirm the edit landed as intended.
2. **Run the tests** if they exist.
3. **Re-check the callers** you found in Phase 1. Does your change break them?
4. **Name the gaps** — any path you introduced that nothing covers.${hasReviewer ? `
5. **Send the diff to \`ask_subagent\` with \`role: "review"\`** — a second tab, reading it
   cold, with no memory of why you chose any of it. Paste the diff itself, the file paths,
   and what the change is meant to do — it cannot see your files. Act on what comes back
   or say why you are not; do not paste it onward unread.` : `
5. **Adversarial self-review** — read the diff as a hostile reviewer. What would you flag?
   Say it out loud rather than hoping nobody looks.`}`;

    const guardrails = `\n${prompt('pro-guardrails')}`;

    /**
     * The gate at the end, asked for explicitly: a list the agent must check
     * before handing over, and a statement that it did.
     *
     * Placed after the guardrails so it is the last thing in the system
     * prompt, because it is the last thing in the turn. Skipped on `brief`,
     * where the ladder's own promise is "straight to work" — a seven-point
     * review on a one-line fix is the kind of ceremony that gets ignored, and
     * a checklist people learn to skip is worse than none.
     *
     * It leans on `<task_checklist>` riding every turn: without that the model
     * would be asked to audit a list it cannot see, which is the write-only
     * trap that made the original task.md useless.
     */
    /*
     * The handover review is **not** here any more — see `buildHandoverBlock`.
     *
     * It is instructions for the *end* of a turn, and this block is delivered at
     * the *start* of one. By the time the model has run twenty tool calls and is
     * writing its answer, 1,879 characters of "check your work" are thousands of
     * tokens behind it. That is the same failure the tool anchor exists for: the
     * model does not gradually forget, it forgets completely, and the cure was
     * to put the thing where it is needed rather than to say it louder up front.
     *
     * It now rides the tool-result prompt of the round that first changes
     * something, which is both nearer the point of use and free on the turns —
     * most of them — that only answer a question.
     */
    const handover = '';

    const assumptions = '';

    return [
      header,
      planFirst,
      '\n## MANDATORY 4-PHASE PROTOCOL',
      investigate,
      analyse,
      implement,
      verify,
      guardrails,
      assumptions,
      // Last, because it is about the end of the turn.
      handover,
    ].filter(Boolean).join('\n');
  }

  /**
   * What the model is told it can call.
   *
   * Assembled from `core/tool-catalog.js` rather than written out here. It used
   * to be two prose blocks in this method — one per tier — with a third list in
   * `agent-loop.js` and the runnable registry in `mcp/mcp-server.js`, and
   * nothing making any of them agree. `recall_history` and `get_diagnostics`
   * were registered, implemented and unreachable for exactly that reason.
   *
   * The text is unchanged: it was moved byte-for-byte and `tool-catalog.test.js`
   * pins every tier x subagent shape against what this method used to return.
   */
  _buildToolDefinitions(subagents = true, modelConfig = {}) {
    const tier = resolveEffort(modelConfig.effort).tier;
    return renderToolDefinitions(tier, subagents, modelConfig);
  }

  /**
   * Names-only tool list for the periodic reminder.
   *
   * Derived from the full definitions rather than a second hand-kept list, so the
   * two cannot drift. The chat thread still holds the real schemas from turn 0.
   */
  /**
   * The checklist the model wrote, handed back to it.
   *
   * **The same write-only trap as memory, in a second place.** The system
   * prompt tells the model to create `.agent/artifacts/task.md` and "tick items
   * off as you go", and the file it writes is read by exactly one thing: the
   * UI, to draw a row above the prompt. No prompt has ever carried its contents
   * back. Measured: absent from turn 0, from every tool-result turn, and from
   * twenty-five further turns including refreshes.
   *
   * So ticking a box meant the model either guessing the exact line text for
   * `edit_file` — which fails outright on a mismatch — or rewriting the whole
   * file from a memory that compaction erodes. Neither is something a model
   * does reliably, and the observed behaviour was the predictable one: the
   * checklist gets created and never updated.
   *
   * Unlike memory this rides on **every** turn, because ticking is a per-turn
   * act. It is the same argument as the tool anchor: a small payload that
   * prevents a failure beats a large one that detects it. A checklist is a few
   * hundred characters; the turn that silently stops tracking progress costs
   * more than that.
   *
   * Bounded like memory, for the same reason — it is model-written and nothing
   * prunes it.
   */
  _loadTaskList() {
    try {
      const file = paths.artifactPath(this.workspace, 'task.md');
      if (!existsSync(file)) return '';
      const body = readFileSync(file, 'utf-8').trim();
      if (!body) return '';

      const lines = body.split('\n');
      const items = lines.filter((l) => /^\s*[-*]\s*\[[ xX]\]/.test(l));
      // Only the checklist itself. A long preamble is the model's own prose,
      // which it does not need read back to it.
      const kept = (items.length ? items : lines).slice(0, MAX_TASK_ITEMS);
      let text = kept.join('\n');
      if (text.length > MAX_TASK_CHARS) text = `${text.slice(0, MAX_TASK_CHARS)}\n…`;
      const dropped = (items.length ? items.length : lines.length) - kept.length;
      return dropped > 0 ? `${text}\n… and ${dropped} more` : text;
    } catch {
      // An unreadable artifact must not take the prompt down.
      return '';
    }
  }

  /**
   * The one line that rides on *every* turn.
   *
   * Tool names only, no schemas: 56 tokens against 1,575 for the full
   * definitions. It exists because the model does not gradually forget its
   * tools, it forgets them completely — mid-session it will answer "I cannot
   * execute local commands or access your local file system" with total
   * confidence, and the turn is lost. Detecting that afterwards is guesswork
   * over prose; keeping a name list in front of it is not.
   *
   * The names are fixed for a given toggle state, so this is computed once.
   */
  _buildToolAnchor(subagents = true, modelConfig = {}) {
    const key = String(Boolean(subagents));
    if (this._anchorCache?.key === key) return this._anchorCache.value;

    const defs = this._buildToolDefinitions(subagents, modelConfig);
    const names = [...defs.matchAll(/^## ([a-z_]+)/gm)].map((m) => m[1]);
    const value = names.length
      ? `[tools: ${names.join(' ')}]`
      : '';
    this._anchorCache = { key, value };
    return value;
  }

  _buildToolIndex(subagents = true, modelConfig = {}) {
    const defs = this._buildToolDefinitions(subagents, modelConfig);
    const names = [...defs.matchAll(/^## ([a-z_]+)/gm)].map(m => m[1]);
    return `<available_tools>
${names.join(', ')}
Full parameter schemas were given earlier in this chat — scroll back to them rather than inventing arguments.
</available_tools>`;
  }

  /**
   * Build a condensed reminder of the system instructions.
   * Much smaller than the full prompt — just the essential rules and tool format.
   */
  _buildCondensedReminder(mode, objective = '', modelConfig = {}) {
    const modeStr = mode === 'auto' ? 'AUTO MODE (safe ops auto-applied)' : 'PLAN MODE (all edits need approval)';
    const tier = resolveEffort(modelConfig.effort).tier;

    if (tier === 'flash') {
      // Ultra-short reminder for Flash
      return `<system_reminder>
Mode: ${modeStr}. Workspace: \`${this.workspace}\`${objective ? ` | Goal: ${objective.substring(0, 80)}` : ''}
Rules: Use tools (read_file, edit_file, etc). JSON blocks: \`\`\`json {"name":..., "args":...} \`\`\`
</system_reminder>`;
    }

    return `<system_reminder>
You are Agent CLI, an AI coding assistant. Current mode: ${modeStr}. Model tier: ${tier}.
Workspace: \`${this.workspace}\`
Agent source: \`${this.agentSourceDir}\`

${objective ? `<current_objective>\n${objective}\n</current_objective>\n` : ''}
Quick rules:
- Use tools to read/edit/create files. Don't just show code.
- Tool call format: \`\`\`json {"name": "tool_name", "args": {...}} \`\`\`
- If a requirement is ambiguous, use the \`ask_question\` tool. Do not just ask textually.
- Guardrails: If edit_file fails with oldText mismatch, immediately use read_file to get the exact lines.
${tier === 'pro' ? this._reminderLineForLevel(resolveEffort(modelConfig.effort).level) : '- Think step by step. Be concise but thorough.'}
</system_reminder>`;
  }

  /**
   * `AGENT.md`, from every level between the code and the state root.
   *
   * Walked rather than read from one place, and walked from the *code* rather
   * than the workspace: with `/base-repo` open and repo-1 active, the file that
   * matters most is `repo-1/AGENT.md`, and reading `workspace/AGENT.md` missed
   * it entirely.
   *
   * Concatenated outermost-first so the nearest file has the last word, the
   * same order the shell resolves anything else. Your personal one in
   * `~/.agent/AGENT.md` is the outermost layer of all.
   */
  _loadAgentMd() {
    const files = [];
    const home = join(paths.homeDir(), 'AGENT.md');
    if (existsSync(home)) files.push(home);

    // From the state root down to the code, so nearest lands last.
    const { base } = paths.resolveState(this.workspace);
    const code = paths.codeDir(this.workspace);
    const chain = [];
    let dir = code;
    for (let i = 0; i < 32; i++) {
      chain.unshift(dir);
      if (dir === base || dirname(dir) === dir) break;
      dir = dirname(dir);
    }
    for (const d of chain) {
      const file = join(d, 'AGENT.md');
      if (existsSync(file)) files.push(file);
    }

    const parts = [];
    const found = [];
    for (const file of [...new Set(files)]) {
      try {
        const body = readFileSync(file, 'utf-8').trim();
        if (body) parts.push(body);
        found.push({ path: file, bytes: body.length, state: agentMdState(body) });
      } catch (err) {
        // An unreadable AGENT.md must not take the prompt down — but it should
        // not vanish either. Reported, so the one screen that lists sources can
        // say why a file you wrote is not in the prompt.
        found.push({ path: file, bytes: 0, state: 'unreadable', detail: err.message });
      }
    }

    // Kept, rather than discarded with the local variable it used to live in.
    // The walk is the only thing that knows which files are in play, it ran on
    // every full prompt, and nothing could ask it afterwards — so there was no
    // way to find out that the AGENT.md being sent was an unedited template.
    this.lastAgentMdFiles = found;
    return parts.join('\n\n');
  }

  /**
   * `memory.md`, numbered, and hard-bounded.
   *
   * Memory is the one context source that grows on its own — every turn can
   * add to it and nothing prunes it — so it is the one that must not be
   * allowed to grow the prompt in step. Past the cap the prompt carries the
   * count and the path instead of the contents, and the model reads the file
   * with `read_file` if it wants the rest. The prompt is retyped into a
   * browser tab; a system prompt that creeps upward for months is how you
   * arrive at Gemini's repetition filter without ever making a decision.
   *
   * Numbered because `manage_memory remove` takes a position, and until now
   * the model was choosing indices into a list it had never been shown.
   */
  _loadMemory() {
    const MAX_FACTS = 40;
    const MAX_CHARS = 4000;

    if (!readMemoryEnabled(this.workspace)) return '';

    let facts;
    try {
      facts = parseMemory(readFileSync(paths.memoryPath(this.workspace), 'utf8'));
    } catch {
      return ''; // no memory file yet, or an unreadable one
    }
    if (facts.length === 0) return '';

    const lines = [];
    let total = 0;
    for (const [i, fact] of facts.entries()) {
      if (i >= MAX_FACTS || total + fact.length > MAX_CHARS) {
        lines.push(
          `_${facts.length - i} more in ${paths.memoryPath(this.workspace)} — `
          + 'read_file it if this task needs them._',
        );
        break;
      }
      total += fact.length;
      lines.push(`${i + 1}. ${fact}`);
    }
    return lines.join('\n');
  }

  /**
   * Extra skill directories from config.json.
   *
   * Read from disk rather than passed in: `/skills dir add` writes the config
   * and the next prompt picks it up, with no second copy of the list to keep
   * in sync.
   */
  _configuredSkillFolders() {
    try {
      const cfg = JSON.parse(readFileSync(paths.configPath(this.workspace), 'utf8'));
      return Array.isArray(cfg.skillFolders) ? cfg.skillFolders : [];
    } catch {
      return [];
    }
  }

  /**
   * Reload AGENT.md (call when file changes).
   */
  reloadAgentMd() {
    this.agentMdContent = this._loadAgentMd();
  }
}

/**
 * Replace an inlined image with a note that one was sent.
 *
 * `/image` puts the whole file into the prompt as a base64 data URL, because
 * the content script rebuilds it there into a real File and pastes it into the
 * chat — there is no upload endpoint to use instead. That is fine going out and
 * ruinous going into the record: the conversation history, both session files,
 * every later compaction prompt and the retry objective would each carry a
 * megabyte of base64 that no one can read and the model has already seen.
 */
export function stripImageData(text) {
  return String(text ?? '').replace(
    /<image_data>\n?data:[^\n]+\n?<\/image_data>/g,
    '<image_data>(the image was delivered to the chat tab)</image_data>',
  );
}
