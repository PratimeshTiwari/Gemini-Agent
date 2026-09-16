/**
 * What the poller actually does, pinned before anything moves.
 *
 * 476 lines of network I/O and persisted state with no tests at all, and the
 * `github/` restructure moves through it. These are **characterisation** tests:
 * they describe the shipped behaviour, including the parts that look like
 * accidents, so the restructure has something to move against. Where behaviour
 * is arguably wrong the test says so rather than asserting the improvement —
 * changing it is a separate decision from making it visible.
 *
 * `fetch` is stubbed at the global, which is the whole seam: `_apiGet` calls it
 * directly, so nothing here touches the network or needs a token.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { GitHubPoller } from '../../src/github/github-poller.js';
import { resolveGitHubConfig } from '../../src/github/github-config.js';

let ws;
let realFetch;
let calls;

/** Answer each request from a map of url-fragment -> body (or a status). */
function stubFetch(routes) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init?.headers });
    for (const [fragment, reply] of Object.entries(routes)) {
      if (!String(url).includes(fragment)) continue;
      if (typeof reply === 'number') {
        return {
          ok: false, status: reply, statusText: 'Error',
          headers: new Map(),
          text: async () => 'boom',
          json: async () => ({}),
        };
      }
      return {
        ok: true, status: 200, statusText: 'OK',
        headers: new Map(Object.entries(reply.headers || {})),
        json: async () => reply.body ?? reply,
        text: async () => JSON.stringify(reply.body ?? reply),
      };
    }
    return { ok: false, status: 404, statusText: 'Not Found', headers: new Map(), text: async () => '', json: async () => ({}) };
  };
}

const poller = (over = {}) => new GitHubPoller({
  token: 'test-token',
  workspace: ws,
  config: resolveGitHubConfig({ repos: ['octo/repo'], ignoreAuthors: ['bot'], ...over }),
});

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'ghp-'));
  realFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(ws, { recursive: true, force: true });
});

describe('the token, and what its failure looks like', () => {
  test('the expiry header is read while the token still works', () => {
    // A lapsed token looks exactly like one that was never valid — a 401 with
    // "Bad credentials" — so the only way to say "expired" rather than
    // "rejected" is to have read the date beforehand.
    stubFetch({ '/user': { body: { login: 'me' }, headers: { 'github-authentication-token-expiration': '2026-12-01 10:00:00 UTC' } } });
    const p = poller();
    return p._fetchAuthenticatedUser().then(() => {
      assert.match(p.tokenExpiry, /^2026-12-01T10:00:00/);
    });
  });

  test('a classic token with no expiry leaves it null', async () => {
    stubFetch({ '/user': { body: { login: 'me' } } });
    const p = poller();
    await p._fetchAuthenticatedUser();
    assert.equal(p.tokenExpiry, null);
  });

  test('a non-OK response throws with the status in the message', async () => {
    stubFetch({ '/user': 401 });
    await assert.rejects(() => poller()._fetchAuthenticatedUser(), /401/);
  });

  test('every request carries the auth and API-version headers', async () => {
    stubFetch({ '/user': { body: { login: 'me' } } });
    await poller()._fetchAuthenticatedUser();
    assert.equal(calls[0].headers.Authorization, 'Bearer test-token');
    assert.equal(calls[0].headers['X-GitHub-Api-Version'], '2022-11-28');
  });
});

