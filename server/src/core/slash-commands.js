/**
 * The slash commands, and what each one does to the loop.
 *
 * Lifted out of `AgentLoop` unchanged. That class was 1,910 lines and did five
 * jobs — dispatching tool calls, driving the bridge, running subagents, holding
 * the config, and this. A switch with sixteen cases is the one of those with no
 * relationship to the others: it reads state, writes state, and returns a string
 * for the transcript.
 *
 * It takes the loop rather than being a method on it, which is the point. The
 * dependency now reads in the signature instead of being seventeen implicit
 * `this.` references, and the file can be understood — and tested — without
 * constructing an agent, a bridge and a browser.
 *
 * `AgentLoop.handleSlashCommand` still exists and still forwards here: this is a
 * move, not a change of interface, and every caller in the UI is untouched.
 */

import fs from 'fs';
import path from 'path';
import * as paths from './paths.js';
import { EFFORT_LEVELS, resolveEffort, foldEffort } from './effort.js';
import { logError } from './error-log.js';
import { planModelSwitch, browserModelPin } from './model-match.js';

/**
 * How long a name the banner can take.
 *
 * Exported because the settings screen now edits the name in place and has to
 * refuse the same lengths this does — and `applyAndReturn` drops the handler's
 * message on the way back to the page, so a rejection made here alone would be
 * a keystroke that silently did nothing. One number, both readers.
 */
export const MAX_AGENT_NAME = 20;

/**
 * Run one slash command.
 *
 * @param {import('./agent-loop.js').AgentLoop} loop
 * @param {string} command - the name, without the leading slash
 * @param {string[]} args
 * @returns {Promise<{message: string}>} what to put in the transcript
 */
/**
 * The commands this module handles.
 *
 * Exported because the UI has to know which ones to forward, and it used to
 * know by way of a **hand-written array** — a fourth list in a project that had
 * already been bitten three times by lists that have to agree with something
 * else. `/name` was added to the switch below and not to that array, so it
 * answered "No such command" while being fully implemented, which is the same
 * shape as a tool that runs and is never named in the prompt.
 *
 * `slash-commands.test.js` checks this against the `case` labels in the switch,
 * so adding one and forgetting the other fails the build rather than the user.
 */
export const AGENT_COMMANDS = new Set([
  'plan', 'auto', 'memory', 'mode', 'config', 'name', 'clear', 'context', 'new',
  'compact', 'undo', 'agent-dir', 'model', 'reasoning', 'effort', 'allowlist',
  'workspace',
]);

/**
 * The local commands that are worth a spinner.
 *
 * Every local command used to get one. `handleSubmit` set `isProcessing(true)`
 * and `'Thinking...'` for anything starting with `/`, and each handler ends by
 * setting it false — so an instant command drew a `Thinking…` row and erased it
 * milliseconds later, having in between committed its own output to `<Static>`.
 * The live row is stranded above the static write and becomes permanent
 * scrollback: reported from use as a `Thinking… (0s · ↑ 29.4k tokens · esc to
 * stop)` sitting above `❯ /image` forever, one per command, frozen at 0s.
 * Above, because it was drawn before the rows it now sits on top of.
 *
 * `/compact` asks the model for a summary, so it waits on a browser round trip.
 * `/new` fires `startNewChat` without awaiting it, and the rest are arithmetic
 * on state already in memory.
 *
 * A set beside the commands rather than a literal at the call site, for the
 * same reason `MUTATING_TOOLS` is: the literal is what drifts.
 */
export const SLOW_COMMANDS = new Set(['compact']);

