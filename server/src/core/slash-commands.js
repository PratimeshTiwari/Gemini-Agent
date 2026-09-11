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

/**
 * Run one slash command.
 *
 * @param {import('./agent-loop.js').AgentLoop} loop
 * @param {string} command - the name, without the leading slash
 * @param {string[]} args
 * @returns {Promise<{message: string}>} what to put in the transcript
 */
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
        return {
          message: `${renamed}${chosen.label}\n\n${chosen.blurb}\n\n`
            + `💡 Set your browser tab to **${chosen.browser}** — the prompt is written for it.`,
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
        case 'plans': {
          const plans = loop.githubHandler.listPlans();
          if (plans.length === 0) {
            return { message: '📋 No plan files generated yet. Waiting for PR comments...' };
          }
          const planList = plans.map(p =>
            `  📄 ${p.fileName} (modified: ${p.lastModified.toLocaleString()})`
          ).join('\n');
          return { message: `📋 Generated Plans (${plans.length}):\n${planList}` };
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
            `  Commands: /github plans | /github refresh | /github ci-watch <on|off> | /github clear-state | /github remove-token | /github stats`,
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
