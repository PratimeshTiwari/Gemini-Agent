import { test, describe } from 'node:test';
import assert from 'node:assert';
import { formatPollTime } from '../../src/ui/format.js';

describe('formatPollTime', () => {
  const now = Date.UTC(2026, 8, 6, 12, 0, 0);

  test('recent polls read as elapsed time', () => {
    assert.strictEqual(formatPollTime(new Date(now - 3000).toISOString(), now), 'just now');
    assert.strictEqual(formatPollTime(new Date(now - 42000).toISOString(), now), '42s ago');
    assert.strictEqual(formatPollTime(new Date(now - 600000).toISOString(), now), '10m ago');
  });

  test('an old poll falls back to a clock time rather than a huge number', () => {
    const out = formatPollTime(new Date(now - 7200000).toISOString(), now);
    assert.doesNotMatch(out, /ago/);
    assert.match(out, /\d/);
  });

  test('never polled, and unparseable values, still render', () => {
    assert.strictEqual(formatPollTime(null, now), 'never');
    assert.strictEqual(formatPollTime(undefined, now), 'never');
    assert.strictEqual(formatPollTime('', now), 'never');
    assert.strictEqual(formatPollTime('not a date', now), 'not a date');
  });

  test('a Date works as well as an ISO string', () => {
    assert.strictEqual(formatPollTime(new Date(now - 42000), now), '42s ago');
  });
});
