import { test, describe } from 'node:test';
import assert from 'node:assert';
import { looksLikeMultipleDrafts, looksLikeCapabilityDenial, looksLikeProviderError, looksLikeCodeQuestion } from '../../src/core/drift-detector.js';

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

/**
 * The fourth detector, and the only one that reads the *user's* words.
 *
 * It exists because the failure reported most often from use — "on the very
 * first prompt Gemini hallucinates and does not act as an agent" — was recorded
 * nowhere. `looksLikeCapabilityDenial` catches an *explicit* refusal and sits at
 * 0.38%; a model that answers from priors, denying nothing and opening nothing,
 * produced no log line at all. `turn0_no_tools` pairs this with "and nothing was
 * opened", which is the pair that is the failure — neither half alone is.
 */
describe('looksLikeCodeQuestion', () => {
  test('the prompts that actually produced the reported failure', () => {
    // Verbatim from the incident. The first cut of this detector returned false
    // for it — a detector that cannot see its own founding case is measuring
    // something else, which is why these two are pinned first.
    assert.ok(looksLikeCodeQuestion('can you help me improve the effort tiers?'));
    assert.ok(looksLikeCodeQuestion('should we send system prompt in chunks again to remind model ?'));
  });

  test('a path, a filename or a repo noun', () => {
    for (const q of [
      'read server/src/core/agent-loop.js',
      'what is in App.jsx',
      'explain the parser module',
      'where is buildPrompt defined',
      'who calls handleGeminiResponse',
      'how does this codebase handle retries',
    ]) assert.ok(looksLikeCodeQuestion(q), `missed: ${q}`);
  });

  test('first person plural is someone talking about their own system', () => {
    for (const q of [
      'should we restrict this',
      'can we fix our agent loop',
      'do we have a test for that',
      'refactor this',
    ]) assert.ok(looksLikeCodeQuestion(q), `missed: ${q}`);
  });

  // A false positive costs one log row a human reads; a false negative costs
  // the measurement. But it must not fire on everything, or the rate is 100%
  // and says nothing — these are the control.
  test('ordinary questions that deserve no tool call', () => {
    for (const q of [
      'hi', 'thanks!', 'ok', 'tell me a joke',
      'write me a haiku about autumn',
      'what is the capital of France',
      'translate good morning into japanese',
      'summarise this article for me',
    ]) assert.equal(looksLikeCodeQuestion(q), false, `fired on: ${q}`);
  });

  test('nothing is not a question', () => {
    assert.equal(looksLikeCodeQuestion(''), false);
    assert.equal(looksLikeCodeQuestion(null), false);
    assert.equal(looksLikeCodeQuestion(undefined), false);
    assert.equal(looksLikeCodeQuestion('   '), false);
  });
});
