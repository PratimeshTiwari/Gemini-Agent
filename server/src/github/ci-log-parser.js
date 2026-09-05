/**
 * CI Log Parser
 *
 * Parses GitHub Actions workflow run logs to extract actionable
 * failure information: failed steps, error messages, lint violations,
 * and test failures.
 */

export class CILogParser {
  /**
   * Parse raw CI log text into a structured failure report.
   *
   * @param {Object} options
   * @param {string} options.logText - Raw log output from GitHub Actions
   * @param {string} options.workflowName - Name of the workflow
   * @param {string} options.runId - GitHub Actions run ID
   * @param {string} options.conclusion - 'failure', 'cancelled', etc.
   * @returns {Object} Structured failure report
   */
  parse({ logText, workflowName, runId, conclusion }) {
    const lines = logText.split('\n');

    const report = {
      workflowName,
      runId,
      conclusion,
      failedSteps: [],
      errors: [],
      lintViolations: [],
      testFailures: [],
      summary: '',
    };

    let currentStep = null;
    let inErrorBlock = false;
    let errorBuffer = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Detect step boundaries (GitHub Actions format)
      const stepMatch = trimmed.match(/^##\[group\](.*)/);
      if (stepMatch) {
        if (currentStep && inErrorBlock) {
          this._flushErrorBuffer(report, currentStep, errorBuffer);
          errorBuffer = [];
          inErrorBlock = false;
        }
        currentStep = stepMatch[1].trim();
        continue;
      }

      // Detect step failures
      if (trimmed.includes('##[error]') || trimmed.includes('Process completed with exit code')) {
        if (currentStep && !report.failedSteps.includes(currentStep)) {
          report.failedSteps.push(currentStep);
        }
        inErrorBlock = true;
      }

      // Collect error lines
      if (inErrorBlock) {
        const errorLine = trimmed.replace(/^##\[error\]/, '').trim();
        if (errorLine.length > 0) {
          errorBuffer.push(errorLine);
        }
      }

      // ── Lint Violations ────────────────────────────────────────
      // ESLint format: "path/file.js:10:5: error description (rule-name)"
      const eslintMatch = trimmed.match(/^(.+?):(\d+):(\d+):\s+(error|warning)\s+(.+?)\s+\((.+?)\)$/);
      if (eslintMatch) {
        report.lintViolations.push({
          file: eslintMatch[1],
          line: parseInt(eslintMatch[2]),
          column: parseInt(eslintMatch[3]),
          severity: eslintMatch[4],
          message: eslintMatch[5],
          rule: eslintMatch[6],
        });
        continue;
      }

      // Prettier format: "Checking file.js ... error"
      const prettierMatch = trimmed.match(/^(?:Checking\s+)?(.+?)\s*\.\.\.\s*(error|failed)/i);
      if (prettierMatch) {
        report.lintViolations.push({
          file: prettierMatch[1],
          line: 0,
          column: 0,
          severity: 'error',
          message: 'Formatting error',
          rule: 'prettier',
        });
        continue;
      }

      // ── Test Failures ──────────────────────────────────────────
      // Jest/Vitest: "FAIL src/some.test.js"
      const jestFailMatch = trimmed.match(/^(?:FAIL)\s+(.+\.(?:test|spec)\.\w+)/);
      if (jestFailMatch) {
        report.testFailures.push({
          file: jestFailMatch[1],
          type: 'test_suite_failure',
          details: [],
        });
        continue;
      }

      // Jest assertion: "● Test Suite › test name"
      const jestAssertMatch = trimmed.match(/^●\s+(.+)/);
      if (jestAssertMatch && report.testFailures.length > 0) {
        const lastSuite = report.testFailures[report.testFailures.length - 1];
        lastSuite.details.push(jestAssertMatch[1]);
        continue;
      }

      // Generic test failure: "FAILED" or "AssertionError"
      if (/AssertionError|AssertionFailed|assert\.fail/i.test(trimmed)) {
        report.errors.push({
          type: 'assertion_error',
          message: trimmed,
          context: this._getContext(lines, i, 3),
        });
      }

      // Stack traces
      if (/^\s+at\s+/.test(line) && report.errors.length > 0) {
        const lastError = report.errors[report.errors.length - 1];
        if (!lastError.stackTrace) lastError.stackTrace = [];
        lastError.stackTrace.push(trimmed);
      }
    }

    // Flush any remaining error buffer
    if (currentStep && errorBuffer.length > 0) {
      this._flushErrorBuffer(report, currentStep, errorBuffer);
    }

    // Generate summary
    report.summary = this._buildSummary(report);

    return report;
  }

  /**
   * Parse a compact CI failure (without full logs, just the run metadata).
   * Used when log download fails or is too large.
   */
  parseCompact({ workflowName, runId, conclusion, failedJobs }) {
    return {
      workflowName,
      runId,
      conclusion,
      failedSteps: failedJobs || [],
      errors: [],
      lintViolations: [],
      testFailures: [],
      summary: `Workflow "${workflowName}" (run #${runId}) ${conclusion}. Failed jobs: ${(failedJobs || []).join(', ') || 'unknown'}`,
    };
  }

  _flushErrorBuffer(report, step, buffer) {
    if (buffer.length === 0) return;
    report.errors.push({
      step,
      type: 'step_error',
      message: buffer.slice(0, 20).join('\n'),
      fullOutput: buffer.join('\n'),
    });
  }

  _getContext(lines, index, radius) {
    const start = Math.max(0, index - radius);
    const end = Math.min(lines.length, index + radius + 1);
    return lines.slice(start, end).map(l => l.trim()).join('\n');
  }

  _buildSummary(report) {
    const parts = [];

    if (report.failedSteps.length > 0) {
      parts.push(`**Failed Steps**: ${report.failedSteps.join(', ')}`);
    }
    if (report.lintViolations.length > 0) {
      parts.push(`**Lint Violations**: ${report.lintViolations.length} issues`);
    }
    if (report.testFailures.length > 0) {
      parts.push(`**Test Failures**: ${report.testFailures.length} suites failed`);
    }
    if (report.errors.length > 0) {
      parts.push(`**Errors**: ${report.errors.length} errors captured`);
    }

    return parts.join(' | ') || 'No specific failures parsed';
  }
}
