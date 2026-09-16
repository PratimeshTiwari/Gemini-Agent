import { test, describe } from 'node:test';
import assert from 'node:assert';
import { normalizeQuestion, normalizeQuestionSet, MAX_QUESTIONS, FREEFORM_VALUE } from '../../src/ui/question.js';

describe('normalizeQuestion', () => {
  test('plain strings become options', () => {
    const q = normalizeQuestion({ question: 'Which parser?', options: ['acorn', 'babel'] });
    assert.strictEqual(q.question, 'Which parser?');
    assert.deepStrictEqual(q.options.map(o => o.label), ['acorn', 'babel']);
    assert.deepStrictEqual(q.options.map(o => o.value), ['acorn', 'babel']);
  });

  test('objects carry their description through', () => {
    const q = normalizeQuestion({
      question: 'Which?',
      options: [{ label: 'Stream it', description: 'Lower memory, more code' }],
    });
    assert.strictEqual(q.options[0].label, 'Stream it');
    assert.strictEqual(q.options[0].description, 'Lower memory, more code');
  });

  test('a header is defaulted and long ones are clipped', () => {
    assert.strictEqual(normalizeQuestion({ question: 'x' }).header, 'Question');
    assert.strictEqual(normalizeQuestion({ question: 'x', header: 'Parser' }).header, 'Parser');
    const long = normalizeQuestion({ question: 'x', header: 'A'.repeat(40) });
    assert.ok(long.header.length <= 24, long.header);
    assert.ok(long.header.endsWith('…'));
  });

  // The payload is parsed out of model output, so none of these are hypothetical.
  describe('malformed payloads still produce a usable prompt', () => {
    test('a single string instead of an array', () => {
      const q = normalizeQuestion({ question: 'x', options: 'only one' });
      assert.deepStrictEqual(q.options.map(o => o.label), ['only one']);
    });

    test('no options at all leaves the free-text path', () => {
      const q = normalizeQuestion({ question: 'x' });
      assert.deepStrictEqual(q.options, []);
    });

    test('empty, blank and duplicate options are dropped', () => {
      const q = normalizeQuestion({ question: 'x', options: ['a', '', '  ', 'a', null, 'b'] });
      assert.deepStrictEqual(q.options.map(o => o.label), ['a', 'b']);
    });

    test('a missing question still says something', () => {
      assert.ok(normalizeQuestion({}).question.length > 0);
      assert.ok(normalizeQuestion().question.length > 0);
    });

    test('an unbounded option list is capped', () => {
      const q = normalizeQuestion({
        question: 'x',
        options: Array.from({ length: 50 }, (_, i) => `opt ${i}`),
      });
      assert.strictEqual(q.options.length, 8);
    });
  });

  test('the free-text sentinel cannot collide with a real answer', () => {
    const q = normalizeQuestion({ question: 'x', options: [FREEFORM_VALUE] });
    // It is accepted as a label, but the component compares on value identity
    // for the item it appends itself — so a model echoing the sentinel is inert.
    assert.strictEqual(q.options[0].value, FREEFORM_VALUE);
  });
});

describe('normalizeQuestionSet', () => {
  test('a batch comes back as one entry per question', () => {
    const set = normalizeQuestionSet({ questions: [
      { question: 'Where?', options: ['a', 'b'] },
      { question: 'How?', options: ['c'] },
    ]});
    assert.strictEqual(set.length, 2);
    assert.deepStrictEqual(set.map(q => q.question), ['Where?', 'How?']);
    assert.deepStrictEqual(set[0].options.map(o => o.label), ['a', 'b']);
  });

  test('a single-question payload still works, so nothing had to change to send one', () => {
    const set = normalizeQuestionSet({ question: 'Which?', options: ['a'] });
    assert.strictEqual(set.length, 1);
    assert.strictEqual(set[0].question, 'Which?');
  });

  test('the batch is capped rather than filling the screen', () => {
    const set = normalizeQuestionSet({
      questions: Array.from({ length: 12 }, (_, i) => ({ question: `q${i}`, options: ['a'] })),
    });
    assert.strictEqual(set.length, MAX_QUESTIONS);
  });

  test('bare strings in the array are treated as questions without options', () => {
    const set = normalizeQuestionSet({ questions: ['Just tell me?'] });
    assert.strictEqual(set[0].question, 'Just tell me?');
    assert.deepStrictEqual(set[0].options, []);
  });

  test('an empty or junk batch falls back to the single question, never to nothing', () => {
    for (const questions of [[], [null, undefined], 'not an array']) {
      const set = normalizeQuestionSet({ question: 'Fallback?', questions });
      assert.strictEqual(set.length, 1);
      assert.strictEqual(set[0].question, 'Fallback?');
    }
  });
});
