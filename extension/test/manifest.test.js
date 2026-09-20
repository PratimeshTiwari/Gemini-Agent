/**
 * The manifest has to be a valid *manifest*, not merely valid JSON.
 *
 * Reported from use, 2026-09-19, after ChatGPT was removed:
 *
 *     Failed to load extension
 *     Invalid value for 'content_scripts[1].matches'. There must be at least
 *     one match specified. Could not load manifest.
 *
 * Deleting the ChatGPT host from that entry's `matches` emptied the array
 * instead of removing the entry, and the entry went on naming a file that had
 * been deleted. `JSON.parse` was happy with all of it — it was checked, and
 * "it parses" was mistaken for "it is right", which is a trap already written
 * down in this repo's own notes.
 *
 * Chrome refuses the *whole extension* for this, not the one entry, so the
 * blast radius is everything: no bridge, no side panel, no service worker, and
 * the CLI simply never connects. Nothing in the test suite could see it,
 * because nothing in the test suite loaded the manifest as a manifest.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'));

describe('manifest.json is loadable by Chrome', () => {
  test('every content script matches at least one URL', () => {
    manifest.content_scripts?.forEach((cs, i) => {
      assert.ok(Array.isArray(cs.matches) && cs.matches.length > 0,
        `content_scripts[${i}] has no matches — Chrome refuses the whole extension for this`);
    });
  });

  /*
   * A script that is registered and missing is the same failure from the other
   * side: the entry looks fine and the file is not there. Both halves of the
   * bug above are covered, because fixing only one leaves the extension broken
   * in a way that reads identically.
   */
  test('every file it registers exists', () => {
    const files = [
      ...(manifest.content_scripts ?? []).flatMap((cs) => [...(cs.js ?? []), ...(cs.css ?? [])]),
      manifest.background?.service_worker,
      manifest.side_panel?.default_path,
      manifest.action?.default_popup,
      ...Object.values(manifest.icons ?? {}),
    ].filter(Boolean);

    assert.ok(files.length > 0, 'the manifest registered nothing, which cannot be right');
    for (const f of files) {
      // `default_popup` is a URL, not a path: the shipped one is
      // `side-panel/panel.html?popup=1`, and the query string is how the page
      // knows which surface it is drawing. Strip it before asking the disk.
      const onDisk = f.split(/[?#]/)[0];
      assert.ok(existsSync(resolve(root, onDisk)),
        `manifest names ${f}, which is not in the tree`);
    }
  });

  test('host permissions are real patterns, not empty strings', () => {
    for (const p of manifest.host_permissions ?? []) {
      assert.match(p, /^\*?:?\/\/|^https?:\/\//, `host permission ${JSON.stringify(p)} is not a pattern`);
    }
  });

  // The one model. A leftover host or script for a bridge that no longer
  // exists is how the entry above survived deletion in the first place.
  test('nothing names a bridge that was removed', () => {
    const text = JSON.stringify(manifest);
    assert.doesNotMatch(text, /chatgpt|claude\.ai/i);
  });
});
