import { test, describe } from 'node:test';
import assert from 'node:assert';
import { describeDestructive } from '../../src/ui/destructive.js';

describe('describeDestructive — ask before destroying what was never named', () => {
  test('/allowlist clear asks, and says how much is at stake', () => {
    const d = describeDestructive('allowlist', ['clear'], { allowCount: 5, blockCount: 2 });
    assert.ok(d);
    assert.match(d.title, /Clear every command rule/);
    // Tightened after the loose version let "5 alloweds and 2 blockeds" ship.
    assert.match(d.detail, /\b5 allowed and 2 blocked\b/);
    assert.doesNotMatch(d.detail, /alloweds|blockeds/);
    assert.match(d.confirmLabel, /7/);
  });

  test('a rule named outright is not a surprise, so it is not gated here', () => {
    assert.equal(describeDestructive('allowlist', ['remove', 'rm -rf /'], {}), null);
    assert.equal(describeDestructive('allowlist', ['add', 'ls'], {}), null);
  });

  test('/memory forget names its target, so it passes', () => {
    assert.equal(describeDestructive('memory', ['forget', '3'], {}), null);
  });

  test('nothing to lose, nothing to ask', () => {
    assert.equal(describeDestructive('allowlist', ['clear'], { allowCount: 0, blockCount: 0 }), null);
    assert.equal(describeDestructive('clear', [], { turnCount: 0 }), null);
  });

  test('/clear counts the turns and names both copies', () => {
    const d = describeDestructive('clear', [], { turnCount: 12 });
    assert.ok(d);
    assert.match(d.detail, /12 turns/);
    assert.match(d.detail, /~\/\.agent/);
  });

  test('/new says the browser chat restarts too', () => {
    const d = describeDestructive('new', [], { turnCount: 3 });
    assert.match(d.title, /new chat/i);
    assert.match(d.detail, /new chat is started in the browser/);
  });

  test('/compact is deliberately not gated', () => {
    assert.equal(describeDestructive('compact', [], { turnCount: 50 }), null);
  });

  test('ordinary settings changes are not gated', () => {
    for (const [cmd, args] of [['plan', []], ['auto', []], ['memory', ['off']],
      ['effort', ['pro']], ['allowlist', ['disable']], ['config', []]]) {
      assert.equal(describeDestructive(cmd, args, { turnCount: 9 }), null, `${cmd} ${args}`);
    }
  });

  test('the subcommand is matched case-insensitively', () => {
    assert.ok(describeDestructive('allowlist', ['CLEAR'], { allowCount: 1, blockCount: 0 }));
  });
});
