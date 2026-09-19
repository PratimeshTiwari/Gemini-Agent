import test from 'node:test';
import assert from 'node:assert/strict';
import { describeSettings, filterSettings, settingsChanged, SETTING_GROUPS } from '../../src/core/settings.js';

/** Enough of an AgentLoop for the page to describe. */
const loop = (over = {}) => ({
  workspace: '/work/repo',
  mode: 'plan',
  modelConfig: { main: 'gemini', subagents: true, effort: 'standard' },
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

  await t.test('the subagent row is where on and off become visible', () => {
    assert.equal(row(describeSettings(loop()), 'Subagents').value, 'on');
    const off = loop({ modelConfig: { main: 'gemini', subagents: false, effort: 'brief' } });
    assert.equal(row(describeSettings(off), 'Subagents').value, 'off');
    assert.match(row(describeSettings(off), 'Subagents').hint, /one tab/);
  });

  /*
   * Absent means on. A config written before the toggle existed had subagent
   * tools available, so reading a missing key as "off" would silently take a
   * capability away from every existing workspace.
   */
  await t.test('a config with no subagent key reads as on', () => {
    const legacy = loop({ modelConfig: { main: 'gemini', effort: 'standard' } });
    assert.equal(row(describeSettings(legacy), 'Subagents').value, 'on');
  });

  await t.test('each row that can be changed says what to run', () => {
    const rows = describeSettings(loop());
    assert.equal(row(rows, 'Effort').run, '/effort');
    // The direction, not the bare command: `/memory` alone prints the facts,
    // which is not what pressing Enter on a switch should do.
    assert.equal(row(rows, 'Memory').run, '/memory off');
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
    modelConfig: { main: 'gemini', subagents: false, effort: 'deep' },
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
    assert.ok(filterSettings(rows, 'deep').some((r) => r.label === 'Effort'));
  });

  // "review" appears in no label. It is exactly what someone types to find out
  // whether subagents are on, so the hint has to be searchable too.
  await t.test('matches the hint', () => {
    const on = describeSettings(loop({ modelConfig: { main: 'gemini', subagents: true } }));
    assert.ok(filterSettings(on, 'review').some((r) => r.label === 'Subagents'));
    assert.ok(filterSettings(rows, 'delegated').some((r) => r.label === 'Subagents'));
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
    // 'Workspace' is a Status row, searched for from the Settings tab.
    const found = filterSettings(rows, 'workspace', 'Settings');
    assert.ok(found.some((r) => r.label === 'Workspace'), 'Workspace lives on the Status tab');
  });

  await t.test('an empty query returns to the tab you were on', () => {
    assert.ok(filterSettings(rows, '', 'Context').every((r) => r.group === 'Context'));
  });
});

test('the context tab reports the window', async (t) => {
  // Turns count what was kept locally; tokens count what the *tab* holds —
  // the system prompt, the tool definitions, every tool result fed back. They
  // are different numbers on purpose, and summing the history reported a
  // fraction of the real one.
  await t.test('turns follow the history, tokens follow the thread', () => {
    const rows = describeSettings(loop({
      conversationHistory: [{ content: 'x'.repeat(400) }, { content: 'y'.repeat(400) }],
      contextTokens: 4200,
    }));
    assert.equal(rows.find((r) => r.label === 'Turns').value, '2');
    assert.match(rows.find((r) => r.label === 'Tokens').value, /~4,200 \/ 50,000/);
  });

  await t.test('a loop that has sent nothing yet reads zero, not NaN', () => {
    assert.match(describeSettings(loop()).find((r) => r.label === 'Tokens').value, /~0 \//);
  });

  await t.test('a loop with no diff engine still renders', () => {
    const rows = describeSettings(loop({ diffEngine: undefined }));
    assert.equal(rows.find((r) => r.label === 'Diffs').value, '0 pending');
  });
});

/**
 * The exit screen reports what you did, not what happened while you were there.
 *
 * Reported from use: opening the page, changing nothing, and closing it
 * announced "2 settings changed — Turns 18 → 19, Session 18 turns kept → 19
 * turns kept". Both are Context rows, and everything in that group is a readout
 * that moves on its own — so the screen fired on every exit during an active
 * session, naming things the person had not done and could not undo. A warning
 * that is always wrong teaches people to ignore the one that matters.
 */
test('settingsChanged only reports settings', async (t) => {
  const before = describeSettings(loop());

  await t.test('a readout moving on its own is not a change', () => {
    // Exactly the reported case: the conversation advanced while the page was
    // open. Nothing here was touched by the person.
    const after = before.map((r) => (r.group === 'Context'
      ? { ...r, value: String(Number(r.value) + 1 || `${r.value}!`) }
      : r));
    assert.deepEqual(settingsChanged(before, after), []);
  });

  await t.test('a Status row moving on its own is not a change either', () => {
    const after = before.map((r) => (r.group === 'Status' ? { ...r, value: 'something else' } : r));
    assert.deepEqual(settingsChanged(before, after), []);
  });

  // The control. Narrowing to one group must not stop it reporting a real one.
  await t.test('an actual setting still reports, with a way back', () => {
    const after = describeSettings(loop({
      modelConfig: { main: 'gemini', subagents: false, effort: 'standard' },
    }));
    const changes = settingsChanged(before, after);

    const row = changes.find((c) => c.label === 'Subagents');
    assert.ok(row, `Subagents not reported; got ${JSON.stringify(changes.map((c) => c.label))}`);
    assert.equal(row.from, 'on');
    assert.equal(row.to, 'off');
    assert.match(row.restore, /subagents on/);
  });

  // A genuine setting with no undo is still a change worth naming — which is
  // why the group is the test rather than the presence of `restore`.
  await t.test('a setting with no undo is reported without one', () => {
    const after = before.map((r) => (r.label === 'Agent name' ? { ...r, value: 'DCX' } : r));
    const row = settingsChanged(before, after).find((c) => c.label === 'Agent name');
    assert.ok(row);
    assert.equal(row.restore, undefined);
  });
});
