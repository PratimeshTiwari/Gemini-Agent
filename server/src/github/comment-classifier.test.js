/**
 * CommentClassifier — Unit Tests
 *
 * The classifier is a gate, not a categoriser: it decides whether a comment is
 * worth an AI review turn. Anything that is not demonstrably noise gets one.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { CommentClassifier } from './comment-classifier.js';

const classifier = new CommentClassifier();
const classify = (body, ignoreAuthors = [], avoidWords = [], author = 'reviewer') =>
  classifier.classify({ body, author }, ignoreAuthors, avoidWords);

describe('CommentClassifier', () => {
  describe('requires_review', () => {
    it('sends an ordinary review comment to the AI', () => {
      const result = classify('This logic needs to change to handle edge cases');
      assert.strictEqual(result.category, 'requires_review');
      assert.strictEqual(result.label, 'Requires AI Review');
      assert.strictEqual(result.confidence, 1.0);
    });

    it('sends a question to the AI', () => {
      assert.strictEqual(classify('Why did you choose this approach?').category, 'requires_review');
    });

    it('does not categorise beyond the gate — that is the AI\'s job now', () => {
      const specs = classify('Specs are missing for this function');
      const bug = classify('This is broken in production');
      assert.strictEqual(specs.category, 'requires_review');
      assert.strictEqual(bug.category, 'requires_review');
      assert.deepStrictEqual(specs.matchedKeywords, []);
    });
  });

  describe('noise', () => {
    it('skips ignored authors before looking at the body', () => {
      const result = classify('Auto-update dependency', ['dependabot[bot]'], [], 'dependabot[bot]');
      assert.strictEqual(result.category, 'noise');
      assert.strictEqual(result.label, 'Bot/Ignored Author');
    });

    it('skips an empty body', () => {
      const result = classify('');
      assert.strictEqual(result.category, 'noise');
      assert.strictEqual(result.label, 'Empty');
    });

    it('skips a whitespace-only body', () => {
      assert.strictEqual(classify('   \n  ').label, 'Empty');
    });

    it('skips a configured avoid word and reports which one matched', () => {
      const result = classify('LGTM', [], ['lgtm']);
      assert.strictEqual(result.category, 'noise');
      assert.strictEqual(result.label, 'Avoid Word Match');
      assert.deepStrictEqual(result.matchedKeywords, ['lgtm']);
    });

    it('matches an avoid word case-insensitively and next to punctuation', () => {
      assert.strictEqual(classify('LGTM!', [], ['lgtm']).category, 'noise');
      assert.strictEqual(classify('lgtm, ship it', [], ['LGTM']).category, 'noise');
    });

    it('matches a multi-word avoid phrase inside a sentence', () => {
      assert.strictEqual(classify('ship it now', [], ['ship it']).category, 'noise');
    });

    it('does not match an avoid word inside a longer word', () => {
      // The whole point of the boundary: "nit" must not silence "infinite loop".
      assert.strictEqual(classify('infinite loop here', [], ['nit']).category, 'requires_review');
      assert.strictEqual(classify('unittest coverage', [], ['test']).category, 'requires_review');
    });

    it('ignores regex metacharacters in an avoid word', () => {
      assert.strictEqual(classify('looks good (+1)', [], ['+1']).category, 'noise');
      assert.strictEqual(classify('anything at all', [], ['.*']).category, 'requires_review');
    });
  });

  describe('classifyBatch', () => {
    it('drops noise, keeps order, and attaches the classification', () => {
      const comments = [
        { body: 'LGTM', author: 'reviewer1' },
        { body: 'Tests are missing here', author: 'reviewer2' },
        { body: '', author: 'reviewer3' },
        { body: 'This logic needs change', author: 'reviewer4' },
        { body: 'beep boop', author: 'dependabot[bot]' },
      ];

      const results = classifier.classifyBatch(comments, ['dependabot[bot]'], ['lgtm']);

      assert.strictEqual(results.length, 2);
      assert.deepStrictEqual(results.map(c => c.author), ['reviewer2', 'reviewer4']);
      assert.strictEqual(results[0].classification.category, 'requires_review');
      assert.strictEqual(results[0].body, 'Tests are missing here');
    });

    it('returns everything when nothing is configured as noise', () => {
      const comments = [{ body: 'a', author: 'x' }, { body: 'b', author: 'y' }];
      assert.strictEqual(classifier.classifyBatch(comments).length, 2);
    });
  });
});
