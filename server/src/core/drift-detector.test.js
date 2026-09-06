import { test, describe } from 'node:test';
import assert from 'node:assert';
import { looksLikeMultipleDrafts } from './drift-detector.js';

describe('looksLikeMultipleDrafts', () => {
  test('catches a reply offering two drafts', () => {
    assert.ok(looksLikeMultipleDrafts('Draft 1:\nfoo\n\nDraft 2:\nbar'));
    assert.ok(looksLikeMultipleDrafts('**Response A**\nfoo\n**Response B**\nbar'));
    assert.ok(looksLikeMultipleDrafts('Here are two versions.\nVersion 1: x\nVersion 2: y'));
  });

  test('is case- and punctuation-insensitive', () => {
    assert.ok(looksLikeMultipleDrafts('DRAFT #1 ... draft #2'));
    assert.ok(looksLikeMultipleDrafts('Alternative 1: a  Alternative 2: b'));
  });

  describe('does not fire on legitimate output', () => {
    // The pro tier's deep level explicitly asks for enumerated approaches, so
    // these words are expected output, not drift.
    test('enumerated approaches are what deep reasoning was told to produce', () => {
      assert.ok(!looksLikeMultipleDrafts('Approach 1: stream it. Approach 2: buffer it.'));
      assert.ok(!looksLikeMultipleDrafts('Option A: cap by age. Option B: cap by count.'));
    });

    test('a single mention is not a set of alternatives', () => {
      assert.ok(!looksLikeMultipleDrafts('My response: the bug is an off-by-one.'));
      assert.ok(!looksLikeMultipleDrafts('This is version 2 of the API.'));
      assert.ok(!looksLikeMultipleDrafts('Draft 1 is what I went with.'));
    });

    test('the same label repeated is one alternative, not two', () => {
      assert.ok(!looksLikeMultipleDrafts('Draft 1 ... as noted in Draft 1 above.'));
    });

    test('ordinary prose and code are left alone', () => {
      assert.ok(!looksLikeMultipleDrafts('Fixed the loop bound in subtotal().'));
      assert.ok(!looksLikeMultipleDrafts('const version1 = require("v1");'));
    });
  });

  test('junk input is false, not a throw', () => {
    for (const junk of ['', null, undefined, 42, {}, []]) {
      assert.strictEqual(looksLikeMultipleDrafts(junk), false);
    }
  });
});
