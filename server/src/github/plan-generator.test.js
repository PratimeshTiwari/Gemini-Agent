/**
 * PlanGenerator — Unit Tests
 *
 * Plans are one file per item under <outputDir>/PR-<n>/, not one file per PR.
 * That layout is what lets github-event-handler skip a comment it has already
 * planned (`if (result.skipped) return;`) instead of re-running the AI on it.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync, rmSync, readFileSync, mkdirSync } from 'fs';
import { resolve, join } from 'path';
import { PlanGenerator } from './plan-generator.js';

const TEST_WORKSPACE = resolve(import.meta.dirname, '../../.test-workspace');
const PLAN_DIR = '.agent/github-pr-plans';
const planPath = (...parts) => resolve(TEST_WORKSPACE, PLAN_DIR, ...parts);

describe('PlanGenerator', () => {
  let generator;

  beforeEach(() => {
    if (existsSync(TEST_WORKSPACE)) {
      rmSync(TEST_WORKSPACE, { recursive: true });
    }
    mkdirSync(TEST_WORKSPACE, { recursive: true });
    generator = new PlanGenerator(TEST_WORKSPACE, PLAN_DIR);
  });

  afterEach(() => {
    if (existsSync(TEST_WORKSPACE)) {
      rmSync(TEST_WORKSPACE, { recursive: true });
    }
  });

  const mockPR = {
    number: 42,
    title: 'Add authentication middleware',
    html_url: 'https://github.com/user/repo/pull/42',
    head_ref: 'feat/auth-middleware',
    repo: {
      owner: 'user',
      name: 'repo',
      full_name: 'user/repo',
    },
  };

  const mockComment = {
    id: 12345,
    body: 'Tests are missing for the auth middleware. Please add unit tests.',
    author: 'reviewer-jane',
    created_at: '2026-08-28T00:00:00Z',
    html_url: 'https://github.com/user/repo/pull/42#issuecomment-12345',
    type: 'issue_comment',
  };

  const mockClassification = {
    category: 'requires_review',
    label: 'Requires AI Review',
    confidence: 1.0,
    matchedKeywords: [],
  };

  const generate = (overrides = {}) => generator.generateCommentPlan({
    pr: mockPR,
    comment: mockComment,
    classification: mockClassification,
    ...overrides,
  });

  describe('generateCommentPlan', () => {
    it('creates a file named after the comment, under the PR directory', () => {
      const result = generate();

      assert.ok(result.isNew);
      assert.ok(existsSync(result.filePath));
      assert.strictEqual(result.filePath, planPath('PR-42', 'comment-12345.md'));
    });

    it('includes the PR header', () => {
      const content = readFileSync(generate().filePath, 'utf-8');
      assert.ok(content.includes('PR #42'));
      assert.ok(content.includes('Add authentication middleware'));
      assert.ok(content.includes('user/repo'));
      assert.ok(content.includes('feat/auth-middleware'));
    });

    it('includes the comment details', () => {
      const content = readFileSync(generate().filePath, 'utf-8');
      assert.ok(content.includes('Requires AI Review'));
      assert.ok(content.includes('@reviewer-jane'));
      assert.ok(content.includes('Tests are missing for the auth middleware'));
    });

    it('includes action items', () => {
      const content = readFileSync(generate().filePath, 'utf-8');
      assert.ok(content.includes('Action Items'));
      assert.ok(content.includes('- [ ]'));
    });

    it('omits the priority line the classifier does not set', () => {
      const content = readFileSync(generate().filePath, 'utf-8');
      assert.ok(!content.includes('**Priority**'));
    });

    it('keeps the priority line when a classification carries one', () => {
      const content = readFileSync(
        generate({ classification: { ...mockClassification, priority: 3 } }).filePath,
        'utf-8',
      );
      assert.ok(content.includes('**Priority**: High — fix immediately'));
    });

    it('prefers the AI analysis over the static fallback', () => {
      const content = readFileSync(generate({ aiAnalysis: 'The token check is unreachable.' }).filePath, 'utf-8');
      assert.ok(content.includes('AI Context Analysis'));
      assert.ok(content.includes('The token check is unreachable.'));
      assert.ok(!content.includes('Initial Analysis'));
    });

    it('gives a second comment on the same PR its own file', () => {
      const first = generate();
      const second = generate({
        comment: { ...mockComment, id: 12346, body: 'The logic here is wrong.', author: 'reviewer-bob' },
      });

      assert.ok(second.isNew);
      assert.notStrictEqual(second.filePath, first.filePath);
      assert.strictEqual(second.filePath, planPath('PR-42', 'comment-12346.md'));
      assert.ok(readFileSync(first.filePath, 'utf-8').includes('@reviewer-jane'));
      assert.ok(readFileSync(second.filePath, 'utf-8').includes('@reviewer-bob'));
    });

    it('skips a comment it has already planned, leaving the file untouched', () => {
      const before = readFileSync(generate().filePath, 'utf-8');

      // Same comment id, different body: a re-poll must not re-run the AI.
      const again = generate({ comment: { ...mockComment, body: 'edited since' } });

      assert.strictEqual(again.isNew, false);
      assert.strictEqual(again.skipped, true);
      assert.strictEqual(readFileSync(again.filePath, 'utf-8'), before);
    });

    it('records file context for an inline review comment', () => {
      const content = readFileSync(generate({
        comment: {
          ...mockComment,
          type: 'review_comment',
          path: 'src/middleware/auth.js',
          line: 45,
          diff_hunk: '+ function validateToken(token) {\n+   return token.length > 0;\n+ }',
        },
      }).filePath, 'utf-8');

      assert.ok(content.includes('src/middleware/auth.js'));
      assert.ok(content.includes('line 45'));
      assert.ok(content.includes('```diff'));
    });
  });

  describe('generateCIPlan', () => {
    const ciReport = {
      workflowName: 'CI Tests',
      runId: 98765,
      conclusion: 'failure',
      failedSteps: ['Run tests'],
      errors: [{ step: 'Run tests', type: 'step_error', message: 'Jest exited with code 1' }],
      lintViolations: [],
      testFailures: [{ file: 'src/auth.test.js', type: 'test_suite_failure', details: ['validateToken › should reject empty tokens'] }],
      summary: '**Failed Steps**: Run tests | **Test Failures**: 1 suites failed',
    };

    it('creates a file named after the run, under the PR directory', () => {
      const result = generator.generateCIPlan({ pr: mockPR, ciReport });

      assert.ok(existsSync(result.filePath));
      assert.strictEqual(result.filePath, planPath('PR-42', 'ci-98765.md'));

      const content = readFileSync(result.filePath, 'utf-8');
      assert.ok(content.includes('CI Failure'));
      assert.ok(content.includes('CI Tests'));
      assert.ok(content.includes('src/auth.test.js'));
    });

    it('skips a run it has already planned', () => {
      generator.generateCIPlan({ pr: mockPR, ciReport });
      const again = generator.generateCIPlan({ pr: mockPR, ciReport });

      assert.strictEqual(again.isNew, false);
      assert.strictEqual(again.skipped, true);
    });
  });

  describe('listPlans', () => {
    it('lists one entry per plan file, with its PR number', () => {
      generate();
      generate({ comment: { ...mockComment, id: 12346 } });

      const plans = generator.listPlans();

      assert.strictEqual(plans.length, 2);
      assert.deepStrictEqual([...new Set(plans.map(p => p.prNumber))], [42]);
      assert.deepStrictEqual(
        plans.map(p => p.fileName).sort(),
        ['comment-12345.md', 'comment-12346.md'],
      );
      assert.ok(plans.every(p => existsSync(p.filePath)));
    });

    it('spans several PRs', () => {
      generate();
      generator.generateCommentPlan({
        pr: { ...mockPR, number: 7 },
        comment: { ...mockComment, id: 999 },
        classification: mockClassification,
      });

      const plans = generator.listPlans();
      assert.deepStrictEqual(plans.map(p => p.prNumber).sort((a, b) => a - b), [7, 42]);
    });

    it('returns an empty array when no plans exist', () => {
      assert.deepStrictEqual(generator.listPlans(), []);
    });
  });
});
