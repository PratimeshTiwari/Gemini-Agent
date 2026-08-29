/**
 * CommentClassifier — Unit Tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { CommentClassifier } from './CommentClassifier.js';

const classifier = new CommentClassifier();

describe('CommentClassifier', () => {

  describe('spec_missing', () => {
    it('should classify "specs are missing" as spec_missing', () => {
      const result = classifier.classify({ body: 'Specs are missing for this function', author: 'reviewer' });
      assert.strictEqual(result.category, 'spec_missing');
    });

    it('should classify "add tests" as spec_missing', () => {
      const result = classifier.classify({ body: 'Can you add tests for this module?', author: 'reviewer' });
      assert.strictEqual(result.category, 'spec_missing');
    });

    it('should classify "no test coverage" as spec_missing', () => {
      const result = classifier.classify({ body: 'This function has no test coverage at all', author: 'reviewer' });
      assert.strictEqual(result.category, 'spec_missing');
    });

    it('should classify "needs testing" as spec_missing', () => {
      const result = classifier.classify({ body: 'This needs more testing before we can merge', author: 'reviewer' });
      assert.strictEqual(result.category, 'spec_missing');
    });
  });

  describe('logic_change', () => {
    it('should classify "this logic needs change" as logic_change', () => {
      const result = classifier.classify({ body: 'This logic needs to change to handle edge cases', author: 'reviewer' });
      assert.strictEqual(result.category, 'logic_change');
    });

    it('should classify "wrong approach" as logic_change', () => {
      const result = classifier.classify({ body: 'This is the wrong approach, we should use a different pattern', author: 'reviewer' });
      assert.strictEqual(result.category, 'logic_change');
    });

    it('should classify "should be using X instead of Y" as logic_change', () => {
      const result = classifier.classify({ body: 'You should be using a Map instead of an object here', author: 'reviewer' });
      assert.strictEqual(result.category, 'logic_change');
    });

    it('should classify "refactor this" as logic_change', () => {
      const result = classifier.classify({ body: 'Please refactor this code to simplify the logic', author: 'reviewer' });
      assert.strictEqual(result.category, 'logic_change');
    });
  });

  describe('bug_report', () => {
    it('should classify "this is broken" as bug_report', () => {
      const result = classifier.classify({ body: 'This is broken in production', author: 'reviewer' });
      assert.strictEqual(result.category, 'bug_report');
    });

    it('should classify "doesn\'t work" as bug_report', () => {
      const result = classifier.classify({ body: 'The authentication doesn\'t work after this change', author: 'reviewer' });
      assert.strictEqual(result.category, 'bug_report');
    });

    it('should classify "causes a regression" as bug_report', () => {
      const result = classifier.classify({ body: 'This change causes a regression in the payment flow', author: 'reviewer' });
      assert.strictEqual(result.category, 'bug_report');
    });
  });

  describe('question', () => {
    it('should classify questions ending with "?" as question', () => {
      const result = classifier.classify({ body: 'Why did you choose this approach?', author: 'reviewer' });
      assert.strictEqual(result.category, 'question');
    });

    it('should classify "how does this work" as question', () => {
      const result = classifier.classify({ body: 'How does this handle concurrent requests?', author: 'reviewer' });
      assert.strictEqual(result.category, 'question');
    });
  });

  describe('noise', () => {
    it('should classify "LGTM" as noise', () => {
      const result = classifier.classify({ body: 'LGTM', author: 'reviewer' });
      assert.strictEqual(result.category, 'noise');
    });

    it('should classify "+1" as noise', () => {
      const result = classifier.classify({ body: '+1', author: 'reviewer' });
      assert.strictEqual(result.category, 'noise');
    });

    it('should classify "👍" as noise', () => {
      const result = classifier.classify({ body: '👍', author: 'reviewer' });
      assert.strictEqual(result.category, 'noise');
    });

    it('should classify empty body as noise', () => {
      const result = classifier.classify({ body: '', author: 'reviewer' });
      assert.strictEqual(result.category, 'noise');
    });
  });

  describe('bot filtering', () => {
    it('should classify bot comments as noise', () => {
      const result = classifier.classify(
        { body: 'Auto-update dependency', author: 'dependabot[bot]' },
        ['dependabot[bot]']
      );
      assert.strictEqual(result.category, 'noise');
      assert.strictEqual(result.label, 'Bot/Ignored Author');
    });
  });

  describe('classifyBatch', () => {
    it('should filter out noise and return only actionable comments', () => {
      const comments = [
        { body: 'LGTM', author: 'reviewer1' },
        { body: 'Tests are missing here', author: 'reviewer2' },
        { body: 'This logic needs change', author: 'reviewer3' },
        { body: '👍', author: 'reviewer4' },
      ];

      const results = classifier.classifyBatch(comments);
      assert.strictEqual(results.length, 2);
      assert.strictEqual(results[0].classification.category, 'spec_missing');
      assert.strictEqual(results[1].classification.category, 'logic_change');
    });
  });

  describe('confidence', () => {
    it('should have higher confidence for multiple keyword matches', () => {
      const low = classifier.classify({ body: 'test', author: 'reviewer' });
      const high = classifier.classify({ body: 'add unit tests for better test coverage, needs testing', author: 'reviewer' });

      assert.ok(high.confidence >= low.confidence);
    });
  });
});
