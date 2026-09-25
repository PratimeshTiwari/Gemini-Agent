/**
 * The version badge on `chrome://extensions` is not evidence.
 *
 * On 2026-09-24 it read **1.25.0** while the loaded copy still carried
 * `github.com/*` site access — a permission removed from the manifest on
 * 2026-09-19. Six `model_options_unanswered` failures were investigated as a
 * broken picker selector; the selectors were provably fine and the build was
 * three weeks stale. A manifest number is something a person typed;
 * `chrome.runtime.getManifest()` is what Chrome is running.
 *
 * The negative controls are the point of this file. A staleness check that
 * fires when it has no information is one people learn to ignore, which costs
 * more than the staleness it exists to catch.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { extensionVersionNotice, expectedExtensionVersion } from '../../src/core/extension-version.js';

describe('expectedExtensionVersion', () => {
  /*
   * Resolved from the module's own location, not the workspace: the agent is
   * usually pointed at some other project, and the extension that matters is
   * the one beside the server that is running.
   */
  test('is the manifest in this checkout, not a hardcoded string', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const manifest = JSON.parse(
      readFileSync(resolve(here, '../../../extension/manifest.json'), 'utf8'),
    );
    assert.equal(expectedExtensionVersion(), manifest.version);
  });
});

describe('extensionVersionNotice', () => {
  test('agreement is silence', () => {
    assert.equal(extensionVersionNotice('1.26.0', '1.26.0'), null);
  });

  test('a disagreement names both sides and what to do', () => {
    const msg = extensionVersionNotice('1.25.0', '1.26.0');
    assert.match(msg, /1\.25\.0/);
    assert.match(msg, /1\.26\.0/);
    assert.match(msg, /chrome:\/\/extensions/);
  });

  /*
   * The case it was written for. Every build before 1.26.0 sends
   * `{clientType: 'extension'}` and nothing else — so silence is the only
   * reading available for precisely the builds old enough to be the problem.
   */
  test('no version reported is a version older than the check itself', () => {
    const msg = extensionVersionNotice(undefined, '1.26.0');
    assert.match(msg, /did not report a version/);
    assert.match(msg, /1\.26\.0/);
    assert.match(msg, /chrome:\/\/extensions/);
    assert.equal(extensionVersionNotice(null, '1.26.0'), msg, 'null and undefined read the same');
  });

  // No source tree beside the server — an installed copy, a packed release.
  // No opinion, never "mismatch".
  test('nothing to compare against says nothing at all', () => {
    assert.equal(extensionVersionNotice('1.25.0', null), null);
    assert.equal(extensionVersionNotice(undefined, null), null);
  });

  test('the comparison is by value, not by type', () => {
    assert.equal(extensionVersionNotice(1.26, '1.26'), null);
  });
});
