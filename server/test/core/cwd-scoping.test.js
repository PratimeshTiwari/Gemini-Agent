/**
 * A relative `cwd` means "inside the workspace", not "somewhere else".
 *
 * `_scopedMutation` compared the raw string with `startsWith`, so `cwd: "."` —
 * which *is* the workspace — did not start with `/Users/...` and was judged
 * outside it. Outside makes a mutation `critical`, and critical is blocked
 * outright rather than offered for approval.
 *
 * Observed in real use: `run_command npm test` refused with "❌ Command blocked
 * by Security Constraints". That is the agent unable to run the tests it is
 * told, in several places, to run before claiming anything works — and the
 * block looks like a considered safety decision rather than a string
 * comparison. Nothing in `run_command`'s description says `cwd` must be
 * absolute, and `"."` or `"server"` is what a model naturally sends.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { RiskClassifier } from '../../src/core/risk-classifier.js';

const WS = '/work/project';
const level = (cwd, command = 'npm test') =>
  new RiskClassifier(WS).classify('run_command', { command, cwd }).level;

describe('a cwd inside the workspace is not treated as outside it', () => {
  for (const cwd of [undefined, '.', './', 'server', './server', 'server/src', WS, `${WS}/server`]) {
    test(`cwd ${JSON.stringify(cwd)} is inside`, () => {
      assert.equal(level(cwd), 'risky', 'an ordinary command was blocked outright');
    });
  }
});

describe('and outside still means outside', () => {
  /*
   * The controls. Resolving the path is how a scope check stops checking — a
   * version that answers "inside" for everything passes every assertion above
   * and silently removes the distinction the classifier exists to draw.
   */
  for (const cwd of ['..', '../..', '/etc', '/tmp', `${WS}/../elsewhere`]) {
    test(`cwd ${JSON.stringify(cwd)} is outside`, () => {
      assert.equal(level(cwd), 'critical', 'an escape was treated as inside');
    });
  }

  /*
   * The prefix trap the old `startsWith` also had: a sibling whose name merely
   * begins with the workspace's was judged inside it. `/work/project-old` is
   * not in `/work/project`, and containment has to be checked on a separator
   * boundary to say so.
   */
  test('a sibling with a shared prefix is outside', () => {
    assert.equal(level('/work/project-old'), 'critical');
    assert.equal(level('/work/projectile'), 'critical');
  });
});

// Unrelated to scope: a read-only command stays safe wherever it runs, or every
// `cat` outside the tree would start asking for approval.
describe('read-only commands are unaffected', () => {
  for (const cwd of ['.', '/etc', undefined]) {
    test(`cat is safe with cwd ${JSON.stringify(cwd)}`, () => {
      assert.equal(level(cwd, 'cat README.md'), 'safe');
    });
  }
});
