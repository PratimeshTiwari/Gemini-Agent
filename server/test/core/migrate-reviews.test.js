/**
 * `.agent/github-pr-plans/` → `.agent/github-reviews/`.
 *
 * Two different things were called "plans": `/plans` reads
 * `.agent/artifacts/plans/` and `/github plans` read `github-pr-plans/` —
 * different formats, different code, one word, so "where is the plan?" had two
 * answers and no way to tell which was meant.
 *
 * This runs on an install that already *has* a `.agent/`, which is the only
 * kind that can have the old directory, so it cannot ride the pre-`.agent`
 * migration's "only when .agent is absent" guard.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { migrateGitHubReviews } from '../../src/core/migrate.js';

let ws;
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'mig-')); });
afterEach(() => rmSync(ws, { recursive: true, force: true }));

const old = () => join(ws, '.agent', 'github-pr-plans');
const now = () => join(ws, '.agent', 'github-reviews');

test('nothing to do is nothing done', () => {
  mkdirSync(join(ws, '.agent'), { recursive: true });
  assert.deepEqual(migrateGitHubReviews(ws), []);
});

test('the old directory is renamed, contents intact', () => {
  mkdirSync(join(old(), 'PR-1'), { recursive: true });
  writeFileSync(join(old(), 'PR-1', 'comment-9.md'), '# a review');
  const done = migrateGitHubReviews(ws);
  assert.equal(done.length, 1);
  assert.ok(!existsSync(old()));
  assert.equal(readFileSync(join(now(), 'PR-1', 'comment-9.md'), 'utf8'), '# a review');
});

test('it is a no-op the second time', () => {
  mkdirSync(old(), { recursive: true });
  migrateGitHubReviews(ws);
  assert.deepEqual(migrateGitHubReviews(ws), []);
});

test('both present: the old one is left alone, never merged', () => {
  // Merging two directories of generated markdown is a decision, and making it
  // silently on startup is how someone loses the half they wanted.
  mkdirSync(old(), { recursive: true });
  writeFileSync(join(old(), 'a.md'), 'old');
  mkdirSync(now(), { recursive: true });
  writeFileSync(join(now(), 'b.md'), 'new');

  assert.deepEqual(migrateGitHubReviews(ws), []);
  assert.equal(readFileSync(join(old(), 'a.md'), 'utf8'), 'old', 'the old directory was destroyed');
  assert.equal(readFileSync(join(now(), 'b.md'), 'utf8'), 'new');
});
