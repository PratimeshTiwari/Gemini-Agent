/**
 * PlanGenerator — Unit Tests
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync, rmSync, readFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { PlanGenerator } from './plan-generator.js';

const TEST_WORKSPACE = resolve(import.meta.dirname, '../../.test-workspace');
const PLAN_DIR = '.agent-github-plans';

describe('PlanGenerator', () => {
  let generator;

  beforeEach(() => {
    // Clean up test workspace
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
    category: 'spec_missing',
    label: 'Missing Specs / Tests',
    confidence: 0.85,
    matchedKeywords: ['tests', 'missing', 'unit test'],
  };

  describe('generateCommentPlan', () => {
    it('should create a new plan file for a PR', () => {
      const result = generator.generateCommentPlan({
        pr: mockPR,
        comment: mockComment,
        classification: mockClassification,
      });

      assert.ok(result.isNew);
      assert.ok(existsSync(result.filePath));
      assert.ok(result.filePath.endsWith('PR-42.md'));
    });

    it('should include PR header in new plan', () => {
      generator.generateCommentPlan({
        pr: mockPR,
        comment: mockComment,
        classification: mockClassification,
      });

      const content = readFileSync(resolve(TEST_WORKSPACE, PLAN_DIR, 'PR-42.md'), 'utf-8');
      assert.ok(content.includes('PR #42'));
      assert.ok(content.includes('Add authentication middleware'));
      assert.ok(content.includes('user/repo'));
      assert.ok(content.includes('feat/auth-middleware'));
    });

    it('should include comment details', () => {
      generator.generateCommentPlan({
        pr: mockPR,
        comment: mockComment,
        classification: mockClassification,
      });

      const content = readFileSync(resolve(TEST_WORKSPACE, PLAN_DIR, 'PR-42.md'), 'utf-8');
      assert.ok(content.includes('Missing Specs / Tests'));
      assert.ok(content.includes('@reviewer-jane'));
      assert.ok(content.includes('Tests are missing for the auth middleware'));
    });

    it('should include action items', () => {
      generator.generateCommentPlan({
        pr: mockPR,
        comment: mockComment,
        classification: mockClassification,
      });

      const content = readFileSync(resolve(TEST_WORKSPACE, PLAN_DIR, 'PR-42.md'), 'utf-8');
      assert.ok(content.includes('Action Items'));
      assert.ok(content.includes('- [ ]'));
    });

    it('should append to existing plan file', () => {
      // First comment
      generator.generateCommentPlan({
        pr: mockPR,
        comment: mockComment,
        classification: mockClassification,
      });

      // Second comment on the same PR
      const secondComment = {
        ...mockComment,
        id: 12346,
        body: 'The logic here is wrong, it should validate before calling the API.',
        author: 'reviewer-bob',
      };
      const secondClassification = {
        category: 'logic_change',
        label: 'Logic Change Requested',
        confidence: 0.9,
        matchedKeywords: ['logic', 'wrong'],
      };

      const result = generator.generateCommentPlan({
        pr: mockPR,
        comment: secondComment,
        classification: secondClassification,
      });

      assert.ok(!result.isNew); // Should NOT be new
      const content = readFileSync(result.filePath, 'utf-8');
      assert.ok(content.includes('Missing Specs / Tests'));
      assert.ok(content.includes('Logic Change Requested'));
      assert.ok(content.includes('@reviewer-jane'));
      assert.ok(content.includes('@reviewer-bob'));
    });

    it('should handle inline review comments with file context', () => {
      const inlineComment = {
        ...mockComment,
        type: 'review_comment',
        path: 'src/middleware/auth.js',
        line: 45,
        diff_hunk: '+ function validateToken(token) {\n+   return token.length > 0;\n+ }',
      };

      generator.generateCommentPlan({
        pr: mockPR,
        comment: inlineComment,
        classification: mockClassification,
      });

      const content = readFileSync(resolve(TEST_WORKSPACE, PLAN_DIR, 'PR-42.md'), 'utf-8');
      assert.ok(content.includes('src/middleware/auth.js'));
      assert.ok(content.includes('line 45'));
      assert.ok(content.includes('```diff'));
    });
  });

  describe('generateCIPlan', () => {
    it('should create a CI failure section', () => {
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

      const result = generator.generateCIPlan({ pr: mockPR, ciReport });

      assert.ok(existsSync(result.filePath));
      const content = readFileSync(result.filePath, 'utf-8');
      assert.ok(content.includes('CI Failure'));
      assert.ok(content.includes('CI Tests'));
      assert.ok(content.includes('src/auth.test.js'));
    });
  });

  describe('listPlans', () => {
    it('should list generated plan files', () => {
      generator.generateCommentPlan({
        pr: mockPR,
        comment: mockComment,
        classification: mockClassification,
      });

      const plans = generator.listPlans();
      assert.strictEqual(plans.length, 1);
      assert.strictEqual(plans[0].prNumber, 42);
      assert.strictEqual(plans[0].fileName, 'PR-42.md');
    });

    it('should return empty array when no plans exist', () => {
      const plans = generator.listPlans();
      assert.strictEqual(plans.length, 0);
    });
  });
});
