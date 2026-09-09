import { test, describe } from 'node:test';
import assert from 'node:assert';
import { looksLikeMultipleDrafts, looksLikeCapabilityDenial, looksLikeProviderError } from './drift-detector.js';

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


describe('looksLikeCapabilityDenial — the model forgot it has tools', () => {
  test('catches the real refusal, verbatim from a lost turn', () => {
    assert.equal(looksLikeCapabilityDenial(
      'I cannot execute local commands or access your local file system to list '
      + 'the files in /Users/pratimesh/Documents/Gemini-Agent.',
    ), true);
  });

  test('catches the ways it phrases the same thing', () => {
    for (const text of [
      "I'm unable to run shell commands on your machine.",
      'I am unable to access the file system.',
      "I can't read files in that directory.",
      'As an AI language model, I cannot access your file system.',
      'I do not have the ability to read files from your directory.',
      "I don't have access to your local files.",
    ]) {
      assert.equal(looksLikeCapabilityDenial(text), true, text);
    }
  });

  test('needs the inability to be first-person', () => {
    // Perfectly good prose about someone else's code.
    assert.equal(looksLikeCapabilityDenial(
      'Your script cannot access the file system because it runs in a browser sandbox.',
    ), false);
    assert.equal(looksLikeCapabilityDenial(
      'The run_command tool can execute local commands for you.',
    ), false);
  });

  test('needs a capability, not just a refusal', () => {
    // A plain "no" is not tool amnesia, and retrying it would be a loop.
    assert.equal(looksLikeCapabilityDenial('I cannot help with that request.'), false);
  });

  test('ignores the phrase buried deep in a real answer', () => {
    // A denial leads; a long answer that mentions it is answering, not refusing.
    assert.equal(looksLikeCapabilityDenial('x'.repeat(700) + ' I cannot access your file system.'), false);
  });

  test('is quiet on ordinary output', () => {
    assert.equal(looksLikeCapabilityDenial(
      'I read the file and found three functions that list the directory contents.',
    ), false);
    assert.equal(looksLikeCapabilityDenial(''), false);
    assert.equal(looksLikeCapabilityDenial(undefined), false);
  });
});


describe('looksLikeProviderError — the tab failed, not the model', () => {
  test('catches the message Gemini Web actually returns', () => {
    assert.equal(looksLikeProviderError(
      'I encountered an error doing what you asked. Could you try again?',
    ), true);
  });

  test('catches the other providers\' equivalents', () => {
    for (const text of [
      'Something went wrong. Please try again.',
      'An error occurred. Try again later.',
      'Unable to complete your request.',
    ]) {
      assert.equal(looksLikeProviderError(text), true, text);
    }
  });

  test('length is what separates it from a real answer', () => {
    // A genuine reply that discusses an error is long and specific; the
    // provider's own apology is short and generic. Without this the detector
    // would retry perfectly good answers.
    const realAnswer = 'The build fails because config.js is missing. I encountered an error in '
      + 'the logs at line 40 showing MODULE_NOT_FOUND, and the fix is to add the file back. '.repeat(3);
    assert.equal(looksLikeProviderError(realAnswer), false);
  });

  test('is quiet on ordinary short replies and refusals', () => {
    assert.equal(looksLikeProviderError('Done — I updated three files.'), false);
    assert.equal(looksLikeProviderError('I cannot help with that request.'), false);
    assert.equal(looksLikeProviderError(''), false);
    assert.equal(looksLikeProviderError(undefined), false);
  });
});
