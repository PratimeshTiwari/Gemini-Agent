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
import { GITHUB_REVIEW_PROMPT } from './github-review-prompt.js';

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

    // ── Concurrency Queue ──────────────────────────────────────────
    // One comment is analyzed at a time. Others queue up.
    // 30s cooldown between completions to avoid Gemini rate limits.
    this._commentQueue = [];          // [{ pr, comment, force }]
    this._isProcessingComment = false;
    this._currentAnalysis = null;     // { commentId, prNumber, author } for UI
    this._processedCommentIds = new Set(); // Dedup within current session
    this.COMMENT_COOLDOWN_MS = 30000; // 30s between consecutive analyses

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
    // If this exact comment is currently being analyzed, return immediately
    if (this._currentAnalysis?.commentId === comment.id) {
      this.emit('status', { message: `⏳ Comment #${comment.id} is already being analyzed. Please wait.` });
      return { skipped: true, reason: 'processing' };
    }

    // Delete existing plan so deduplication doesn't skip it
    const prDir = join(this.planGenerator.outputDir, `PR-${pr.number}`);
    const planPath = join(prDir, `comment-${comment.id}.md`);
    try { unlinkSync(planPath); } catch (_) {}

    // Remove from dedup set so the queue processes it
    this._processedCommentIds.delete(comment.id);

    // Enqueue with force flag
    this._enqueueComment({ pr, comment, force: true });
    return { queued: true };
  }

  /**
   * Enqueue a comment for analysis.
   * Deduplicates automatically; force=true bypasses dedup.
   */
  _enqueueComment({ pr, comment, force = false }) {
    const key = comment.id;

    // Dedup: skip if already processed or already in queue
    if (!force) {
      if (this._processedCommentIds.has(key)) return;
      if (this._commentQueue.some(item => item.comment.id === key)) return;
    }

    this._commentQueue.push({ pr, comment });
    this._drainCommentQueue();
  }

  /**
   * Process the next item in the queue (one at a time).
   */
  async _drainCommentQueue() {
    if (this._isProcessingComment || this._commentQueue.length === 0) return;

    this._isProcessingComment = true;
    const { pr, comment } = this._commentQueue.shift();

    this._processedCommentIds.add(comment.id);
    this._currentAnalysis = { commentId: comment.id, prNumber: pr.number, author: comment.author };

    this.emit('processing_started', {
      commentId: comment.id,
      prNumber: pr.number,
      author: comment.author,
      body: comment.body,
    });

    try {
      await this._analyzeComment(pr, comment);
    } finally {
      this._currentAnalysis = null;
      this._isProcessingComment = false;

      this.emit('processing_finished', { commentId: comment.id, prNumber: pr.number });

      // Cooldown before next item
      if (this._commentQueue.length > 0) {
        setTimeout(() => this._drainCommentQueue(), this.COMMENT_COOLDOWN_MS);
      }
    }
  }

  /**
   * Run AI analysis + plan generation for a single comment.
   */
  async _analyzeComment(pr, comment) {
    const classification = this.classifier.classify(comment, this.config.ignoreAuthors, this.config.avoidWords || []);
    if (classification.category === 'noise') return;

    let aiAnalysis = null;
    if (this.agentLoop) {
      // Build structured context for the AI analysis
      const diffContext = comment.diff_hunk
        ? `<diff_context>\n\`\`\`diff\n${comment.diff_hunk}\n\`\`\`\n</diff_context>`
        : '';

      const fileContext = comment.path
        ? `<file_context path="${comment.path}"${comment.line ? ` line="${comment.line}"` : ''} />`
        : '';

      const prompt = `${GITHUB_REVIEW_PROMPT}

<pr_context>
  <pr title="${pr.title}" number="${pr.number}" branch="${pr.head_ref || 'unknown'}" />
  <comment author="${comment.author}">
${comment.body}
  </comment>
  ${fileContext}
  ${diffContext}
</pr_context>

Investigate this review comment using your tools and produce ONE consolidated markdown plan.
CRITICAL: Do NOT run \`git checkout\` or switch branches. The user may have unsaved work.`;

      try {
        const response = await this.agentLoop.runHeadlessTask(prompt);
        if (response.success) {
          aiAnalysis = response.result;
        } else {
          appendFileSync(join(this.agentLoop.workspace, 'agent.log'), `[analyzeComment] Failed: ${response.error}\n`);
        }
      } catch (e) {
        appendFileSync(join(this.agentLoop.workspace, 'agent.log'), `[analyzeComment] Exception: ${e.stack}\n`);
      }
    }

    const result = this.planGenerator.generateCommentPlan({ pr, comment, classification, aiAnalysis });
    if (result.skipped) return;

    this.stats.totalCommentsProcessed++;
    this.stats.totalPlansGenerated++;

    this.emit('plan_generated', { type: 'comment', pr, comment, classification, filePath: result.filePath, isNew: result.isNew });
    this.emit('notification', {
      message: `📝 ${classification.label} on PR #${pr.number} by @${comment.author} → ${result.filePath}`,
      category: classification.category,
      prNumber: pr.number,
    });
  }

  // ── Private: Event Wiring ──────────────────────────────────────

  _wireEvents() {
    // ── New Comment ────────────────────────────────────────────────
    this.poller.on('new_comment', ({ pr, comment }) => {
      this._enqueueComment({ pr, comment });
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
