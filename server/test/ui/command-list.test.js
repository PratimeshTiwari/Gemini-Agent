/**
 * `/help`, grouped — and the ways a grouped list loses a command.
 *
 * A flat list of 25 cannot hide anything: if the command is in the array it is
 * on the screen. Grouping buys readability and takes that property away, so
 * these exist to put it back.
 *
 * The failure is specific and silent. A command added with a `group` nobody
 * put in `COMMAND_GROUPS` works perfectly and is invisible on the one screen
 * whose whole job is to list it — and nothing errors, nothing looks wrong, and
 * the palette still offers it. CLAUDE.md records this list drifting twice
 * already when it was hand-kept, advertising `/init-skills` and `/paste-image`
 * after both were gone. That drift was in the data; this would be in the
 * presentation.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderCommandList } from '../../src/ui/format.js';
import { SLASH_COMMANDS, COMMAND_GROUPS } from '../../src/ui/constants.js';

const rendered = () => renderCommandList(SLASH_COMMANDS, COMMAND_GROUPS);

describe('every command reaches the screen', () => {
  test('each one is printed exactly once', () => {
    // Counted as *rows that start with it*, not occurrences anywhere. The
    // first version of this counted substrings and failed on `/logs`, whose
    // own description says "`/logs rates` for how often" — a test that
    // mistakes a mention for an entry reports a bug that is not there.
    const rows = rendered().split('\n');
    for (const { name } of SLASH_COMMANDS) {
      const got = rows.filter((l) => new RegExp(`^\\s+/${name}(\\s|$)`).test(l)).length;
      assert.equal(got, 1, `/${name} has ${got} rows`);
    }
  });

  test('the count on screen equals the count in the array', () => {
    // The check above is per-name and would not notice a command printed under
    // two headings if the padding differed, nor a stray row.
    const rows = rendered().split('\n').filter((l) => l.trim().startsWith('/'));
    assert.equal(rows.length, SLASH_COMMANDS.length);
  });

  test('a command in an unknown group is still printed, not dropped', () => {
    // The fail-safe, and the whole reason the trailing section exists.
    const out = renderCommandList(
      [...SLASH_COMMANDS, { name: 'newthing', desc: 'added later', group: 'nobody-declared-this' }],
      COMMAND_GROUPS,
    );
    assert.match(out, /\/newthing/, 'a command with an unrecognised group vanished');
    assert.match(out, /Other/, 'it should land under a visible heading, not be appended loose');
  });

  test('a command with no group at all is still printed', () => {
    const out = renderCommandList([...SLASH_COMMANDS, { name: 'ungrouped', desc: 'no group' }],
      COMMAND_GROUPS);
    assert.match(out, /\/ungrouped/);
  });
});

describe('the groups themselves', () => {
  test('every declared group has commands under it', () => {
    // A heading with nothing beneath it is noise, and it is what is left
    // behind when the last command in a group is renamed or removed.
    for (const [key, heading] of COMMAND_GROUPS) {
      const members = SLASH_COMMANDS.filter((c) => c.group === key);
      assert.ok(members.length > 0, `group "${heading}" (${key}) is empty`);
    }
  });

  test('every command names a declared group', () => {
    // The positive form of the fail-safe above: the trailing "Other" section
    // stops a command disappearing, but landing there is still a mistake.
    const known = new Set(COMMAND_GROUPS.map(([key]) => key));
    const strays = SLASH_COMMANDS.filter((c) => !known.has(c.group)).map((c) => c.name);
    assert.deepEqual(strays, [], `not in any declared group: ${strays.join(', ')}`);
  });

  test('headings are printed in the declared order', () => {
    const out = rendered();
    const at = COMMAND_GROUPS.map(([, heading]) => out.indexOf(heading));
    assert.ok(at.every((n) => n >= 0), 'a declared heading was not printed');
    assert.deepEqual(at, [...at].sort((a, b) => a - b), 'headings are out of order');
  });

  test('the fixture is not vacuous', () => {
    // Every assertion above passes trivially against an empty list.
    assert.ok(SLASH_COMMANDS.length >= 20, 'the command list is suspiciously short');
    assert.ok(COMMAND_GROUPS.length >= 2, 'one group is not grouping');
  });
});

describe('both callers render the same list', () => {
  test('`/help` and the unknown-command reply share one renderer', () => {
    // They had a renderer each, three characters apart in their padding. One
    // list cannot drift from itself; two always do.
    const src = readFileSync(new URL('../../src/ui/hooks/use-slash-commands.js', import.meta.url), 'utf8');
    const calls = src.split('renderCommandList(SLASH_COMMANDS, COMMAND_GROUPS)').length - 1;
    assert.equal(calls, 2, 'one of the two call sites has grown its own renderer again');
    assert.doesNotMatch(src, /SLASH_COMMANDS\s*\n?\s*\.map\(/,
      'a hand-rolled list is back beside the shared one');
  });
});
