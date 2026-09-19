/**
 * An instant command must not raise a spinner it takes down again.
 *
 * Reported from use, with a screenshot: a `Thinking… (0s · ↑ 29.4k tokens · esc
 * to stop)` row sitting above `❯ /paste-image` and another above `❯ /image`,
 * both frozen at 0s, permanently in the scrollback.
 *
 * `handleSubmit` set `isProcessing(true)` and `'Thinking...'` for *anything*
 * starting with `/`, and every handler ends by setting it false. So an instant
 * command drew the live `Thinking…` row, committed its own two rows to
 * `<Static>` in between, and then shrank the live frame — leaving the row
 * stranded above the static write, where Ink can never repaint it. Above the
 * command, because it was drawn before the rows it ends up sitting on.
 *
 * Neither half of this is visible in a diff: one is a `setIsProcessing(true)`
 * that reads as ordinary bookkeeping, and the other is a frame artefact you
 * only see by running the CLI. So it is pinned as a source assertion, the way
 * `turnInFlight` and `startup-order` already are.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SLOW_COMMANDS, AGENT_COMMANDS } from '../../src/core/slash-commands.js';

const appSrc = readFileSync(new URL('../../src/ui/App.jsx', import.meta.url), 'utf8');

describe('the spinner is gated', () => {
  test('the local-command branch consults SLOW_COMMANDS', () => {
    const branch = appSrc.slice(appSrc.indexOf("if (query.startsWith('/'))"),
      appSrc.indexOf('await handleSlashCommand('));

    assert.match(branch, /SLOW_COMMANDS\.has\(/,
      'every local command raises a spinner again; the stranded Thinking… row is back');
    assert.match(branch, /setIsProcessing\(true\)/,
      'the fixture no longer matches the code it is pinning');
  });

  /*
   * The control. Gating it is only right because one command really does wait:
   * `/compact` asks the model for a summary. An empty set would pass the
   * assertion above while removing the spinner from the one place it belongs —
   * the empty-compared-to-empty failure this repo has hit twice.
   */
  test('compact is in it, because it asks the model', () => {
    assert.ok(SLOW_COMMANDS.has('compact'));
    assert.ok(SLOW_COMMANDS.size > 0, 'an empty set makes the gate vacuous');
  });

  test('the instant ones are not', () => {
    for (const c of ['image', 'paste-image', 'help', 'effort', 'plan', 'auto', 'context']) {
      assert.equal(SLOW_COMMANDS.has(c), false, `${c} answers immediately and would strand a row`);
    }
  });

  // Every slow command must be a real one, or the gate is checking a typo.
  test('it names commands that exist', () => {
    for (const c of SLOW_COMMANDS) {
      assert.ok(AGENT_COMMANDS.has(c), `${c} is not a command, so the gate never matches it`);
    }
  });
});

describe('a local command still leaves a running turn alone', () => {
  /*
   * The older bug in the same three lines, kept pinned: `/efforttt` typed
   * during a turn wiped the live turn's rows and declared it finished while
   * the loop carried on. `turnInFlight` must still guard the branch, and must
   * still read from the loop rather than React's copy, which `handleSubmit`
   * sets itself.
   */
  test('turnInFlight still guards it, and still reads from the loop', () => {
    assert.match(appSrc, /const turnInFlight = Boolean\(agentLoop\.isProcessing\)/,
      'turnInFlight stopped reading the loop, so it reads the copy this function sets');

    const branch = appSrc.slice(appSrc.indexOf("if (query.startsWith('/'))"),
      appSrc.indexOf('await handleSlashCommand('));
    assert.match(branch, /!turnInFlight &&/,
      'a local command can disturb a live turn again');
  });

  test('and setIsProcessing is still neutered while the loop is busy', () => {
    assert.match(appSrc, /setIsProcessing: turnInFlight \? \(\) => \{\} : setIsProcessing/);
  });
});
