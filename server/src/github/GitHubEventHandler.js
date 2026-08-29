/**
 * GitHub Event Handler
 *
 * Orchestrator that wires GitHubPoller events to the CommentClassifier,
 * CILogParser, and PlanGenerator. This is the glue layer.
 *
 * Flow:
 *   GitHubPoller.on('new_comment') → classify → generate plan
 *   GitHubPoller.on('ci_failure')  → parse logs → generate plan
 *
 * Also provides status/stats for the CLI `/github` command.
 */

import { EventEmitter } from 'events';
import { execSync } from 'child_process';
import { unlinkSync } from 'fs';
import { appendFileSync } from 'fs';
import { join } from 'path';
import { GitHubPoller } from './GitHubPoller.js';
import { CommentClassifier } from './CommentClassifier.js';
import { CILogParser } from './CILogParser.js';
import { PlanGenerator } from './PlanGenerator.js';
import { resolveGitHubConfig } from './github-config.js';

export class GitHubEventHandler extends EventEmitter {
  /**
   * @param {Object} options
   * @param {string} options.token - GitHub PAT
   * @param {string} options.workspace - Workspace root
   * @param {Object} [options.configOverrides] - Override default config
   * @param {Object} [options.agentLoop] - Reference to main AgentLoop
   */
  constructor({ token, workspace, configOverrides = {}, agentLoop = null }) {
    super();
    this.token = token;
    this.workspace = workspace;
    this.agentLoop = agentLoop;
    this.config = resolveGitHubConfig(configOverrides);

    // Auto-detect current repo to lock PR watching to this workspace
    try {
      const gitUrl = execSync('git config --get remote.origin.url', { cwd: workspace, encoding: 'utf-8' }).trim();
      const match = gitUrl.match(/github\.com[:/]([^\/]+\/[^\/]+?)(?:\.git)?$/i);
      if (match && match[1]) {
        this.config.repos = [match[1]];
      }
    } catch (e) {
      // Not a git repo or no origin, fallback to auto-discover
    }

    // Initialize components
    this.poller = new GitHubPoller({ token, workspace, config: this.config });
    this.classifier = new CommentClassifier();
    this.ciParser = new CILogParser();
    this.planGenerator = new PlanGenerator(workspace, this.config.planOutputDir);

    // Stats
    this.stats = {
      totalPolls: 0,
      totalCommentsProcessed: 0,
      totalCIFailuresProcessed: 0,
      totalPlansGenerated: 0,
      lastPollTime: null,
      prsWatched: 0,
    };

    this._wireEvents();
  }

  /**
   * Start watching GitHub.
   */
  async start() {
    this.emit('status', { message: '🚀 Starting GitHub PR Comment Agent...' });
    await this.poller.start();
  }

  /**
   * Stop watching.
   */
  stop() {
    this.poller.stop();
  }

  /**
   * Force immediate poll.
   */
  async refresh() {
    await this.poller.pollNow();
  }

  /**
   * Toggle CI watch on/off at runtime.
   */
  setCIWatch(enabled) {
    this.config.enableCIWatch = enabled;
    this.poller.config.enableCIWatch = enabled;
    this.emit('status', {
      message: enabled
        ? '✅ CI failure watching enabled'
        : '⛔ CI failure watching disabled',
    });
  }

  /**
   * Get current status for CLI display.
   */
  getStatus() {
    return {
      ...this.stats,
      ciWatchEnabled: this.config.enableCIWatch,
      pollInterval: `${this.config.pollIntervalMs / 1000}s`,
      planDir: this.config.planOutputDir,
      plans: this.planGenerator.listPlans(),
    };
  }

  /**
   * List generated plan files.
   */
  listPlans() {
    return this.planGenerator.listPlans();
  }

  async fetchAllOpenPRs() {
    return await this.poller.fetchAllOpenPRs();
  }

  /**
   * Force-analyze a specific comment regardless of deduplication.
   * Used by PR Explorer when user explicitly presses Enter on a comment.
   */
  async forceAnalyzeComment(pr, comment) {
    const classification = this.classifier.classify(comment, this.config.ignoreAuthors, this.config.avoidWords || []);
    // Override noise — user explicitly requested analysis
    const effectiveClassification = classification.category === 'noise'
      ? { ...classification, category: 'requires_review', matchedKeywords: [], priority: 2 }
      : classification;

    let aiAnalysis = null;
    if (this.agentLoop) {
      const diffContext = comment.diff_hunk ? `\nFile Context (Diff):\n\`\`\`diff\n${comment.diff_hunk}\n\`\`\`\n` : '';
      const prompt = `You are an elite Senior Staff Engineer. Analyze this GitHub PR comment and produce an actionable implementation plan.

PR: ${pr.title} (#${pr.number})
Comment by @${comment.author}:
> ${comment.body}
${diffContext}

Search the codebase for relevant files, understand the context, and produce a concrete step-by-step plan.`;

      try {
        const systemInstruction = `You MUST use tools (grep_search, view_file, list_dir) to explore the codebase before producing your plan. Do not guess — search first.`;
        const response = await this.agentLoop.runHeadlessTask(prompt, systemInstruction);
        if (response.success) aiAnalysis = response.result;
        else {
          appendFileSync(join(this.agentLoop.workspace, 'agent.log'), `[forceAnalyze] Failed: ${response.error}\n`);
        }
      } catch (e) {
        appendFileSync(join(this.agentLoop.workspace, 'agent.log'), `[forceAnalyze] Exception: ${e.stack}\n`);
      }
    }

    // Delete existing plan file so deduplication doesn't skip it
    const prDir = join(this.planGenerator.outputDir, `PR-${pr.number}`);
    const planPath = join(prDir, `comment-${comment.id}.md`);
    try { unlinkSync(planPath); } catch (_) {}

    const result = this.planGenerator.generateCommentPlan({ pr, comment, classification: effectiveClassification, aiAnalysis });

    if (!result.skipped) {
      this.emit('plan_generated', {
        type: 'comment',
        pr, comment,
        classification: effectiveClassification,
        filePath: result.filePath,
        isNew: result.isNew,
      });
    }
    return result;
  }

