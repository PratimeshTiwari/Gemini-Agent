/**
 * The version, in the three places that must agree.
 *
 * Chrome shows `manifest.json`'s version, npm shows `package.json`'s, and the
 * README is what a person reads before deciding whether to reload. When they
 * disagree there is no way to tell a stale extension from a current one — which
 * matters more here than in most projects, because three artifacts ship from
 * one repo and a `git pull` updates none of them in the browser. "Is the
 * extension reloaded?" is the first question whenever something behaves like
 * yesterday's build, and a drifting version number makes it unanswerable.
 *
 * The side panel prints `chrome.runtime.getManifest().version` rather than a
 * literal, so the badge cannot drift from the manifest by construction. This
 * covers the two that can.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(here, '..', p), 'utf8');
const json = (p) => JSON.parse(read(p));

describe('the extension version', () => {
  const manifest = json('manifest.json').version;

  test('manifest and package agree', () => {
    assert.equal(json('package.json').version, manifest);
  });

  test('the README states the same one', () => {
    const stated = (read('README.md').match(/Current version: \*\*([0-9][0-9.]*)\*\*/) || [])[1];
    assert.ok(stated, 'the README no longer states a current version');
    assert.equal(stated, manifest);
  });

  test('the README has a section for it', () => {
    assert.match(
      read('README.md'),
      new RegExp(`^### ${manifest.replace(/\./g, '\\.')}\\b`, 'm'),
      `no "### ${manifest}" entry in the version history`,
    );
  });

  test('it is a plain three-part version', () => {
    assert.match(manifest, /^\d+\.\d+\.\d+$/);
  });
});
