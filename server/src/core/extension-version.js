/**
 * Is the extension Chrome is running the one in this source tree?
 *
 * Reported from use on 2026-09-24, and it cost most of a day.
 * `chrome://extensions` showed **1.25.0** while the loaded copy still had
 * `github.com/*` site access — a permission removed on 2026-09-19. So the
 * version badge was a number someone had typed into a manifest, not evidence
 * of anything, and six `model_options_unanswered` failures were diagnosed as a
 * broken picker selector when the selectors were provably fine: the loaded
 * build simply predated the code that reads them.
 *
 * The server cannot tell "stale content script" from "Gemini changed a
 * selector" by watching failures, because the two look identical from here.
 * It can tell them apart by asking, which costs one field on a handshake that
 * already happens.
 *
 * **The extension reports `chrome.runtime.getManifest().version`**, read out
 * of the bundle Chrome actually loaded, and this compares it with the manifest
 * beside the running server. Neither number is trusted on its own; the
 * disagreement is the signal.
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

let cached;

/**
 * The version in this checkout's `extension/manifest.json`, or null.
 *
 * Resolved from this module's own location rather than from the workspace: the
 * agent is usually pointed at some *other* project, and the extension that
 * matters is the one next to the server that is running.
 *
 * Null when it cannot be read — an installed copy with no source tree beside
 * it, a packed release. Null means "no opinion", never "mismatch": a check
 * that fires when it has no information is one people learn to ignore, which
 * costs more than the staleness it was meant to catch.
 */
export function expectedExtensionVersion() {
  if (cached !== undefined) return cached;
  try {
    const here = dirname(fileURLToPath(import.meta.url)); // server/src/core
    const manifest = resolve(here, '../../../extension/manifest.json');
    cached = JSON.parse(readFileSync(manifest, 'utf8')).version || null;
  } catch {
    cached = null;
  }
  return cached;
}

/** Test seam — the read is cached for the life of the process. */
export function resetExtensionVersionCache() {
  cached = undefined;
}

/**
 * What to say about the version the extension just reported, or null.
 *
 * @param {string|null|undefined} reported what `identify` carried
 * @param {string|null} [expected] override, for tests
 * @returns {string|null} one line for the transcript, or null when there is
 *   nothing worth saying
 */
export function extensionVersionNotice(reported, expected = expectedExtensionVersion()) {
  if (!expected) return null; // no source tree to compare against

  /*
   * No version at all is the case this was written for.
   *
   * Every build before 1.26.0 sends `{clientType: 'extension'}` and nothing
   * else, so silence here is itself the answer — and it is the *only* reading
   * available for exactly the builds old enough to be the problem.
   */
  if (!reported) {
    return `⚠ The extension did not report a version, so it predates ${expected}. `
      + 'Reload it at chrome://extensions — Load unpacked from this repo\'s `extension/` folder.';
  }

  if (String(reported) === String(expected)) return null;

  return `⚠ Extension is **${reported}**, this checkout is **${expected}** — reload it at `
    + 'chrome://extensions. Until then the browser is running different code from the server.';
}
