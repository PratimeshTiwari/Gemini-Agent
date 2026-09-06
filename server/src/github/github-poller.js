/**
 * GitHub Poller
 *
 * Background service that polls the GitHub REST API for:
 * - New comments on PRs authored by the authenticated user
 * - Failed GitHub Actions workflow runs on those PRs
 *
 * Uses a watermark (last-seen timestamp) to avoid re-processing old comments.
 * State is persisted to disk in .agent/state/github.json.
 */

import { EventEmitter } from 'events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';

export class GitHubPoller extends EventEmitter {
  /**
   * @param {Object} options
   * @param {string} options.token - GitHub Personal Access Token
   * @param {string} options.workspace - Workspace root path
   * @param {Object} options.config - Resolved github config
   */
  constructor({ token, workspace, config }) {
    super();
    this.token = token;
    this.workspace = workspace;
    this.config = config;
    this.apiBase = config.apiBaseUrl;
    this.perPage = config.perPage;
    this.pollTimer = null;
    this.isPolling = false;
    this.username = null; // Resolved on first poll

    // State: watermarks per PR to avoid reprocessing
    this.stateFile = resolve(workspace, config.stateFile);
    this.state = this._loadState();
  }

  /**
   * Start the polling loop.
   */
  async start() {
    // Resolve authenticated user
    try {
      this.username = await this._fetchAuthenticatedUser();
      this.emit('status', { message: `🔗 GitHub connected as @${this.username}` });
    } catch (err) {
      this.emit('error', { message: `GitHub auth failed: ${err.message}` });
      return;
    }

    // Initial poll
    await this.pollNow();

    // Start interval
    this.pollTimer = setInterval(() => {
      this.pollNow().catch(err => {
        this.emit('error', { message: `Poll error: ${err.message}` });
      });
    }, this.config.pollIntervalMs);

    this.emit('status', {
      message: `🔄 GitHub poller started (every ${this.config.pollIntervalMs / 1000}s)`,
    });
  }

