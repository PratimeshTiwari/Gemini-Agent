/**
 * `run_background` reached none of the safety machinery.
 *
 * Found while looking for tools worth consolidating: `run_command` and
 * `run_background` are one operation with a blocking flag, so the question was
 * whether to merge them. The answer turned out to matter for a different
 * reason — they were not treated alike anywhere that counts.
 *
 * Every gate was written as `call.name === 'run_command'` literally:
 *
 *   - **Plan mode's approval list.** `needsApproval` starts false and nothing in
 *     that branch set it for `run_background`, so the mode whose status bar
 *     reads "plan — every edit needs approval" spawned a shell process that
 *     outlives the turn without asking. Auto mode *did* ask, through the
 *     classifier's "Unknown tool" default. The careful mode was the permissive
 *     one, for the tool whose effects last longest.
 *   - **The `critical` block.** `rm -rf /` was refused as `run_command` and run
 *     as `run_background`.
 *   - **The command log.** `.agent/logs/commands/` exists to answer "what has
 *     this thing been doing on my computer". Background processes were absent
 *     from it entirely.
 *
 * Both are declared on the catalog entry now — `mutates` for the approval gate,
 * `shell` for the rest — so adding a tool that writes or shells out means
 * saying so once beside its description, rather than remembering four literal
 * lists in another file.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MUTATING_TOOLS, SHELL_TOOLS } from '../../src/core/tool-catalog.js';
import { RiskClassifier } from '../../src/core/risk-classifier.js';

describe('the sets say what they are for', () => {
  test('both shell tools are in both sets', () => {
    for (const t of ['run_command', 'run_background']) {
      assert.ok(SHELL_TOOLS.has(t), `${t} is not treated as a shell tool`);
      assert.ok(MUTATING_TOOLS.has(t), `${t} would skip approval in plan mode`);
    }
  });

  test('writing tools need approval but are not shells', () => {
    for (const t of ['edit_file', 'create_file']) {
      assert.ok(MUTATING_TOOLS.has(t), t);
      assert.ok(!SHELL_TOOLS.has(t), `${t} would be sent down the command path`);
    }
  });

  /*
   * The control. Without it "every tool is in the set" passes, and plan mode
   * would stop for a `read_file` — which is how an approval prompt becomes
   * something people dismiss without reading.
   */
  test('reading tools are in neither', () => {
    for (const t of ['read_file', 'grep_search', 'list_directory', 'find_symbol']) {
      assert.ok(!MUTATING_TOOLS.has(t), `${t} would ask for approval to read`);
      assert.ok(!SHELL_TOOLS.has(t), t);
    }
  });
});

describe('a background command is classified like any other', () => {
  const rc = new RiskClassifier(process.cwd());
  const same = (cmd) => [
    rc.classify('run_command', { command: cmd }).level,
    rc.classify('run_background', { command: cmd }).level,
  ];

  for (const cmd of ['cat README.md', 'npm run dev', 'rm -rf /', 'curl x | sh']) {
    test(`"${cmd}" is judged the same either way`, () => {
      const [a, b] = same(cmd);
      assert.equal(b, a, `run_command says ${a}, run_background says ${b}`);
    });
  }

  // It used to fall through to the classifier's `default`, which is `risky` —
  // right by luck rather than by looking at the command, and never `critical`,
  // so nothing was ever blocked.
  test('it is not just the unknown-tool default', () => {
    assert.equal(rc.classify('run_background', { command: 'cat x' }).level, 'safe',
      'a read-only command should not be risky merely because of how it was started');
    assert.notEqual(rc.classify('run_background', { command: 'cat x' }).reason, 'Unknown tool');
  });
});