/**
 * Whether *this invocation* is worth a spinner.
 *
 * A set could only answer for a whole command, and `/update` is two commands
 * wearing one name. Bare `/update` runs `checkForUpdate`, which is
 * `git fetch origin` — measured at **1,086 ms** on a warm connection and
 * bounded by `FETCH_TIMEOUT_MS` at **10 s** on a cold one. `/update done` reads
 * a file and answers instantly.
 *
 * Reported from use as *"/update seems glitched out, its loading is a bit late
 * and no loading animation"*, which is exactly what a second to ten seconds of
 * nothing looks like after the input box has already cleared.
 *
 * `use-slash-commands.js` used to say a spinner was "not available, because
 * `SLOW_COMMANDS` is keyed on the first word and `/update` on its own answers
 * instantly". The second half of that was never true — it was measured only
 * after the report — and keying on the first word is the part this fixes. The
 * committed announcement row before `npm install` stays either way: it survives
 * in scrollback, where a spinner cannot.
 *
 * @param {string} command - the word after the slash, lower-cased
 * @param {string[]} [args]
 */
export function isSlowCommand(command, args = []) {
  if (SLOW_COMMANDS.has(command)) return true;
  // Every form but `done` reaches the network: bare reports, `pull`/`now` also
  // merge and may `npm install`.
  if (command === 'update') return (args[0] || '').toLowerCase() !== 'done';
  return false;
}

