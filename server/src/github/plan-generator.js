/**
 * Plan Generator
 *
 * Generates structured .md plan files from classified GitHub PR comments
 * and CI failure reports. Output goes to {workspace}/.agent/github-pr-plans/
 *
 * File naming: PR-{number}.md
 * If multiple actionable comments exist on the same PR, they're appended
 * as sections within the same file.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { REL_PLANS_DIR } from '../core/paths.js';
import { resolve, join } from 'path';

export class PlanGenerator {
  /**
   * @param {string} workspace - Workspace root directory
   * @param {string} outputDir - Relative dir name (default: .agent/github-pr-plans)
   */
  constructor(workspace, outputDir = REL_PLANS_DIR) {
    this.workspace = workspace;
    this.outputDir = resolve(workspace, outputDir);
  }

  /**
   * Generate or append to a plan file for a PR comment.
   *
   * @param {Object} options
   * @param {Object} options.pr - PR metadata
   * @param {number} options.pr.number
   * @param {string} options.pr.title
   * @param {string} options.pr.html_url
   * @param {string} options.pr.head_ref - Branch name
   * @param {Object} options.pr.repo - { owner, name, full_name }
   * @param {Object} options.comment - Comment data
   * @param {string} options.comment.body
   * @param {string} options.comment.author
   * @param {string} options.comment.created_at
   * @param {string} options.comment.html_url
   * @param {number} options.comment.id
   * @param {string} [options.comment.path] - File path (for inline review comments)
   * @param {number} [options.comment.line] - Line number (for inline review comments)
   * @param {string} [options.comment.diff_hunk] - Diff context (for inline review comments)
   * @param {Object} options.classification - From CommentClassifier
   * @param {string} [options.aiAnalysis] - Optional AI context analysis
   * @returns {{ filePath: string, isNew: boolean, skipped?: boolean }}
   */
  generateCommentPlan({ pr, comment, classification, aiAnalysis = null }) {
    const prDir = join(this.outputDir, `PR-${pr.number}`);
    if (!existsSync(prDir)) {
      mkdirSync(prDir, { recursive: true });
    }

    const fileName = `comment-${comment.id}.md`;
    const filePath = join(prDir, fileName);
    const isNew = !existsSync(filePath);

    if (!isNew) {
      return { filePath, isNew: false, skipped: true };
    }

    let content = this._buildPRHeader(pr);
    content += this._buildCommentSection(comment, classification, aiAnalysis);

    writeFileSync(filePath, content, 'utf-8');

    return { filePath, isNew };
  }

  /**
   * Generate or append CI failure section to a PR plan file.
   *
   * @param {Object} options
   * @param {Object} options.pr - PR metadata
   * @param {Object} options.ciReport - From CILogParser
   * @returns {{ filePath: string, isNew: boolean }}
   */
  generateCIPlan({ pr, ciReport }) {
    const prDir = join(this.outputDir, `PR-${pr.number}`);
    if (!existsSync(prDir)) {
      mkdirSync(prDir, { recursive: true });
    }

    const fileName = `ci-${ciReport.runId}.md`;
    const filePath = join(prDir, fileName);
    const isNew = !existsSync(filePath);

    if (!isNew) {
      return { filePath, isNew: false, skipped: true };
    }

    let content = this._buildPRHeader(pr);
    content += this._buildCISection(ciReport);

    writeFileSync(filePath, content, 'utf-8');

    return { filePath, isNew };
  }

  /**
   * List all existing plan files.
   * @returns {Array<{ fileName, filePath, prNumber }>}
   */
  listPlans() {
    if (!existsSync(this.outputDir)) return [];
    
    let allPlans = [];
    const dirs = readdirSync(this.outputDir, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory() && dirent.name.startsWith('PR-'));
      
    for (const dir of dirs) {
      const prNumber = parseInt(dir.name.replace('PR-', ''), 10);
      const prDirPath = join(this.outputDir, dir.name);
      const files = readdirSync(prDirPath).filter(f => f.endsWith('.md'));
      
      for (const f of files) {
        const fullPath = join(prDirPath, f);
        const stat = statSync(fullPath);
        allPlans.push({
          fileName: f,
          filePath: fullPath,
          prNumber,
          lastModified: stat.mtime
        });
      }
    }
    
    return allPlans.sort((a, b) => b.lastModified - a.lastModified);
  }

  // ── Private: Build Markdown Sections ────────────────────────────

  _buildPRHeader(pr) {
    const now = new Date().toISOString();
    return [
      `# 📋 PR #${pr.number} — ${pr.title}`,
      '',
      `| Field | Value |`,
      `|-------|-------|`,
      `| **Repo** | ${pr.repo.full_name} |`,
      `| **Branch** | \`${pr.head_ref}\` |`,
      `| **PR Link** | [#${pr.number}](${pr.html_url}) |`,
      `| **Plan Created** | ${now} |`,
      '',
      '---',
      '',
    ].join('\n');
  }

  _buildCommentSection(comment, classification, aiAnalysis) {
    const timestamp = new Date(comment.created_at).toLocaleString();
    const categoryEmoji = this._getCategoryEmoji(classification.category);

    const lines = [
      `<!-- comment-id: ${comment.id} -->`,
      `## ${categoryEmoji} ${classification.label}`,
      '',
      `**By**: @${comment.author} · **At**: ${timestamp} · **Confidence**: ${(classification.confidence * 100).toFixed(0)}%`,
      '',
    ];

    // Link to original comment
    if (comment.html_url) {
      lines.push(`🔗 [View Comment](${comment.html_url})`);
      lines.push('');
    }

    // Original comment body
    lines.push('### 💬 Original Comment');
    lines.push('');
    lines.push(...comment.body.split('\n').map(l => `> ${l}`));
    lines.push('');

    // File context (for inline review comments)
    if (comment.path) {
      lines.push('### 📄 File Context');
      lines.push('');
      lines.push(`**File**: \`${comment.path}\`${comment.line ? ` (line ${comment.line})` : ''}`);
      lines.push('');

      if (comment.diff_hunk) {
        lines.push('```diff');
        lines.push(comment.diff_hunk);
        lines.push('```');
        lines.push('');
      }
    }

    if (aiAnalysis) {
      lines.push('### 🧠 AI Context Analysis');
      lines.push('');
      lines.push(aiAnalysis);
      lines.push('');
    } else {
      // Fallback to static analysis
      lines.push('### 🔍 Initial Analysis');
      lines.push('');
      if (classification.category === 'spec_missing') {
        lines.push('- Reviewer has identified missing test coverage');
      } else if (classification.category === 'logic_change') {
        lines.push('- Reviewer has requested a logic change or architectural rethink');
      } else if (classification.category === 'bug_report') {
        lines.push('- Reviewer has identified a bug or regression');
      } else if (classification.category === 'question') {
        lines.push('- Reviewer has asked a question');
      }
      lines.push(`- Matched keywords: ${classification.matchedKeywords.join(', ') || 'None'}`);
      if (!comment.path) lines.push('- No specific file referenced in comment');
      lines.push(`- **Priority**: ${classification.priority === 3 ? 'High — fix immediately' : classification.priority === 2 ? 'Medium — fix before merge' : 'Low'}`);
      lines.push('');

      // Generate action items based on category
      lines.push('### ✅ Action Items');
      lines.push('');
      if (classification.category === 'spec_missing') {
        lines.push('- [ ] Identify the untested code paths');
        lines.push('- [ ] Write unit tests for the identified functions');
        lines.push('- [ ] Run tests locally to verify coverage');
        lines.push('- [ ] Push the test updates to the PR branch');
      } else if (classification.category === 'logic_change') {
        lines.push('- [ ] Review the requested logic change');
        lines.push('- [ ] Implement the new approach');
        lines.push('- [ ] Verify the change does not break existing tests');
      } else if (classification.category === 'bug_report') {
        lines.push('- [ ] Reproduce the reported bug locally');
        lines.push('- [ ] Write a failing test case (TDD)');
        lines.push('- [ ] Fix the bug');
        lines.push('- [ ] Verify the test passes');
      } else {
        lines.push('- [ ] Read the reviewer question');
        lines.push('- [ ] Formulate a response or investigate the codebase');
        lines.push('- [ ] Reply to the reviewer on GitHub');
      }
      lines.push('');
    }

    // End of generated plan

    lines.push('---');
    lines.push('');

    return lines.join('\n');
  }

  _buildCISection(ciReport) {
    const lines = [
      `<!-- ci-run-id: ${ciReport.runId} -->`,
      `## 🔴 CI Failure: ${ciReport.workflowName}`,
      '',
      `**Conclusion**: \`${ciReport.conclusion}\` · **Run ID**: ${ciReport.runId}`,
      '',
    ];

    // Summary
    if (ciReport.summary) {
      lines.push(`**Summary**: ${ciReport.summary}`);
      lines.push('');
    }

    // Failed steps
    if (ciReport.failedSteps.length > 0) {
      lines.push('### ❌ Failed Steps');
      lines.push('');
      for (const step of ciReport.failedSteps) {
        lines.push(`- \`${step}\``);
      }
      lines.push('');
    }

    // Lint violations
    if (ciReport.lintViolations.length > 0) {
      lines.push('### 🧹 Lint Violations');
      lines.push('');
      lines.push('| File | Line | Severity | Rule | Message |');
      lines.push('|------|------|----------|------|---------|');
      for (const v of ciReport.lintViolations.slice(0, 30)) {
        lines.push(`| \`${v.file}\` | ${v.line} | ${v.severity} | \`${v.rule}\` | ${v.message} |`);
      }
      if (ciReport.lintViolations.length > 30) {
        lines.push(`| ... | ... | ... | ... | _${ciReport.lintViolations.length - 30} more violations_ |`);
      }
      lines.push('');
    }

    // Test failures
    if (ciReport.testFailures.length > 0) {
      lines.push('### 🧪 Test Failures');
      lines.push('');
      for (const suite of ciReport.testFailures) {
        lines.push(`#### \`${suite.file}\``);
        for (const detail of suite.details) {
          lines.push(`- ${detail}`);
        }
        lines.push('');
      }
    }

    // Raw errors
    if (ciReport.errors.length > 0) {
      lines.push('### 💥 Errors');
      lines.push('');
      for (const err of ciReport.errors.slice(0, 10)) {
        lines.push(`**${err.step || err.type}**:`);
        lines.push('```');
        lines.push(err.message);
        lines.push('```');
        lines.push('');
      }
    }

    // Action items for CI
    lines.push('### ✅ Action Items');
    lines.push('');
    lines.push(...this._generateCIActionItems(ciReport));
    lines.push('');

    lines.push('---');
    lines.push('');

    return lines.join('\n');
  }

  _getCategoryEmoji(category) {
    const map = {
      spec_missing: '🧪',
      logic_change: '🔧',
      bug_report: '🐛',
      question: '❓',
      ci_failure: '🔴',
    };
    return map[category] || '📝';
  }

  _generateInitialAnalysis(comment, classification) {
    switch (classification.category) {
      case 'spec_missing':
        return [
          '- Reviewer has identified missing test coverage',
          `- Matched keywords: ${classification.matchedKeywords.slice(0, 5).join(', ')}`,
          comment.path ? `- Affected file: \`${comment.path}\`` : '- No specific file referenced in comment',
          '- **Priority**: Medium — tests should be added before merge',
        ].join('\n');

      case 'logic_change':
        return [
          '- Reviewer is requesting a change to the implementation approach',
          `- Matched keywords: ${classification.matchedKeywords.slice(0, 5).join(', ')}`,
          comment.path ? `- Affected file: \`${comment.path}\`` : '- Review the PR diff for context',
          '- **Priority**: High — logic changes block merge approval',
        ].join('\n');

      case 'bug_report':
        return [
          '- Reviewer has identified a potential bug or regression',
          `- Matched keywords: ${classification.matchedKeywords.slice(0, 5).join(', ')}`,
          comment.path ? `- Affected file: \`${comment.path}\`` : '- Investigate the reported behavior',
          '- **Priority**: High — bugs must be addressed before merge',
        ].join('\n');

      case 'question':
        return [
          '- Reviewer is asking a question — may not require code changes',
          '- Consider replying with an explanation or adding a code comment',
          '- **Priority**: Low — clarification may unblock approval',
        ].join('\n');

      default:
        return '- Review the comment and determine next steps';
    }
  }

  _generateActionItems(classification) {
    switch (classification.category) {
      case 'spec_missing':
        return [
          '- [ ] Identify the untested code paths',
          '- [ ] Write unit tests for the identified functions',
          '- [ ] Run tests locally to verify coverage',
          '- [ ] Push the test updates to the PR branch',
        ];

      case 'logic_change':
        return [
          '- [ ] Understand the reviewer\'s suggested approach',
          '- [ ] Evaluate if the change is necessary or if current approach is valid',
          '- [ ] Implement the logic change if agreed',
          '- [ ] Update any affected tests',
          '- [ ] Reply to the reviewer with the changes made',
        ];

      case 'bug_report':
        return [
          '- [ ] Reproduce the reported bug locally',
          '- [ ] Identify the root cause',
          '- [ ] Implement the fix',
          '- [ ] Add a regression test',
          '- [ ] Push the fix to the PR branch',
        ];

      case 'question':
        return [
          '- [ ] Draft a reply to the reviewer\'s question',
          '- [ ] Consider adding a code comment for clarity',
        ];

      default:
        return ['- [ ] Review and determine next steps'];
    }
  }

  _generateCIActionItems(ciReport) {
    const items = [];

    if (ciReport.lintViolations.length > 0) {
      items.push('- [ ] Fix lint violations (run linter locally first)');
    }
    if (ciReport.testFailures.length > 0) {
      items.push('- [ ] Fix failing test suites');
      for (const suite of ciReport.testFailures.slice(0, 5)) {
        items.push(`  - [ ] Fix \`${suite.file}\``);
      }
    }
    if (ciReport.errors.length > 0) {
      items.push('- [ ] Investigate and fix CI errors');
    }
    if (items.length === 0) {
      items.push('- [ ] Review CI logs for more details');
    }

    return items;
  }

}
