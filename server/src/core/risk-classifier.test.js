import test from 'node:test';
import assert from 'node:assert';
import { RiskClassifier } from './risk-classifier.js';

test('RiskClassifier', async (t) => {
  let classifier;

  t.beforeEach(() => {
    classifier = new RiskClassifier();
    classifier.workspacePath = '/Users/pratimesh/workspace'; 
  });

  await t.test('should allow safe commands', () => {
    const result = classifier.classify('run_command', { command: 'ls -la', cwd: '/Users/pratimesh/workspace' });
    assert.strictEqual(result.level, 'safe');
  });

  await t.test('should flag rm -rf outside workspace as critical', () => {
    const result = classifier.classify('run_command', { command: 'rm -rf /', cwd: '/' });
    assert.strictEqual(result.level, 'critical');
    assert.ok(result.reason.includes('Global system modification'));
  });

  await t.test('should flag mkfs outside workspace as critical', () => {
    const result = classifier.classify('run_command', { command: 'mkfs.ext4 /dev/sda1', cwd: '/' });
    assert.strictEqual(result.level, 'critical');
    assert.ok(result.reason.includes('Global system modification'));
  });

  await t.test('should allow npm commands as risky within workspace', () => {
    const result = classifier.classify('run_command', { command: 'npm run test', cwd: '/Users/pratimesh/workspace' });
    assert.strictEqual(result.level, 'risky');
  });
});