  /**
   * Stop the polling loop.
   */
  stop() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.emit('status', { message: '⏹️ GitHub poller stopped' });
  }

  /**
   * Run a single poll cycle immediately.
   */
  async pollNow() {
    if (this.isPolling) {
      this.emit('status', { message: '⏳ Poll already in progress, skipping...' });
      return;
    }

    this.isPolling = true;

    try {
      const prs = await this._fetchOpenPRs();
      let newComments = 0;
      let newCIFailures = 0;

      for (const pr of prs.slice(0, this.config.maxPRsToWatch)) {
        // Fetch new comments
        const comments = await this._fetchNewComments(pr);
        for (const comment of comments) {
          newComments++;
          this.emit('new_comment', { pr, comment });
        }

        // Fetch CI failures (if enabled)
        if (this.config.enableCIWatch) {
          const failures = await this._fetchFailedRuns(pr);
          for (const failure of failures) {
            newCIFailures++;
            this.emit('ci_failure', { pr, failure });
          }
        }
      }

      // Save updated watermarks
      this._saveState();

      this.emit('poll_complete', {
        prsChecked: Math.min(prs.length, this.config.maxPRsToWatch),
        totalPRs: prs.length,
        newComments,
        newCIFailures,
        timestamp: Date.now(),
      });

    } catch (err) {
      this.emit('error', { message: `Poll failed: ${err.message}`, stack: err.stack });
    } finally {
      this.isPolling = false;
    }
  }


  /**
   * Public: Fetch all open PRs right now without updating watermarks.
   */
  async fetchAllOpenPRs() {
    return await this._fetchOpenPRs();
  }

  /**
   * Public: Fetch all comments on a specific PR without updating watermarks.
   */
  async fetchAllComments(pr) {
    const comments = [];
    try {
      const issueComments = await this._apiGet(
        `/repos/${pr.repo.full_name}/issues/${pr.number}/comments?per_page=100`
      );
      for (const c of issueComments) {
        comments.push({
          id: c.id,
          body: c.body,
          author: c.user.login,
          created_at: c.created_at,
          html_url: c.html_url,
          type: "issue_comment",
        });
      }
      
      const reviewComments = await this._apiGet(
        `/repos/${pr.repo.full_name}/pulls/${pr.number}/comments?per_page=100`
      );
      for (const c of reviewComments) {
        comments.push({
          id: c.id,
          body: c.body,
          author: c.user.login,
          created_at: c.created_at,
          html_url: c.html_url,
          type: "review_comment",
          path: c.path,
          line: c.line || c.original_line,
          diff_hunk: c.diff_hunk,
        });
      }
    } catch (err) {
      console.error("Failed to fetch comments for PR:", err.message);
    }
    
    // Sort by created_at descending (newest first)
    return comments.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }

  // ── Private: API Fetchers ──────────────────────────────────────

  async _fetchAuthenticatedUser() {
    const data = await this._apiGet('/user');
    return data.login;
  }

  /**
   * Fetch all open PRs where the authenticated user is the author.
   */
  async _fetchOpenPRs() {
    let allPRs = [];

    if (this.config.repos.length > 0) {
      // Specific repos configured
      for (const repoFullName of this.config.repos) {
        const prs = await this._apiGet(
          `/repos/${repoFullName}/pulls?state=open&per_page=${this.perPage}`
        );
        const myPRs = prs.filter(pr => pr.user.login === this.username);
        allPRs.push(...myPRs.map(pr => this._normalizePR(pr, repoFullName)));
      }
    } else {
      // Auto-discover: search for open PRs authored by the user
      const searchResult = await this._apiGet(
        `/search/issues?q=is:pr+is:open+author:${this.username}&per_page=${this.perPage}&sort=updated`
      );

      for (const item of (searchResult.items || [])) {
        // Extract repo info from the URL
        const repoMatch = item.repository_url?.match(/repos\/(.+)$/);
        if (repoMatch) {
          const repoFullName = repoMatch[1];
          allPRs.push(this._normalizePR(item, repoFullName));
        }
      }
    }

    return allPRs;
  }

  /**
   * Fetch comments on a PR that are newer than our watermark.
   */
  async _fetchNewComments(pr) {
    if (!this.state.commentWatermarks) this.state.commentWatermarks = {};
    if (!this.state.commentWatermarks[pr.key]) {
      // First time seeing this PR. Initialize watermark to now and ignore past comments.
      this.state.commentWatermarks[pr.key] = new Date().toISOString();
      return [];
    }
    const watermark = this.state.commentWatermarks[pr.key];
    const newComments = [];

    // 1. Issue comments (general PR comments)
    try {
      const issueComments = await this._apiGet(
        `/repos/${pr.repo.full_name}/issues/${pr.number}/comments?since=${watermark}&per_page=${this.perPage}`
      );

      for (const c of issueComments) {
        if (this.config.ignoreAuthors.includes(c.user.login)) continue;

        newComments.push({
          id: c.id,
          body: c.body,
          author: c.user.login,
          created_at: c.created_at,
          updated_at: c.updated_at,
          html_url: c.html_url,
          type: 'issue_comment',
        });
      }
    } catch (err) {
      this.emit('error', { message: `Failed to fetch issue comments for PR #${pr.number}: ${err.message}` });
    }

    // 2. Review comments (inline code comments)
    try {
      const reviewComments = await this._apiGet(
        `/repos/${pr.repo.full_name}/pulls/${pr.number}/comments?since=${watermark}&per_page=${this.perPage}`
      );

      for (const c of reviewComments) {
        if (this.config.ignoreAuthors.includes(c.user.login)) continue;

        newComments.push({
          id: c.id,
          body: c.body,
          author: c.user.login,
          created_at: c.created_at,
          updated_at: c.updated_at,
          html_url: c.html_url,
          type: 'review_comment',
          path: c.path,
          line: c.line || c.original_line,
          diff_hunk: c.diff_hunk,
        });
      }
    } catch (err) {
      this.emit('error', { message: `Failed to fetch review comments for PR #${pr.number}: ${err.message}` });
    }

    // Update watermark to now
    if (newComments.length > 0) {
      if (!this.state.commentWatermarks) this.state.commentWatermarks = {};
      this.state.commentWatermarks[pr.key] = new Date().toISOString();
    }

    return newComments;
  }

  /**
   * Fetch failed GitHub Actions runs for a PR.
   */
  async _fetchFailedRuns(pr) {
    const failures = [];
    const seenKey = `ci:${pr.key}`;
    const seenRunIds = this.state.seenCIRuns?.[seenKey] || [];

    try {
      // Get the head SHA for this PR
      const headSha = pr.head_sha;
      if (!headSha) return failures;

      const runs = await this._apiGet(
        `/repos/${pr.repo.full_name}/actions/runs?head_sha=${headSha}&status=failure&per_page=10`
      );

      for (const run of (runs.workflow_runs || [])) {
        if (seenRunIds.includes(run.id)) continue; // Already processed

        // Try to get logs (may fail due to permissions or size)
        let logText = null;
        try {
          const logResponse = await fetch(`${this.apiBase}/repos/${pr.repo.full_name}/actions/runs/${run.id}/logs`, {
            headers: this._headers(),
            redirect: 'follow',
          });
          if (logResponse.ok) {
            logText = await logResponse.text();
          }
        } catch {
          // Log download failed, we'll use compact info
        }

        // Get failed jobs for context
        let failedJobs = [];
        try {
          const jobs = await this._apiGet(
            `/repos/${pr.repo.full_name}/actions/runs/${run.id}/jobs`
          );
          failedJobs = (jobs.jobs || [])
            .filter(j => j.conclusion === 'failure')
            .map(j => j.name);
        } catch {}

        failures.push({
          runId: run.id,
          workflowName: run.name,
          conclusion: run.conclusion,
          html_url: run.html_url,
          logText,
          failedJobs,
          created_at: run.created_at,
        });

        // Mark as seen
        if (!this.state.seenCIRuns) this.state.seenCIRuns = {};
        if (!this.state.seenCIRuns[seenKey]) this.state.seenCIRuns[seenKey] = [];
        this.state.seenCIRuns[seenKey].push(run.id);
      }
    } catch (err) {
      this.emit('error', { message: `Failed to fetch CI runs for PR #${pr.number}: ${err.message}` });
    }

    return failures;
  }

  // ── Private: Helpers ───────────────────────────────────────────

  _normalizePR(raw, repoFullName) {
    const [owner, name] = repoFullName.split('/');
    return {
      number: raw.number || raw.pull_request?.number || parseInt(raw.html_url?.match(/\/(\d+)$/)?.[1] || '0'),
      title: raw.title,
      html_url: raw.html_url || raw.pull_request?.html_url,
      head_ref: raw.head?.ref || raw.head_ref || 'unknown',
      head_sha: raw.head?.sha || raw.head_sha || null,
      repo: {
        owner,
        name,
        full_name: repoFullName,
      },
      key: `${repoFullName}#${raw.number}`, // Unique key for watermarking
    };
  }

  async _apiGet(path) {
    const url = path.startsWith('http') ? path : `${this.apiBase}${path}`;

    const response = await fetch(url, {
      headers: this._headers(),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`GitHub API ${response.status}: ${response.statusText} — ${body.substring(0, 200)}`);
    }

    return response.json();
  }

  _headers() {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Gemini-Agent-GitHub-Poller',
    };
  }

  // ── Private: State Persistence ─────────────────────────────────

  _loadState() {
    try {
      if (existsSync(this.stateFile)) {
        return JSON.parse(readFileSync(this.stateFile, 'utf-8'));
      }
    } catch (err) {
      console.warn(`⚠️ Failed to load GitHub state: ${err.message}`);
    }
    return { commentWatermarks: {}, seenCIRuns: {} };
  }

  _saveState() {
    try {
      const dir = dirname(this.stateFile);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2), 'utf-8');
    } catch (err) {
      console.warn(`⚠️ Failed to save GitHub state: ${err.message}`);
    }
  }
}