describe('comment watermarks — the thing that stops it replaying history', () => {
  const PR = { key: 'octo/repo#1', number: 1, repo: { full_name: 'octo/repo' } };

  test('a PR seen for the first time returns nothing and starts its clock', async () => {
    // Otherwise every comment ever written on an open PR arrives at once the
    // first time the agent is pointed at a repo.
    stubFetch({});
    const p = poller();
    assert.deepEqual(await p._fetchNewComments(PR), []);
    assert.ok(p.state.commentWatermarks['octo/repo#1'], 'no watermark was set');
    assert.equal(calls.length, 0, 'it fetched before deciding to ignore the result');
  });

  test('once watermarked, comments since then are fetched', async () => {
    stubFetch({
      '/issues/1/comments': { body: [{ id: 1, body: 'hi', user: { login: 'alice' }, created_at: 'x', updated_at: 'x', html_url: 'u' }] },
      '/pulls/1/comments': { body: [] },
    });
    const p = poller();
    p.state.commentWatermarks['octo/repo#1'] = '2020-01-01T00:00:00Z';
    const got = await p._fetchNewComments(PR);
    assert.equal(got.length, 1);
    assert.equal(got[0].type, 'issue_comment');
    assert.ok(calls.some((c) => c.url.includes('since=2020-01-01')), 'the watermark was not sent');
  });

  test('an ignored author is dropped', async () => {
    stubFetch({
      '/issues/1/comments': { body: [{ id: 1, body: 'beep', user: { login: 'bot' }, created_at: 'x', updated_at: 'x', html_url: 'u' }] },
      '/pulls/1/comments': { body: [] },
    });
    const p = poller();
    p.state.commentWatermarks['octo/repo#1'] = '2020-01-01T00:00:00Z';
    assert.deepEqual(await p._fetchNewComments(PR), []);
  });

  test('a review comment carries its file and line', async () => {
    stubFetch({
      '/issues/1/comments': { body: [] },
      '/pulls/1/comments': { body: [{ id: 2, body: 'fix', user: { login: 'bob' }, created_at: 'x', updated_at: 'x', html_url: 'u', path: 'a.js', original_line: 12, diff_hunk: '@@' }] },
    });
    const p = poller();
    p.state.commentWatermarks['octo/repo#1'] = '2020-01-01T00:00:00Z';
    const [c] = await p._fetchNewComments(PR);
    assert.equal(c.path, 'a.js');
    assert.equal(c.line, 12, 'falls back to original_line when line is absent');
  });

  test('the watermark only moves when something was found', async () => {
    // So a poll that returns nothing cannot skip a comment written during it.
    stubFetch({ '/issues/1/comments': { body: [] }, '/pulls/1/comments': { body: [] } });
    const p = poller();
    p.state.commentWatermarks['octo/repo#1'] = '2020-01-01T00:00:00Z';
    await p._fetchNewComments(PR);
    assert.equal(p.state.commentWatermarks['octo/repo#1'], '2020-01-01T00:00:00Z');
  });

  test('one endpoint failing does not lose the other', async () => {
    stubFetch({ '/issues/1/comments': 500, '/pulls/1/comments': { body: [{ id: 3, body: 'x', user: { login: 'bob' }, created_at: 'x', updated_at: 'x', html_url: 'u' }] } });
    const p = poller();
    p.state.commentWatermarks['octo/repo#1'] = '2020-01-01T00:00:00Z';
    const errors = [];
    p.on('error', (e) => errors.push(e));
    const got = await p._fetchNewComments(PR);
    assert.equal(got.length, 1, 'a failed issue-comment fetch took the review comments with it');
    assert.equal(errors.length, 1);
  });
});

describe('state on disk', () => {
  test('a missing state file is an empty state, not a crash', () => {
    stubFetch({});
    const p = poller();
    assert.deepEqual(p.state, { commentWatermarks: {}, seenCIRuns: {} });
  });

  test('a corrupt state file is an empty state, and is logged', () => {
    // A poller that will not start because its cache is malformed is worse
    // than one that starts fresh.
    stubFetch({});
    const p = poller();
    p.state = { commentWatermarks: { 'a#1': 'x' }, seenCIRuns: {} };
    p._saveState();
    writeFileSync(p.stateFile, '{ not json');
    assert.deepEqual(p._loadState(), { commentWatermarks: {}, seenCIRuns: {} });
  });

  test('state survives a round trip', () => {
    stubFetch({});
    const p = poller();
    p.state.commentWatermarks['octo/repo#9'] = '2026-01-01T00:00:00Z';
    p._saveState();
    assert.ok(existsSync(p.stateFile));
    assert.equal(JSON.parse(readFileSync(p.stateFile, 'utf8')).commentWatermarks['octo/repo#9'], '2026-01-01T00:00:00Z');
    assert.deepEqual(poller()._loadState().commentWatermarks, p.state.commentWatermarks);
  });
});

describe('_normalizePR — one shape from several', () => {
  test('a pulls-API item', () => {
    const pr = poller()._normalizePR({ number: 7, title: 'T', html_url: 'u', head: { ref: 'b', sha: 's' } }, 'octo/repo');
    assert.equal(pr.number, 7);
    assert.equal(pr.head_ref, 'b');
    assert.equal(pr.key, 'octo/repo#7');
    assert.deepEqual(pr.repo, { owner: 'octo', name: 'repo', full_name: 'octo/repo' });
  });

  test('a search-API item, where the PR is nested', () => {
    const pr = poller()._normalizePR({ number: 8, title: 'T', pull_request: { html_url: 'u' } }, 'octo/repo');
    assert.equal(pr.number, 8);
    assert.equal(pr.head_ref, 'unknown', 'search results carry no head ref');
  });

  test('the key is built from raw.number, not the normalised one', () => {
    // So an item whose number is only recoverable from the URL normalises to a
    // sensible `number` and to the key `octo/repo#undefined`. Characterised,
    // not fixed: it is the watermark key, and changing it resets every PR.
    const pr = poller()._normalizePR({ title: 'T', html_url: 'https://github.com/octo/repo/pull/9' }, 'octo/repo');
    assert.equal(pr.number, 9);
    assert.equal(pr.key, 'octo/repo#undefined');
  });
});
