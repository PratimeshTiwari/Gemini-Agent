/**
 * GitHub Event Handler
 *
 * Orchestrator that wires GitHubPoller events to the CommentClassifier,
 * CILogParser, and ReviewWriter. This is the glue layer.
 *
 * Flow:
 *   GitHubPoller.on('new_comment') → classify → generate plan
 *   GitHubPoller.on('ci_failure')  → parse logs → generate plan
 *
 * Also provides status/stats for the CLI `/github` command.
 */

import { EventEmitter } from 'events';
import { execSync } from 'child_process';
import { logError } from '../core/error-log.js';
import { unlinkSync } from 'fs';
import { join } from 'path';
import { GitHubPoller } from './github-poller.js';
import { CommentClassifier } from './comment-classifier.js';
import { CILogParser } from './ci-log-parser.js';
import { ReviewWriter } from './review-writer.js';
import { resolveGitHubConfig } from './github-config.js';
import { WorkQueue } from './work-queue.js';
import { analyseComment, triageComment } from './review-task.js';

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

    // Auto-detect the current repo, so PR watching is locked to this workspace.
    //
    // Only when nothing was asked for. `resolveGitHubConfig` already reads
    // `GITHUB_REPOS`, and this overwrote the result unconditionally — so the env
    // var was ignored in exactly the case someone would set it: watching a repo
    // that is not the one checked out here. An explicit `repos` override had the
    // same fate.
    const asked = configOverrides.repos?.length || process.env.GITHUB_REPOS;
    if (!asked) {
      try {
        const gitUrl = execSync('git config --get remote.origin.url', { cwd: workspace, encoding: 'utf-8' }).trim();
        const match = gitUrl.match(/github\.com[:/]([^\/]+\/[^\/]+?)(?:\.git)?$/i);
        if (match && match[1]) {
          this.config.repos = [match[1]];
        }
      } catch (e) {
        // Not a git repo or no origin, fallback to auto-discover
      }
    }

    // Initialize components
    this.poller = new GitHubPoller({ token, workspace, config: this.config });
    this.classifier = new CommentClassifier();
    this.ciParser = new CILogParser();
    this.planGenerator = new ReviewWriter(workspace, this.config.planOutputDir);

    // ── Concurrency Queue ──────────────────────────────────────────
    // One comment at a time, never the same one twice, and a pause between —
    // see work-queue.js for what each of those three rules is paying for.
    this.COMMENT_COOLDOWN_MS = 30000;
    this._queue = new WorkQueue({
      cooldownMs: this.COMMENT_COOLDOWN_MS,
      identify: ({ comment }) => comment.id,
      run: ({ pr, comment }) => this._analyzeComment(pr, comment),
      onStart: ({ pr, comment }) => this.emit('processing_started', {
        commentId: comment.id, prNumber: pr.number, author: comment.author, body: comment.body,
      }),
      onFinish: ({ pr, comment }) => this.emit('processing_finished', {
        commentId: comment.id, prNumber: pr.number,
      }),
      onError: (err, { pr }) => this.emit('error', {
        message: `Analysis of PR #${pr.number} failed: ${err.message}`,
      }),
    });

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
      // Which account the token actually belongs to. Worth showing: a work
      // machine often has several, and "0 PRs watched" reads very differently
      // once you can see it is watching as the wrong one.
      username: this.poller?.username || null,
      // ISO date, or null for a token GitHub reports no expiry for.
      tokenExpiry: this.poller?.tokenExpiry || null,
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
    this._queue.add({ pr, comment }, { force });
  }

  /** What is being analysed right now, for the dashboard. */
  get _currentAnalysis() {
    const item = this._queue.current;
    return item
      ? { commentId: item.comment.id, prNumber: item.pr.number, author: item.comment.author }
      : null;
  }

  /** Whether an analysis is in flight. Read by the tests and the dashboard. */
  get _isProcessingComment() {
    return this._queue.busy;
  }

  /**
   * Run AI analysis + plan generation for a single comment.
   */
  async _analyzeComment(pr, comment) {
    const classification = this.classifier.classify(comment, this.config.ignoreAuthors, this.config.avoidWords || []);
    if (classification.category === 'noise') return;

    const ask = this.agentLoop ? (prompt) => this.agentLoop.runHeadlessTask(prompt) : null;

    /**
     * Ask whether this is worth investigating, instead of guessing from words.
     *
     * The deterministic checks above stay first because they are free and
     * certain — an ignored author and an empty body need no model, and
     * `avoidWords` is an explicit instruction from the user. Everything else
     * used to go straight to a full analysis: a browser turn with the whole
     * tool set behind it, spent on "LGTM".
     *
     * Keyword matching is not the alternative; this project removed that on
     * purpose when the model took the categorising over. One short exchange is
     * the same judgement a person makes reading the comment, at a fraction of
     * an analysis.
     */
    const triage = await triageComment({
      pr, comment, ask, workspace: this.agentLoop?.workspace || this.workspace,
    });
    if (!triage.review) {
      this.stats.totalCommentsProcessed++;
      this.emit('notification', {
        message: `· PR #${pr.number} by @${comment.author}: skipped — ${triage.reason}`,
        category: 'skipped',
        prNumber: pr.number,
      });
      return;
    }

    // The prompt and the call live in review-task.js. It never throws: a
    // failed analysis must still leave a review on disk, or a flaky tab loses
    // the record of the comment entirely.
    const outcome = await analyseComment({
      pr,
      comment,
      workspace: this.agentLoop?.workspace || this.workspace,
      ask,
    });

    /**
     * A review without an analysis is not a plan.
     *
     * It used to write one anyway — the reasoning being that the comment and
     * its classification are worth keeping even when the browser turn fell
     * over. But what that produced was a file of generic instructions ("read
     * the reviewer question", "formulate a response") under a heading that
     * says a plan was generated, and a notification that reads as success.
     * Reported plainly: *"plans without AI analysis is completely useless"*.
     *
     * Worse than useless, because it hides the failure. Ten review files in
     * this repo have no analysis section and nothing ever said so.
     *
     * The record is still kept — that was the right half of the original
     * reasoning — but it is labelled for what it is, and the notification says
     * the analysis did not run rather than implying a plan is waiting.
     */
    const aiAnalysis = outcome?.ok ? outcome.text : null;
    const result = this.planGenerator.generateCommentPlan({
      pr, comment, classification, aiAnalysis,
      analysisError: outcome?.ok ? null : (outcome?.error || 'the analysis did not run'),
    });
    if (result.skipped) return;

    this.stats.totalCommentsProcessed++;
    if (aiAnalysis) this.stats.totalPlansGenerated++;

    this.emit('plan_generated', {
      type: 'comment', pr, comment, classification,
      filePath: result.filePath, isNew: result.isNew, analysed: Boolean(aiAnalysis),
    });
    this.emit('notification', {
      message: aiAnalysis
        ? `📝 ${classification.label} on PR #${pr.number} by @${comment.author} → ${result.filePath}`
        : `⚠️ PR #${pr.number} by @${comment.author}: analysis did not run — ${outcome?.error || 'unknown reason'}`,
      category: aiAnalysis ? classification.category : 'analysis_failed',
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
    // Terminal auth failure: surfaced so the UI can ask for a new token rather
    // than leaving the dashboard sitting at "0 PRs watched · polled never".
    this.poller.on('auth_rejected', (data) => this.emit('auth_rejected', data));
  }
}
