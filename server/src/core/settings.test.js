import test from 'node:test';
import assert from 'node:assert/strict';
import { describeSettings, filterSettings, SETTING_GROUPS } from './settings.js';

/** Enough of an AgentLoop for the page to describe. */
const loop = (over = {}) => ({
  workspace: '/work/repo',
  mode: 'plan',
  modelConfig: { main: 'gemini', reviewer: null, effort: 'standard' },
  commandRules: { enabled: true, allow: ['git status'], block: [] },
  memoryManager: { isMemoryEnabled: () => true, getAllMemories: () => ['a', 'b'] },
  skillFolders: [],
  ...over,
});

const row = (rows, label) => rows.find((r) => r.label === label);

test('describeSettings', async (t) => {
  await t.test('reports the values actually in force', () => {
    const rows = describeSettings(loop());
    assert.equal(row(rows, 'Effort').value, 'standard');
    assert.equal(row(rows, 'Main model').value, 'gemini');
    assert.equal(row(rows, 'Edit approval').value, 'plan');
    assert.equal(row(rows, 'Memory').value, 'on');
  });

  await t.test('the reviewer row is where solo and duo become visible', () => {
    assert.equal(row(describeSettings(loop()), 'Reviewer').value, 'none');
    const duo = loop({ modelConfig: { main: 'gemini', reviewer: 'chatgpt', effort: 'brief' } });
    assert.equal(row(describeSettings(duo), 'Reviewer').value, 'chatgpt');
    assert.match(row(describeSettings(duo), 'Reviewer').hint, /duo/);
  });

  // A reviewer set to the main model is not a duo — same blind spots.
  await t.test('a reviewer equal to the main model reads as none', () => {
    const same = loop({ modelConfig: { main: 'gemini', reviewer: 'gemini' } });
    assert.equal(row(describeSettings(same), 'Reviewer').value, 'none');
  });

  await t.test('each row that can be changed says what to run', () => {
    const rows = describeSettings(loop());
    assert.equal(row(rows, 'Effort').run, '/effort');
    assert.equal(row(rows, 'Memory').run, '/memory');
    // Plan mode offers the switch to auto, not a no-op back to plan.
    assert.equal(row(rows, 'Edit approval').run, '/auto');
    assert.equal(row(loop({ mode: 'auto' }) && describeSettings(loop({ mode: 'auto' })), 'Edit approval').run, '/plan');
  });

  // A settings page that throws is worse than one with a gap in it.
  await t.test('a half-built loop still produces a page', () => {
    for (const broken of [{}, { modelConfig: null }, { memoryManager: null }, { commandRules: null }]) {
      const rows = describeSettings({ workspace: '/w', ...broken });
      assert.ok(rows.length > 0);
      for (const r of rows) assert.equal(typeof r.value, 'string');
    }
    assert.ok(describeSettings(undefined).length > 0);
  });
});

test('filterSettings', async (t) => {
  const rows = describeSettings(loop({
    modelConfig: { main: 'gemini', reviewer: 'chatgpt', effort: 'deep' },
  }));

  await t.test('an empty query is everything', () => {
    assert.equal(filterSettings(rows, '').length, rows.length);
    assert.equal(filterSettings(rows, '   ').length, rows.length);
  });

  await t.test('matches the label', () => {
    const labels = filterSettings(rows, 'memory').map((r) => r.label);
    assert.ok(labels.includes('Memory'));
    assert.ok(labels.length < rows.length, 'and narrows the list');
  });

  await t.test('matches the value, so you can search for what it is set to', () => {
    assert.ok(filterSettings(rows, 'chatgpt').some((r) => r.label === 'Reviewer'));
  });

  // "duo" appears in no label. It is exactly what someone types to find out
  // whether a reviewer is on, so the hint has to be searchable too.
  await t.test('matches the hint', () => {
    assert.ok(filterSettings(rows, 'duo').some((r) => r.label === 'Reviewer'));
  });

  await t.test('case does not matter', () => {
    assert.deepEqual(filterSettings(rows, 'MEMORY'), filterSettings(rows, 'memory'));
  });

  await t.test('no match is empty, not everything', () => {
    assert.deepEqual(filterSettings(rows, 'zzzz'), []);
  });
});

test('tabs', async (t) => {
  const rows = describeSettings(loop({ conversationHistory: [{ content: 'hi' }] }));

  await t.test('every row belongs to a tab that exists', () => {
    for (const row of rows) {
      assert.ok(SETTING_GROUPS.includes(row.group), `${row.label} -> ${row.group}`);
    }
  });

  // A tab with two rows in it is a worse answer than no tab.
  await t.test('no tab is empty', () => {
    for (const group of SETTING_GROUPS) {
      assert.ok(rows.filter((r) => r.group === group).length >= 3, group);
    }
  });

  await t.test('a group narrows the list', () => {
    const status = filterSettings(rows, '', 'Status');
    assert.ok(status.length > 0);
    assert.ok(status.every((r) => r.group === 'Status'));
    assert.ok(status.length < rows.length);
  });

  // Making someone find the right tab before they can search for a setting is
  // asking them to know the answer first.
  await t.test('typing searches every tab, not just the one you are on', () => {
    const found = filterSettings(rows, 'github', 'Settings');
    assert.ok(found.some((r) => r.label === 'GitHub'), 'GitHub lives on the Status tab');
  });

  await t.test('an empty query returns to the tab you were on', () => {
    assert.ok(filterSettings(rows, '', 'Context').every((r) => r.group === 'Context'));
  });
});

test('the context tab reports the window', async (t) => {
  await t.test('turns and tokens follow the history', () => {
    const rows = describeSettings(loop({
      conversationHistory: [{ content: 'x'.repeat(400) }, { content: 'y'.repeat(400) }],
    }));
    assert.equal(rows.find((r) => r.label === 'Turns').value, '2');
    assert.match(rows.find((r) => r.label === 'Tokens').value, /~200 \/ 50,000/);
  });

  await t.test('a loop with no diff engine still renders', () => {
    const rows = describeSettings(loop({ diffEngine: undefined }));
    assert.equal(rows.find((r) => r.label === 'Diffs').value, '0 pending');
  });
});