  // ── Private: Event Wiring ──────────────────────────────────────

  _wireEvents() {
    // ── New Comment ────────────────────────────────────────────────
    this.poller.on('new_comment', async ({ pr, comment }) => {
      try {
        // Classify the comment
        const classification = this.classifier.classify(comment, this.config.ignoreAuthors, this.config.avoidWords || []);

        // Skip noise
        if (classification.category === 'noise') {
          return;
        }

        let aiAnalysis = null;
        if (this.agentLoop) {
          const diffContext = comment.diff_hunk ? `\nFile Context (Diff):\n\`\`\`diff\n${comment.diff_hunk}\n\`\`\`\n` : '';
          const prompt = `You are an elite Senior Staff Engineer and Security Auditor specializing in complex code reviews and architectural design. 
Analyze the following GitHub PR comment and formulate a highly technical, rigorous, and actionable plan for the developer to address it.

Directives:
1. Identify any hidden edge cases, security vulnerabilities, or performance bottlenecks related to the request.
2. Provide concrete implementation steps. If code changes are required, specify exact modifications.
3. Suggest robust testing scenarios (unit, integration, or edge-case tests) to validate the fix.
4. Do NOT use conversational filler. Be extremely direct and technically precise.

Comment by @${comment.author}:
> ${comment.body}
${diffContext}`;
          
          try {
            const systemInstruction = `You are an elite Senior Staff Engineer and Security Auditor. You MUST use your available tools (like grep_search, view_file, list_dir, run_command) to search the workspace, analyze the codebase context around this PR comment, and verify your assumptions before forming your final plan.`;
            const subagentResponse = await this.agentLoop.runHeadlessTask(prompt, systemInstruction);
            if (subagentResponse.success) {
              aiAnalysis = subagentResponse.result;
            } else {
              appendFileSync(join(this.agentLoop.workspace, 'agent.log'), `Headless Task Failed: ${subagentResponse.error}\n`);
            }
          } catch (e) {
            appendFileSync(join(this.agentLoop.workspace, 'agent.log'), `AI Analysis threw exception: ${e.stack}\n`);
            console.error('AI Analysis failed:', e);
          }
        }

        const result = this.planGenerator.generateCommentPlan({
          pr,
          comment,
          classification,
          aiAnalysis,
        });

        if (result.skipped) {
          return;
        }

        this.stats.totalCommentsProcessed++;
        this.stats.totalPlansGenerated++;

        this.emit('plan_generated', {
          type: 'comment',
          pr,
          comment,
          classification,
          filePath: result.filePath,
          isNew: result.isNew,
        });

        this.emit('notification', {
          message: `📝 ${classification.label} on PR #${pr.number} by @${comment.author} → ${result.filePath}`,
          category: classification.category,
          prNumber: pr.number,
        });

      } catch (err) {
        this.emit('error', { message: `Failed to process comment: ${err.message}` });
      }
    });

    // ── CI Failure ─────────────────────────────────────────────────
    this.poller.on('ci_failure', ({ pr, failure }) => {
      try {
        // Parse CI logs
        let ciReport;
        if (failure.logText) {
          ciReport = this.ciParser.parse({
            logText: failure.logText,
            workflowName: failure.workflowName,
            runId: failure.runId,
            conclusion: failure.conclusion,
          });
        } else {
          ciReport = this.ciParser.parseCompact({
            workflowName: failure.workflowName,
            runId: failure.runId,
            conclusion: failure.conclusion,
            failedJobs: failure.failedJobs,
          });
        }

        // Generate plan
        const result = this.planGenerator.generateCIPlan({ pr, ciReport });

        if (result.skipped) {
          return;
        }

        this.stats.totalCIFailuresProcessed++;
        this.stats.totalPlansGenerated++;

        this.emit('plan_generated', {
          type: 'ci_failure',
          pr,
          ciReport,
          filePath: result.filePath,
          isNew: result.isNew,
        });

        this.emit('notification', {
          message: `🔴 CI failure on PR #${pr.number}: ${failure.workflowName} → ${result.filePath}`,
          category: 'ci_failure',
          prNumber: pr.number,
        });

      } catch (err) {
        this.emit('error', { message: `Failed to process CI failure: ${err.message}` });
      }
    });

    // ── Poll Complete ──────────────────────────────────────────────
    this.poller.on('poll_complete', (data) => {
      this.stats.totalPolls++;
      this.stats.lastPollTime = new Date(data.timestamp).toISOString();
      this.stats.prsWatched = data.totalPRs;

      if (data.newComments > 0 || data.newCIFailures > 0) {
        this.emit('status', {
          message: `📊 Poll #${this.stats.totalPolls}: ${data.prsChecked} PRs checked, ${data.newComments} new comments, ${data.newCIFailures} CI failures`,
        });
      }
    });

    // ── Forward status/error events ────────────────────────────────
    this.poller.on('status', (data) => this.emit('status', data));
    this.poller.on('error', (data) => this.emit('error', data));
  }
}
