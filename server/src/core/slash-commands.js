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
import { EFFORT_LEVELS, resolveEffort, isEffort } from './effort.js';
import { logError } from './error-log.js';
import { planModelSwitch } from './model-match.js';

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
  'plan', 'auto', 'memory', 'mode', 'config', 'name', 'clear', 'context',
  'compact', 'undo', 'agent-dir', 'model', 'reasoning', 'effort', 'allowlist',
  'github', 'workspace',
]);

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

    // Topology is derived from whether a reviewer is set, so there is one
    // place to change it and no way for the two to disagree.
    case 'mode':
    case 'config': {
      const role = args?.[0]?.toLowerCase();
      const model = args?.[1]?.toLowerCase();
      const MODELS = ['gemini', 'chatgpt'];

      if (role === 'reviewer' && (model === 'none' || model === 'off')) {
        loop.modelConfig.reviewer = null;
        loop._saveConfig();
        loop.promptBuilder.resetPromptState();
        return { message: '👤 Solo — one model plans, implements and reviews its own work.' };
      }

      if (['main', 'reviewer'].includes(role) && MODELS.includes(model)) {
        if (role === 'reviewer' && model === loop.mainModel) {
          // The point of a reviewer is different blind spots. Same model,
          // same blind spots, and the extension would race the two requests
          // for one tab besides.
          return {
            message: `❌ The reviewer has to be a *different* model from the main agent `
              + `(currently **${loop.mainModel}**). Try \`/config reviewer `
              + `${MODELS.find((m) => m !== loop.mainModel)}\`, or \`/config reviewer none\`.`,
          };
        }
        loop.modelConfig[role] = model;
        if (role === 'main' && loop.modelConfig.reviewer === model) loop.modelConfig.reviewer = null;
        loop._saveConfig();
        loop.promptBuilder.resetPromptState();
        return {
          message: `✅ ${role} → **${model}**\n\nNow running **${loop.topology}**`
            + `${loop.topology === 'duo' ? ` — ${loop.mainModel} implements, ${loop.modelConfig.reviewer} reviews.` : ' — one model, start to finish.'}`,
        };
      }

      const renamed = command === 'mode'
        ? '_(`/mode` is now `/config` — the topology follows from who reviews.)_\n\n'
        : '';
      return {
        message: `${renamed}### 🌐 ${loop.topology === 'duo' ? 'Duo' : 'Solo'}\n\n`
          + `  Main:     **${loop.mainModel}**\n`
          + `  Reviewer: **${loop.modelConfig.reviewer || 'none'}**\n\n`
          + '_`/config main <gemini|chatgpt>` · `/config reviewer <gemini|chatgpt|none>`_\n'
          + '_A reviewer on the other model is the point — the same model reviewing itself has the same blind spots._',
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
      if (wanted.length > 20) {
        return { message: `! "${wanted}" is too long for the banner — 20 characters or fewer.` };
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

    case 'clear':
      loop.conversationHistory = [];
      loop.sessionStore.clear();
      loop.promptBuilder.resetPromptState();
      loop.contextChars = 0;
      return { message: '🧹 Conversation history cleared.' };

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

      if (wanted && isEffort(wanted)) {
        const chosen = resolveEffort(wanted);
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
        const plan = planModelSwitch(chosen.id, loop.modelOptions || []);
        let browserLine;
        if (plan.action === 'switch') {
          loop.switchModelTo(plan.model.label);
          browserLine = `🔀 Switching the browser to **${plan.model.label}**.`;
        } else if (plan.action === 'none') {
          browserLine = `✓ The browser is already on **${plan.model.label}**.`;
        } else {
          loop._pendingEffortSwitch = chosen.id;
          loop.requestModelOptions?.();
          browserLine = `🔀 Asking the browser to switch to the ${chosen.browser} tier…`
            + `\n\n_If nothing happens: reload the extension at \`chrome://extensions\` and `
            + 'hard-refresh the Gemini tab, then try again._';
        }

        return {
          message: `${renamed}${chosen.label}\n\n${chosen.blurb}\n\n${browserLine}`,
        };
      }

      const now = resolveEffort(loop.modelConfig.effort);
      const list = EFFORT_LEVELS
        .map((e) => `  ${e.label} \`/effort ${e.id}\`${e.id === now.id ? '  ← current' : ''}\n      ${e.blurb}`)
        .join('\n');
      return {
        message: `${renamed}🎚️ Effort: **${now.label}** · browser tab: **${now.browser}**\n\n${list}`,
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
        return { message: `✅ Allowed: \`${rest}\`` };
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
            ? '✅ Command rules **enabled** — allowed commands run without asking.'
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

    case 'github': {
      const subCommand = args?.[0]?.toLowerCase();

      if (subCommand === 'remove-token') {
        delete process.env.GITHUB_TOKEN;
        loop.modelConfig.githubToken = '';
        loop._saveConfig();
        if (loop.githubHandler) {
          loop.githubHandler.stop();
          loop.githubHandler = null;
        }
        return { message: '🗑️ GitHub token removed. Set GITHUB_TOKEN and restart to reconnect.' };
      }

      if (!loop.githubHandler) {
        return { message: '⚠️ GitHub Agent not initialized. Set GITHUB_TOKEN env var and restart.' };
      }

      switch (subCommand) {
        // `reviews`, because `/plans` already meant something else. These are
        // what the agent worked out about somebody's comment; `/plans` reads
        // `.agent/artifacts/plans/`, a different format written by a different
        // path. `plans` still answers, because someone who learned the old word
        // should get their list rather than "unknown subcommand".
        case 'reviews':
        case 'plans': {
          const reviews = loop.githubHandler.listPlans();
          if (reviews.length === 0) {
            return { message: '📋 No reviews written yet. Waiting for PR comments...' };
          }
          const list = reviews.map(p =>
            `  📄 ${p.fileName} (modified: ${p.lastModified.toLocaleString()})`
          ).join('\n');
          return { message: `📋 PR reviews (${reviews.length}) — \`.agent/github-reviews/\`:\n${list}` };
        }

        case 'refresh': {
          loop.githubHandler.refresh().catch(err => {
            logError(loop.workspace, {
              flow: 'github', op: 'refresh',
              message: `Refresh error: ${err.message}`, detail: err.stack,
            });
          });
          return { message: '🔄 Forcing immediate GitHub poll...' };
        }

        case 'ci-watch': {
          const toggle = args?.[1]?.toLowerCase();
          if (toggle === 'on') {
            loop.githubHandler.setCIWatch(true);
            return { message: '✅ CI failure watching enabled.' };
          } else if (toggle === 'off') {
            loop.githubHandler.setCIWatch(false);
            return { message: '⛔ CI failure watching disabled. Only comments will be tracked.' };
          }
          const ciStatus = loop.githubHandler.config.enableCIWatch;
          return { message: `🔧 CI Watch is currently: **${ciStatus ? 'ON' : 'OFF'}**\nUsage: \`/github ci-watch <on|off>\`` };
        }

        case 'clear-state': {
          const stateFile = paths.githubStatePath(loop.workspace);
          if (fs.existsSync(stateFile)) {
            fs.unlinkSync(stateFile);
          }
          if (loop.githubHandler && loop.githubHandler.poller) {
             loop.githubHandler.poller.state = { commentWatermarks: {}, seenCIRuns: {} };
             loop.githubHandler.refresh();
          }
          return { message: '🗑️ GitHub Poller state cleared! Rescanning...' };
        }

        case 'stats': {
          if (!loop.githubHandler) {
            return { message: 'GitHub integration is currently disabled. Please setup your token first.' };
          }
          // Show status
          const status = loop.githubHandler.getStatus();
          const statusLines = [
            `📊 GitHub Agent Status:`,
            `  PRs Watched: ${status.prsWatched}`,
            `  Total Polls: ${status.totalPolls}`,
            `  Comments Processed: ${status.totalCommentsProcessed}`,
            `  CI Failures Processed: ${status.totalCIFailuresProcessed}`,
            `  Plans Generated: ${status.totalPlansGenerated}`,
            `  CI Watch: ${status.ciWatchEnabled ? '✅ ON' : '⛔ OFF'}`,
            `  Poll Interval: ${status.pollInterval}`,
            `  Last Poll: ${status.lastPollTime || 'Never'}`,
            `  Plan Directory: ${status.planDir}`,
            ``,
            `  Commands: /github reviews | /github refresh | /github ci-watch <on|off> | /github clear-state | /github remove-token | /github stats`,
          ];
          return { message: statusLines.join('\n') };
        }
        default: {
          if (!subCommand) {
            return { message: 'Usage: /github <plans|refresh|ci-watch|clear-state|remove-token|stats>' };
          }
          return { message: `❌ Unknown github command: '${subCommand}'\nUsage: /github <plans|refresh|ci-watch|clear-state|remove-token|stats>` };
        }
      }
    }

    default:
      return { message: `Unknown command: /${command}. Available: /plan, /auto, /clear, /context, /compact, /undo, /workspace, /agent-dir, /model, /allowlist, /github` };
  }
}