export async function handleSlashCommand(loop, command, args) {
  switch (command) {
    case 'plan':
      loop.mode = 'plan';
      return { message: '🔒 Switched to Plan Mode. All edits require approval.' };

    case 'auto':
      loop.mode = 'auto';
      return { message: '⚡ Switched to Auto Mode. Safe edits will be auto-applied.' };

    // `/memory` used to *toggle* memory, so typing it to look at something
    // switched it off. It shows what is remembered now; on/off is a word you
    // have to say, and it sticks across restarts because it lives in config.
    case 'memory': {
      const action = (args?.[0] || '').toLowerCase();

      if (action === 'on' || action === 'off') {
        loop.memoryManager.memoryEnabled = action === 'on';
        loop._saveConfig();
        loop.promptBuilder?.resetPromptState?.();
        return {
          message: action === 'on'
            ? '🧠 Memory on — learned facts go back into the prompt.'
            : '🧠 Memory off — nothing new is learned and nothing is recalled.',
        };
      }

      if (action === 'forget') {
        const which = args?.[1];
        if (!which) return { message: 'Usage: `/memory forget <number>` — the numbers are the ones `/memory` shows.' };
        const ok = loop.memoryManager.removeMemory(which);
        loop.promptBuilder?.resetPromptState?.();
        return { message: ok ? `🗑️ Forgot #${which}.` : `Nothing at #${which}.` };
      }

      const facts = loop.memoryManager.getAllMemories();
      const where = paths.memoryPath(loop.workspace);
      if (facts.length === 0) {
        return {
          message: `🧠 Nothing remembered yet.\n\nFacts land in \`${where}\` as the agent `
            + 'learns them, and it is an ordinary markdown file — edit it freely.',
        };
      }
      return {
        message: `### 🧠 Memory — ${facts.length} fact${facts.length === 1 ? '' : 's'}`
          + `${loop.memoryManager.isMemoryEnabled() ? '' : ' _(off — not being recalled)_'}\n\n`
          + facts.map((f, i) => `${i + 1}. ${f}`).join('\n')
          + `\n\n_\`${where}\` · \`/memory forget <n>\` · \`/memory off\`_`,
      };
    }

    /**
     * Topology is derived from whether a reviewer is set, so there is one
     * place to change it and no way for the two to disagree.
     *
     * There is one model now. `main` survives as a concept because everything
     * downstream reads `mainModel`, but it has nothing to switch to, so the
     * command is really an on/off for the reviewer. `reviewer gemini` used to
     * be refused outright — a same-model review was both pointless and unsafe,
     * because the extension raced two requests for one tab. Tab identity fixed
     * the second, and the first was always narrower than it sounded: the
     * reviewer's value is that it has not seen the conversation, not that it
     * has different weights.
     */
    /**
     * One toggle. There is one model, so "who reviews" stopped being a
     * question — what is left is whether this session can fan work out to
     * parallel tabs of itself at all.
     *
     * `reviewer <model>` and the single/duo topology it stood for are gone;
     * `_loadConfig` folds an old config into this.
     */
    case 'mode':
    case 'config': {
      const word = String(args?.[0] || '').toLowerCase();
      const value = String(args?.[1] ?? '').toLowerCase();
      const OFF = ['off', 'none', 'no', 'false', 'solo'];
      const ON = ['on', 'yes', 'true', 'gemini', 'duo'];

      // `/config off` as well as `/config subagents off`: the noun is the only
      // thing this command has, so requiring it is ceremony.
      const asked = ['subagents', 'subagent', 'reviewer'].includes(word) ? value : word;

      if (OFF.includes(asked)) {
        loop.modelConfig.subagents = false;
        loop._saveConfig();
        loop.promptBuilder.resetPromptState();
        return {
          message: '👤 Subagents off — one tab, start to finish. Research, review and '
            + 'implementation are all this conversation.',
        };
      }

      if (ON.includes(asked)) {
        loop.modelConfig.subagents = true;
        loop._saveConfig();
        loop.promptBuilder.resetPromptState();
        return {
          message: '🔭 Subagents on — `ask_subagent` can fan work out to parallel tabs.\n\n'
            + 'Each one starts with an empty context: it has not seen this conversation, which '
            + 'is the point of the `review` role and the cost of the others.',
        };
      }

      const renamed = command === 'mode'
        ? '_(`/mode` is now `/config` — there is one model, so the only question left is '
          + 'whether it can delegate.)_\n\n'
        : '';
      return {
        message: `${renamed}### 🌐 Subagents: ${loop.subagentsEnabled ? '**on**' : '**off**'}\n\n`
          + '  `ask_subagent` opens a second tab of this model with an empty context.\n'
          + '  Roles: `research` (explore), `review` (read a change cold), `task` (an errand).\n\n'
          + '_`/config subagents on` · `/config subagents off`_',
      };
    }

    /**
     * Name the agent, which until now could only be done by editing a file.
     *
     * `config.agentName` has always been read — the banner uses it — and
     * *nothing has ever written it* except a migration from a layout that no
     * longer exists. So on a fresh clone there was no file to edit and no
     * command to run, and the only way to discover the feature was to find the
     * key in someone else's config.
     */
    case 'name': {
      const wanted = args.join(' ').trim();
      const current = loop.agentName;
      if (!wanted) {
        return {
          message: current
            ? `The agent is called **${current}**.\n\n_\`/name <text>\` to change it, \`/name default\` to undo._`
            : 'The agent has no name set — the banner reads "Agent CLI".\n\n_`/name <text>` to give it one._',
        };
      }

      // Drawn as a figlet wordmark, so a long one is a wall of ASCII.
      if (wanted.length > MAX_AGENT_NAME) {
        return { message: `! "${wanted}" is too long for the banner — ${MAX_AGENT_NAME} characters or fewer.` };
      }

      const clearing = wanted.toLowerCase() === 'default' || wanted.toLowerCase() === 'reset';
      loop.agentName = clearing ? '' : wanted;
      loop._saveConfig();
      return {
        message: clearing
          ? 'Name cleared — the banner reads "Agent CLI" again.\n\n_Restart to see it._'
          : `The agent is called **${wanted}**.\n\n_Restart to see it in the banner._`,
      };
    }

    /**
     * Start a new conversation — from either front-end.
     *
     * It lived in the CLI's slash-command hook, so the side panel sending
     * `/new` was told "No such command". The same shape as `/name` answering
     * that while fully implemented, and `/workspace <path>` silently ignoring
     * its argument: a command implemented in the UI layer is invisible to every
     * other surface.
     *
     * The substance is here; each front-end still clears its own view, because
     * that is the one part that genuinely differs.
     *
     * It **files** the old conversation rather than destroying it — `/new`
     * means "start another", not "lose that one" — and takes the artifacts
     * with it. Leaving `task.md` behind is what put a finished checklist under
     * the first prompt of the next task.
     */
    case 'new': {
      const filed = loop.sessionStore.rollover();
      loop.sessionStore.clear();
      loop.conversationHistory = [];
      loop.promptBuilder.resetPromptState();
      loop.contextChars = 0;
      // A fresh browser thread too, or the model keeps the old conversation's
      // memory while everything else has moved on. `startNewChat` clears
      // `chatThread` itself and keeps the outgoing id as `previousThread` —
      // clearing it here first threw that away before it could be recorded.
      loop.startNewChat?.();
      // Name it. "The previous one is kept" is only useful if you can say
      // which one, and the id is the thing `--resume` takes.
      return {
        message: filed
          ? `✨ New chat. The previous one is filed as \`${filed}\` — \`agent --resume ${filed}\` brings it back.`
          : '✨ New chat.',
        reset: true,
      };
    }

    /**
     * `/clear` clears the CLI's record. `/new` starts a fresh conversation.
     * Different commands, different jobs, and this one deliberately leaves the
     * browser tab alone — the model still remembers.
     *
     * Which is why it must not zero `contextChars`. That counter is
     * "everything ever typed into the browser tab" (`AgentLoop.contextTokens`),
     * and the tab still holds it, so zeroing it made the status bar, `/context`
     * and the auto-compaction threshold all describe a thread that does not
     * exist. The bar reading 40% straight after a clear is not a glitch: it is
     * the useful half of what just happened.
     */
    case 'clear':
      loop.conversationHistory = [];
      loop.sessionStore.clear();
      loop.promptBuilder.resetPromptState();
      // `reset` so every front-end drops the transcript it is showing. Without
      // it the panel kept displaying a conversation the agent had forgotten.
      /*
       * Say which half went.
       *
       * "Conversation history cleared" reads as *all of it*, and it is not:
       * the browser tab still holds every turn, so the model remembers a
       * conversation the CLI has forgotten. Reported as confusing, and it is
       * also the only thing that explains why the context bar does not drop to
       * zero here — which is correct, and looks like a bug without this line.
       */
      return {
        message: '🧹 Window cleared. The agent has forgotten this conversation; '
          + 'the Gemini tab has not — `/new` starts a fresh one there.',
        reset: true,
      };

    // `/context` reports what is in the window. Registering folders of .md
    // files here was a second way to give the model standing instructions;
    // AGENT.md is the only one now, so only the report is left.
    case 'context':
      return await loop._getContextInfo();

    case 'compact': {
      const focus = args?.join(' ') || '';
      return await loop._compactHistory(focus);
    }

    case 'undo': {
      const result = loop.diffEngine.undo();
      return result;
    }

    // Read-only. The workspace decides where state, sessions, memory and the
    // command allowlist live, and `setWorkspace` rebound four collaborators
    // but not the session store (deliberately), the memory manager, or the
    // config — so after a switch the agent recalled the new project's memory
    // while writing facts into the old one's file, and the old project's
    // allowlist stayed armed. A restart rebinds everything; nothing else does.
    // `/workspace` is handled in the UI layer now: it opens one screen whose
    // heading is this report, and `/workspace <path>` restarts into that path.
    // Only `/agent-dir` still lands here, and only to answer a different
    // question — where the agent's *own source* is.
    case 'agent-dir': {
      return {
        message: `📂 Workspace: \`${loop.workspace}\`\n`
          + `   State:     \`${paths.agentDir(loop.workspace)}\`\n\n`
          + `The agent's own source is at \`${loop.agentSourceDir}\`. You do not need to `
          + 'switch to it — file tools take absolute paths, and the system prompt already '
          + 'tells the model it may edit itself there.\n\n'
          + 'To work somewhere else: `/workspace <path>`, which restarts into it.',
      };
    }

    // One ladder replaces /model and /reasoning. They were two knobs whose
    // nine combinations had five meanings — see core/effort.js.
    case 'model':
    case 'reasoning':
    case 'effort': {
      const renamed = command !== 'effort'
        ? `_(\`/${command}\` is now \`/effort\` — one setting instead of two.)_\n\n`
        : '';
      const wanted = args?.[0]?.toLowerCase();

      /*
       * `foldEffort`, not `isEffort`: the rungs were renamed on 2026-09-26 and
       * `/effort pro` is in the owner's fingers, in this repo's own docs, and
       * in every transcript before today. Rejecting it as "not an effort
       * level" would be technically correct and useless — and the rejection
       * path prints the ladder, so the old word would look like a typo rather
       * than a rename. Folded words select the rung they always meant.
       */
      if (wanted && foldEffort(wanted)) {
        const chosen = resolveEffort(wanted);
        const before = resolveEffort(loop.modelConfig.effort);
        loop.modelConfig.effort = chosen.id;
        loop._saveConfig();
        loop.promptBuilder.resetPromptState();

        // Switch the browser too, rather than asking the user to.
        //
        // Every rung has always named the tab it expects, and the only thing
        // that happened was a hint — so a prompt written for Pro was routinely
        // typed into a Flash tab, which CLAUDE.md names as the worst case: the
        // long prompt goes to the model that handles long prompts worst.
        //
        // `planModelSwitch` matches against what the picker is *actually*
        // offering, because the names move and the list differs by plan. If the
        // browser has not been asked yet, it is asked now and the hint stands
        // for this one time.
        /*
         * One row, because that is what the change is.
         *
         * This used to answer with four lines — the rung's label, its blurb,
         * the browser line, and an italic paragraph explaining that the picker
         * gets read back. Reported as confusing: picking from the menu pushes
         * only the answer, so a four-line blurb appeared in the transcript with
         * nothing above saying where it came from.
         *
         * So the row *is* the record: what it was, what it is, and what the
         * browser is being asked to do. The blurbs still exist — bare `/effort`
         * lists every rung with one — they just are not the confirmation.
         *
         * `⚙` is phase 4.2's marker for "this program said it", scoped to this
         * one call site rather than all 67.
         */
        const plan = planModelSwitch(
          chosen.id, loop.modelOptions || [], browserModelPin(loop.modelConfig, chosen.id),
        );

        // "pinned" is said out loud because a pin and a lucky intent match look
        // identical in the result, and only one of them is something you chose.
        const pinned = plan.pinned ? ' _(pinned)_' : '';

        let browser;
        if (plan.action === 'switch') {
          loop.switchModelTo(plan.model.label);
          browser = `switching the browser to **${plan.model.label}**${pinned}`;
        } else if (plan.action === 'none') {
          browser = `browser already on **${plan.model.label}**${pinned}`;
        } else {
          loop._pendingEffortSwitch = chosen.id;
          loop.requestModelOptions?.(true);
          /*
           * The one branch that cannot confirm anything: there is no model list
           * to match against, so say so and offer the key that shows the tab.
           *
           * Past tense deliberately. This row goes into `<Static>` the moment
           * the command runs and is never repainted, so "asking the browser"
           * read as live status for the rest of the session — reported from use
           * with a screenshot of it sitting above a stale picker. It is a record
           * of an attempt; the follow-up comes from `requestModelOptions`'s
           * watchdog, which now says something when nothing comes back.
           */
          browser = `asked the browser for **${chosen.browser}** — \`ctrl+b\` shows the tab`;
        }

        // A pin naming something this plan does not offer is the single way
        // this feature can fail quietly, so it is the one thing always said.
        if (plan.pinMissed) browser += ` · ⚠ ${plan.pinMissed}`;

        /*
         * What the change actually costs, said once and only when it applies.
         *
         * `resetPromptState()` above means the next message carries the whole
         * system prompt — up to 26 KB — into a thread that already has one.
         * That is precisely the large-repeated-payload case Gemini's repetition
         * and A/B filters react to, and it is invisible: the command looks
         * instant and the price arrives on the next turn.
         *
         * A line, not a confirmation dialog. `/effort` is used often enough
         * that a prompt on every change is friction, and `/compact` already
         * hands the thread over properly.
         */
        const midChat = (loop.conversationHistory?.length > 0)
          ? '\n  _next message resends the full prompt into this chat — `/compact` starts a fresh one_'
          : '';

        const change = before.id === chosen.id
          ? `already **${chosen.name}**`
          : `**${before.name}** → **${chosen.name}**`;

        return { message: `${renamed}⚙ effort  ${change} · ${browser}${midChat}` };
      }

      const now = resolveEffort(loop.modelConfig.effort);
      const list = EFFORT_LEVELS
        .map((e) => `  ${e.label} \`/effort ${e.id}\`${e.id === now.id ? '  ← current' : ''}\n      ${e.blurb}`)
        .join('\n');
      /*
       * A word that is not a rung has to be *rejected*, not ignored.
       *
       * Falling through to the status display is what this did, so `/effort
       * deeep` printed "Effort: Standard" and the ladder — which reads exactly
       * like a confirmation. The typo is the likeliest way to get here, and the
       * one case where silence is worst: you believe the setting changed, and
       * every later turn goes out on the old rung.
       */
      const rejected = wanted && !foldEffort(wanted)
        ? `⚠ \`${wanted}\` is not an effort level — nothing changed.\n\n`
        : '';
      return {
        message: `${renamed}${rejected}🎚️ Effort: **${now.label}** · browser tab: **${now.browser}**\n\n${list}`,
      };
    }

    case 'allowlist': {
      const action = args?.[0]?.toLowerCase();
      const rest = args?.slice(1).join(' ').trim();
      const rules = loop.commandRules;

      // `add` was missing entirely: rules could only ever appear by answering
      // "Allow Always" on a prompt, so there was no way to pre-approve a
      // command you already knew you wanted.
      if ((action === 'add' || action === 'allow') && rest) {
        if (!rules.allow.includes(rest)) rules.allow.push(rest);
        rules.block = rules.block.filter((c) => c !== rest);
        loop._saveConfig();
        return { message: `✔ Allowed: \`${rest}\`` };
      }
      if (action === 'block' && rest) {
        if (!rules.block.includes(rest)) rules.block.push(rest);
        rules.allow = rules.allow.filter((c) => c !== rest);
        loop._saveConfig();
        return { message: `⛔ Blocked: \`${rest}\`` };
      }
      if (action === 'remove' && rest) {
        const had = rules.allow.includes(rest) || rules.block.includes(rest);
        rules.allow = rules.allow.filter((c) => c !== rest);
        rules.block = rules.block.filter((c) => c !== rest);
        loop._saveConfig();
        return { message: had ? `🗑️ Removed: \`${rest}\`` : `Not a rule: \`${rest}\`` };
      }
      if (action === 'clear') {
        const n = rules.allow.length + rules.block.length;
        rules.allow = [];
        rules.block = [];
        loop._saveConfig();
        return { message: `🧹 Cleared ${n} rule${n === 1 ? '' : 's'}.` };
      }
      if (action === 'enable' || action === 'disable') {
        rules.enabled = action === 'enable';
        loop._saveConfig();
        return {
          message: rules.enabled
            ? '✔ Command rules **enabled** — allowed commands run without asking.'
            : '⛔ Command rules **disabled** — every command asks for approval.',
        };
      }

      // Counts, not contents. A rule can be a whole compound shell command,
      // and printing every one of them turned "what is this command?" into a
      // page of git incantations. The picker is where you read and remove them.
      return {
        message: `### 🛡️ Command rules — ${rules.enabled !== false ? 'enabled' : 'disabled'}\n\n`
          + `${rules.allow.length} allowed · ${rules.block.length} blocked\n\n`
          + '_`/allowlist` on its own opens the picker — view, add, or remove there._',
      };
    }

    default:
      return { message: `Unknown command: /${command}. Available: /plan, /auto, /clear, /context, /compact, /undo, /workspace, /agent-dir, /model, /allowlist, /github` };
  }
}
