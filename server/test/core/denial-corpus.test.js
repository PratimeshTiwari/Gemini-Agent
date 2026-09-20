/**
 * What counts as the model denying its tools, measured against real text.
 *
 * `looksLikeCapabilityDenial` gates a repair that **discards the reply and
 * re-asks**, so it is wrong in two expensive directions. A miss costs a turn
 * the user watches fail. A false positive destroys a correct answer.
 *
 * Both were happening. The pattern asked for an inability phrase and then,
 * loosely, for any of `execute|run|access|read|…` within 60 characters of any
 * of `local|file|directory|command|…` — a window wide enough to span two
 * clauses, so an ordinary finding about a `local variable` read as a refusal.
 * Meanwhile two real denials seen in use inside one day both slipped through,
 * because both were phrased in the passive: the model did not say *it* could
 * not, it said the tools were not connected.
 *
 * The denials below are transcribed from what Gemini actually returned. The
 * ordinary answers are the shapes that must never trip it — several of them
 * are sentences this project's own agent would plausibly write about this
 * repo, including one that mentions `mcp/tools/` by path.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeCapabilityDenial } from '../../src/core/drift-detector.js';

const DENIALS = [
  ['the known phrasing', 'I cannot execute local commands or access your local file system.'],
  ['passive, "not actively connected"', 'I would love to analyze your actual files. However, I am currently operating in an environment where the local file system tools listed in your prompt (search_files, read_file, list_directory, etc.) are not actively connected to my execution engine.'],
  ['passive, "not actually connected"', 'However, the tools listed in your prompt (like list_directory, grep_search, read_file, etc.) are not actually connected to my current execution environment. I am running as the standard Gemini chat assistant, not inside your local terminal.'],
  ['unable to', "I'm unable to access your file system directly."],
  ['as an AI', 'As an AI language model, I cannot run shell commands on your machine.'],
  ['no access to your files', "I don't have access to your local files."],
  ['the tools are not available', 'The tools you listed are not available in my current environment.'],
  ['a polite run-up', 'I do not have the ability to read files from your directory.'],
  ['a gap before the negation', 'I am running in a sandbox and cannot reach your local disk.'],
  ['no environment named', "I can't read files in that directory."],
  ['no repository access', "I don't have access to the repository to run those commands."],
];

const ORDINARY = [
  ['a finding that says "can\'t"', "I read the file and I can't see any problem with the parser — the local variable is fine."],
  ['cannot reproduce', "I can't reproduce the bug with the test file you gave me."],
  ['advising the user', "You can't run that command without sudo, so change the directory permissions instead."],
  ['a symbol lookup', 'I cannot find a reference to that symbol in the local scope.'],
  ['explaining a closure', "The function doesn't have access to the outer variable because of the closure."],
  ['a plain answer', 'The bug is in `paths.js`: resolveState walks up and finds ~/.agent, so every project shares one root.'],
  ['declining for a real reason', "I can't make that change without knowing which of the two callers you meant."],
  ['having listed a directory', 'I listed the directory and there are 14 files; none of them import the module.'],
  ['cannot see why', "I can't see why that would fail — the directory is created by the installer."],
  ['declining politely', 'I cannot help with that request.'],
  ['naming a path called tools', "I can't tell which of the files in mcp/tools/ registers it without reading them."],
];

test('it catches the ways the model actually refuses', () => {
  for (const [name, text] of DENIALS) {
    assert.equal(looksLikeCapabilityDenial(text), true, `missed: ${name}`);
  }
});

test('it leaves ordinary answers alone', () => {
  // The expensive direction: the caller throws the reply away and re-asks.
  for (const [name, text] of ORDINARY) {
    assert.equal(looksLikeCapabilityDenial(text), false, `false positive: ${name}`);
  }
});

test('a denial buried deep in a long answer is not one', () => {
  // A refusal is short and up front; a long answer that happens to contain
  // the words is answering the question.
  assert.equal(looksLikeCapabilityDenial('x'.repeat(700) + ' I cannot access your file system.'), false);
});
