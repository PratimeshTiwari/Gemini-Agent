/**
 * transcript — Unit Tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { groupTurns, parseTurnActions, parseFsEventPath, describeArtifactWrite, mergeLoopHistory } from '../../src/ui/transcript.js';

describe('groupTurns', () => {
  it('starts a turn at each user message and attaches what follows', () => {
    const turns = groupTurns([
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'two' },
    ]);

    assert.strictEqual(turns.length, 2);
    assert.strictEqual(turns[0].userMsg.content, 'one');
    assert.strictEqual(turns[0].steps.length, 1);
    assert.strictEqual(turns[1].steps.length, 0);
  });

  it('opens a turn with no user message when history starts mid-stream', () => {
    const turns = groupTurns([{ role: 'assistant', content: 'resumed' }]);
    assert.strictEqual(turns.length, 1);
    assert.strictEqual(turns[0].userMsg, null);
  });

  it('tags each message with its index in the flat history', () => {
    const history = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }];
    groupTurns(history);
    assert.deepStrictEqual(history.map(m => m._globalIdx), [0, 1]);
  });
});

describe('parseTurnActions', () => {
  it('pairs a tool_result with the tool_call before it', () => {
    const { actions } = parseTurnActions({
      id: 1,
      steps: [
        { type: 'tool_call', toolName: 'read_file', args: { path: 'a' } },
        { type: 'tool_result', result: { totalLines: 3 }, success: true },
      ],
    });

    assert.strictEqual(actions.length, 1);
    assert.strictEqual(actions[0].type, 'tool');
    assert.strictEqual(actions[0].toolName, 'read_file');
    assert.strictEqual(actions[0].success, true);
  });

  it('keeps an orphan tool_result as its own row', () => {
    const { actions } = parseTurnActions({ id: 1, steps: [{ type: 'tool_result', result: 'x' }] });
    assert.strictEqual(actions[0].type, 'tool_result');
  });

  it('splits thinking out of the reply and keeps the prose', () => {
    const { actions, finalMessages } = parseTurnActions({
      id: 1,
      steps: [{ role: 'assistant', content: '<think>reasoning</think>the answer' }],
    });

    assert.strictEqual(actions[0].type, 'think');
    assert.strictEqual(actions[0].content, 'reasoning');
    assert.strictEqual(finalMessages[0].content, 'the answer');
  });

  it('lifts an attached image out of the message body', () => {
    const { actions, finalMessages } = parseTurnActions({
      id: 1,
      steps: [{ role: 'assistant', content: '🖼️ Image attached: /tmp/shot.png\nlook at this' }],
    });

    assert.strictEqual(actions[0].type, 'image');
    assert.strictEqual(actions[0].content, '/tmp/shot.png');
    assert.strictEqual(finalMessages[0].content, 'look at this');
  });

  it('separates command output from other system messages', () => {
    const { actions } = parseTurnActions({
      id: 1,
      steps: [
        { role: 'system', type: 'command_output', content: '$ ls' },
        { role: 'system', content: 'note' },
      ],
    });

    assert.deepStrictEqual(actions.map(a => a.type), ['command_output', 'system']);
  });
});

describe('parseTurnActions — image attachments', () => {
  const turnWith = (content) => ({ id: 0, userMsg: null, steps: [{ role: 'assistant', content }] });

  it('the size suffix /image writes is consumed, not left in the prose', () => {
    const { actions, finalMessages } = parseTurnActions(
      turnWith('🖼️ Image attached: /tmp/shot.png (128KB)\nType your prompt and the image will be included.'),
    );
    assert.strictEqual(actions[0].type, 'image');
    assert.strictEqual(actions[0].content, '/tmp/shot.png');
    assert.doesNotMatch(finalMessages[0].content, /128KB/);
    assert.doesNotMatch(finalMessages[0].content, /^\s*\(/);
  });

  it('every supported extension is recognised, with or without a size', () => {
    for (const name of ['a.png', 'b.jpg', 'c.jpeg', 'd.webp']) {
      for (const suffix of ['', ' (4KB)', '(1024 KB)']) {
        const { actions } = parseTurnActions(turnWith(`🖼️ Image attached: /tmp/${name}${suffix}\nrest`));
        assert.strictEqual(actions[0]?.content, `/tmp/${name}`, `${name}${suffix}`);
      }
    }
  });

  it('an image and a think block in one message get distinct ids', () => {
    const { actions } = parseTurnActions(
      turnWith('<think>hmm</think>🖼️ Image attached: /tmp/a.png (2KB)\nrest'),
    );
    const ids = actions.map((a) => a.id);
    assert.strictEqual(new Set(ids).size, ids.length, `duplicate ids: ${ids.join(', ')}`);
  });
});

describe('parseTurnActions — the model\'s reasoning', () => {
  const parse = (content) => parseTurnActions({ id: 1, steps: [{ role: 'assistant', content }] });

  // Every tier's prompt asks for `<thought>`; this used to match `<think>`, a
  // tag nothing asks for. So reasoning was never recognised as reasoning and
  // went into the transcript as raw XML.
  it('recognises the tag the prompt actually asks for', () => {
    const { actions, finalMessages } = parse('<thought>weighing it up</thought>\nHere is the answer.');
    assert.deepStrictEqual(actions.map((a) => a.type), ['think']);
    assert.strictEqual(actions[0].content, 'weighing it up');
    assert.strictEqual(finalMessages[0].content, 'Here is the answer.');
  });

  it('still recognises the older spelling', () => {
    const { actions } = parse('<think>older</think>\nanswer');
    assert.strictEqual(actions[0].content, 'older');
  });

  // A pro turn routinely emits several. A non-global replace left every block
  // after the first sitting in the prose.
  it('takes all of them, not just the first', () => {
    const { actions, finalMessages } = parse(
      '<thought>one</thought>\nfirst\n<thought>two</thought>\nsecond',
    );
    assert.deepStrictEqual(actions.map((a) => a.content), ['one', 'two']);
    assert.ok(!finalMessages[0].content.includes('<thought>'));
  });

  it('gives each one its own row id', () => {
    const { actions } = parse('<thought>a</thought>x<thought>b</thought>');
    assert.strictEqual(new Set(actions.map((a) => a.id)).size, 2);
  });

  // A reply cut off mid-thought would otherwise leave a bare opening tag and
  // everything after it in the transcript.
  it('an unclosed block does not leak the tag into the prose', () => {
    const { finalMessages } = parse('Here goes.\n<thought>I was interrupted');
    assert.strictEqual(finalMessages[0].content, 'Here goes.');
  });

  it('a reply with no reasoning is untouched', () => {
    const { actions, finalMessages } = parse('Just the answer.');
    assert.deepStrictEqual(actions, []);
    assert.strictEqual(finalMessages[0].content, 'Just the answer.');
  });
});

describe('mergeLoopHistory — the transcript is append-only', () => {
  const user = (c) => ({ role: 'user', content: c });
  const agent = (c) => ({ role: 'agent', content: c });
  const local = (c) => ({ role: 'assistant', content: c, isLocal: true });
  /** What `handleSubmit` puts on screen the instant you press enter. */
  const echo = (c) => ({ role: 'user', content: c, __echo: true });
  const text = (rows) => rows.map((m) => m.content);

  it('a new agent message is appended', () => {
    const shown = [echo('hi')];
    assert.deepEqual(text(mergeLoopHistory(shown, [user('hi'), agent('hello')])),
      ['hi', 'hello']);
  });

  it('nothing new returns the same array, so React can skip the render', () => {
    let shown = mergeLoopHistory([echo('hi')], [user('hi'), agent('hello')]);
    assert.equal(mergeLoopHistory(shown, [user('hi'), agent('hello')]), shown);
  });

  /**
   * The reported bug. `/new` leaves a local marker on screen that the loop does
   * not have; replacing the array dropped it, the array got shorter, and
   * <Static> — which counts what it has printed by index — skipped the turn.
   */
  it('a local marker does not cost a turn', () => {
    let shown = [local('✨ Starting a new chat in Gemini...'), echo('hi')];
    shown = mergeLoopHistory(shown, [user('hi'), agent('ANSWER ONE')]);
    assert.deepEqual(text(shown),
      ['✨ Starting a new chat in Gemini...', 'hi', 'ANSWER ONE']);

    shown = [...shown, echo('hi again')];
    shown = mergeLoopHistory(shown,
      [user('hi'), agent('ANSWER ONE'), user('hi again'), agent('ANSWER TWO')]);
    assert.deepEqual(text(shown),
      ['✨ Starting a new chat in Gemini...', 'hi', 'ANSWER ONE', 'hi again', 'ANSWER TWO']);
  });

  it('several local messages still cost nothing', () => {
    let shown = [local('a'), local('b'), local('c'), echo('q')];
    shown = mergeLoopHistory(shown, [user('q'), agent('r')]);
    assert.deepEqual(text(shown), ['a', 'b', 'c', 'q', 'r']);
  });

  it('a slash command in the middle does not shift the count', () => {
    let shown = mergeLoopHistory([echo('q1')], [user('q1'), agent('r1')]);
    shown = [...shown, { ...user('/help'), isLocal: true }, local('…help…'), echo('q2')];
    shown = mergeLoopHistory(shown, [user('q1'), agent('r1'), user('q2'), agent('r2')]);
    assert.deepEqual(text(shown), ['q1', 'r1', '/help', '…help…', 'q2', 'r2']);
  });

  it('history shorter than the screen is left alone for the repaint to handle', () => {
    const shown = [user('q1'), agent('r1')];
    assert.equal(mergeLoopHistory(shown, []), shown);
  });

  /**
   * The bug this was rewritten for, reproduced under the pty harness.
   *
   * `file-watcher.js` appends a system turn whenever anything on disk moves,
   * so leaving the agent open while editing in another window fills the loop's
   * history *before the session's first prompt*. The old code counted the
   * screen's non-local rows and used that as a slice index into the loop —
   * screen 1, loop 16 — so it appended eleven system events and a second copy
   * of the user's own prompt, and every later merge was misaligned.
   *
   * Observed: transcript empty after a turn that had plainly worked.
   */
  it('system turns the screen never asked for do not misalign it', () => {
    const noise = Array.from({ length: 12 },
      (_, i) => ({ role: 'system', content: `[System Event] File ${i}.js was modified` }));

    let shown = [echo('make a js file')];
    shown = mergeLoopHistory(shown, [...noise, user('make a js file'), agent('FIRST REPLY')]);

    assert.equal(text(shown).filter((c) => c === 'make a js file').length, 1,
      'the prompt is drawn once, not echoed and then appended again');
    assert.ok(text(shown).includes('FIRST REPLY'));

    // The turn continues: tool call, approval, more watcher noise, final reply.
    shown = mergeLoopHistory(shown, [
      ...noise, user('make a js file'), agent('FIRST REPLY'),
      { role: 'system', content: '[System Event] File probe.js was added' },
      agent('THE FINAL REPLY AFTER APPROVAL'),
    ]);

    assert.ok(text(shown).includes('THE FINAL REPLY AFTER APPROVAL'),
      'the reply after the approval must reach the screen');
  });

  it('the same prompt asked twice is drawn twice', () => {
    // Reconciling an echo by content must happen once per echo, or asking the
    // same question again silently loses a turn.
    let shown = mergeLoopHistory([echo('again')], [user('again'), agent('r1')]);
    shown = [...shown, echo('again')];
    shown = mergeLoopHistory(shown, [user('again'), agent('r1'), user('again'), agent('r2')]);

    assert.deepEqual(text(shown), ['again', 'r1', 'again', 'r2']);
  });
});

describe('groupTurns — a turn is timed from stamps, never from the clock', () => {
  /**
   * The fallback used to be `Date.now()`, and `groupTurns` runs on every render,
   * so it moved. A turn opened by an unstamped user message got a start time
   * that crept forward while its end time stayed put, and the transcript showed
   * "Worked for -6.2s".
   */
  it('an unstamped turn reports no time rather than a wrong one', () => {
    const [turn] = groupTurns([{ role: 'user', content: 'hi' }]);
    assert.equal(turn.startTime, null);
    assert.equal(turn.endTime, null);
  });

  it('start and end come from the messages', () => {
    const [turn] = groupTurns([
      { role: 'user', content: 'hi', timestamp: 1000 },
      { role: 'agent', content: 'a', timestamp: 2500 },
      { role: 'agent', content: 'b', timestamp: 4000 },
    ]);
    assert.equal(turn.startTime, 1000);
    assert.equal(turn.endTime, 4000);
  });

  it('an unstamped opener still borrows the first stamped step', () => {
    const [turn] = groupTurns([
      { role: 'user', content: 'hi' },
      { role: 'agent', content: 'a', timestamp: 2000 },
      { role: 'agent', content: 'b', timestamp: 3000 },
    ]);
    assert.equal(turn.startTime, 2000);
    assert.equal(turn.endTime, 3000);
  });

  it('never runs backwards', () => {
    const turns = groupTurns([
      { role: 'user', content: 'one', timestamp: 1000 },
      { role: 'agent', content: 'a', timestamp: 2000 },
      { role: 'user', content: 'two', timestamp: 3000 },
      { role: 'agent', content: 'b', timestamp: 4000 },
    ]);
    for (const t of turns) assert.ok(t.endTime >= t.startTime, `${t.endTime} < ${t.startTime}`);
  });
});

/**
 * A file moving on disk is not work the agent did.
 *
 * `watcher/file-watcher.js` appends `[System Event] File X was modified`
 * turns whenever anything on disk changes, and the generic `role: 'system'`
 * branch turned every one into an action. A turn where the agent ran nothing
 * read `Worked for 8.1s · 3 actions`, and spent three rows of the live budget
 * saying one thing three times.
 */
describe('parseTurnActions — the watcher is not the agent', () => {
  const fsEvent = (path, event = 'modified') => ({
    role: 'system',
    type: 'fs_event',
    content: `[System Event] File ${path} was ${event} externally by the user.`,
  });

  it('consecutive file events fold into one action', () => {
    const { actions } = parseTurnActions({
      id: 1,
      steps: [fsEvent('CLAUDE.md'), fsEvent('src/App.jsx'), fsEvent('src/x.js', 'added')],
    });
    assert.strictEqual(actions.length, 1);
    assert.strictEqual(actions[0].type, 'fs_event');
    assert.deepStrictEqual(actions[0].paths, ['CLAUDE.md', 'src/App.jsx', 'src/x.js']);
  });

  it('but tool calls are still counted one each', () => {
    // The negative control. Folding that also folded real actions would read
    // as a working test and hide every tool call after the first.
    const steps = [1, 2, 3, 4, 5].map((i) => ({ type: 'tool_call', toolName: 'read_file', args: { i } }));
    const { actions } = parseTurnActions({ id: 1, steps });
    assert.strictEqual(actions.length, 5);
  });

  it('a file event between two tool calls does not merge them', () => {
    const { actions } = parseTurnActions({
      id: 1,
      steps: [
        { type: 'tool_call', toolName: 'read_file', args: {} },
        fsEvent('a.js'),
        { type: 'tool_call', toolName: 'grep_search', args: {} },
      ],
    });
    assert.deepStrictEqual(actions.map((a) => a.type), ['tool', 'fs_event', 'tool']);
  });

  it('two separated runs of file events stay two rows', () => {
    // Folding is on adjacency, not on being an fs_event at all — the ordering
    // is what makes a run one event.
    const { actions } = parseTurnActions({
      id: 1,
      steps: [
        fsEvent('a.js'), fsEvent('b.js'),
        { role: 'assistant', content: 'done' },
        fsEvent('c.js'),
      ],
    });
    const fs = actions.filter((a) => a.type === 'fs_event');
    assert.strictEqual(fs.length, 2);
    assert.deepStrictEqual(fs.map((a) => a.paths), [['a.js', 'b.js'], ['c.js']]);
  });

  it('the same path twice in a run is listed once', () => {
    const { actions } = parseTurnActions({
      id: 1,
      steps: [fsEvent('a.js'), fsEvent('a.js'), fsEvent('a.js')],
    });
    assert.deepStrictEqual(actions[0].paths, ['a.js']);
  });

  it('an unparseable sentence still makes a row, with no path', () => {
    // Fails to a count rather than to nothing: the tree moved, and that is
    // worth a row even when we cannot name what moved.
    const { actions } = parseTurnActions({
      id: 1,
      steps: [{ role: 'system', type: 'fs_event', content: 'something happened' }],
    });
    assert.strictEqual(actions.length, 1);
    assert.deepStrictEqual(actions[0].paths, []);
  });

  it('a path containing the word "was" survives the parse', () => {
    assert.strictEqual(
      parseFsEventPath('[System Event] File src/was/it.js was added externally by the user.'),
      'src/was/it.js',
    );
  });

  it('an ordinary system message is still a system action', () => {
    const { actions } = parseTurnActions({
      id: 1,
      steps: [{ role: 'system', content: 'ERROR PARSING TOOL CALLS' }],
    });
    assert.strictEqual(actions[0].type, 'system');
  });
});

/**
 * A write to the agent's own artifacts is drawn as what it means.
 *
 * `edit_file` on `.agent/artifacts/task.md` is the agent ticking a box — the
 * system prompt tells it to, every turn, and `isAgentArtifact` exempts it from
 * approval for that reason. Drawn with the same row as a source edit it reads
 * as an unapproved write to the user's code, which is how it was reported: two
 * `edit_file` rows on a turn that had said "don't implement anything", and
 * both of them were the checklist.
 */
describe('describeArtifactWrite', () => {
  const task = '.agent/artifacts/task.md';

  it('names the item that was ticked', () => {
    assert.deepStrictEqual(
      describeArtifactWrite('edit_file', {
        path: task,
        edits: [{ oldText: '- [ ] write the test', newText: '- [x] write the test' }],
      }),
      { verb: 'task done', detail: 'write the test' },
    );
  });

  it('counts several ticks in one call', () => {
    const d = describeArtifactWrite('edit_file', {
      path: `/Users/x/p/${task}`,
      edits: [
        { oldText: '- [ ] a', newText: '- [x] a' },
        { oldText: '- [ ] b', newText: '- [x] b' },
      ],
    });
    assert.strictEqual(d.verb, '2 tasks done');
    assert.strictEqual(d.detail, 'a · b');
  });

  it('a new checklist says how many items it has', () => {
    assert.deepStrictEqual(
      describeArtifactWrite('create_file', { path: task, content: '- [ ] a\n- [ ] b\n- [ ] c\n' }),
      { verb: 'task list written', detail: '3 items' },
    );
  });

  it('rewording an item is an update, not a tick', () => {
    // Both halves are checked — `[ ]` before and `[x]` after — because only
    // that separates finishing an item from renaming one.
    assert.deepStrictEqual(
      describeArtifactWrite('edit_file', {
        path: task,
        edits: [{ oldText: '- [ ] a', newText: '- [ ] a, but clearer' }],
      }),
      { verb: 'task.md updated', detail: '' },
    );
  });

  it('a bare task.md is the user\'s own file, not an artifact', () => {
    // `isAgentArtifact` resolves a relative path against the workspace, so
    // `task.md` at the root gets no approval exemption. The transcript must
    // not claim it as the agent's either.
    assert.strictEqual(describeArtifactWrite('edit_file', { path: 'task.md', edits: [] }), null);
    assert.strictEqual(
      describeArtifactWrite('edit_file', { path: 'docs/artifacts/task.md', edits: [] }),
      null,
    );
  });

  it('source files are left alone', () => {
    assert.strictEqual(
      describeArtifactWrite('edit_file', { path: 'server/src/ui/App.jsx', edits: [] }),
      null,
    );
    assert.strictEqual(describeArtifactWrite('read_file', { path: task }), null);
    assert.strictEqual(describeArtifactWrite('run_command', { command: 'ls' }), null);
  });

  it('another artifact says which file', () => {
    assert.deepStrictEqual(
      describeArtifactWrite('edit_file', { path: '.agent/artifacts/plan.md', edits: [] }),
      { verb: 'plan.md updated', detail: '' },
    );
  });
});

/**
 * One list, in the order things happened.
 *
 * `parseTurnActions` returned two buckets and `TranscriptTurn` drew all of
 * the first and then all of the second, so the order on screen was "tools and
 * system rows, then prose" regardless of when each occurred. It was mostly
 * invisible because local output and the model's reply are both prose and
 * kept their relative order inside one bucket — and plainly wrong the moment
 * a file changed on disk *after* the reply.
 */
describe('parseTurnActions — items are in source order', () => {
  const fsEvent = (p) => ({
    role: 'system', type: 'fs_event',
    content: `[System Event] File ${p} was modified externally by the user.`,
  });

  const mixed = {
    id: 1,
    steps: [
      { type: 'tool_call', toolName: 'read_file', args: {} },
      { type: 'tool_result', result: 'ok', success: true },
      { role: 'assistant', content: 'Here is the answer.' },
      fsEvent('CLAUDE.md'),
      { role: 'assistant', isLocal: true, content: 'effort standard' },
    ],
  };

  it('keeps every step where it happened', () => {
    const { items } = parseTurnActions(mixed);
    assert.deepStrictEqual(items.map((i) => i.type), ['tool', 'text', 'fs_event', 'text']);
  });

  it('a file event after the reply is drawn after the reply', () => {
    // The two-bucket render put every fs_event above every line of prose,
    // whenever it happened. This is the case that made it visible.
    const { items } = parseTurnActions(mixed);
    assert.ok(items.findIndex((i) => i.type === 'fs_event')
      > items.findIndex((i) => i.type === 'text'));
  });

  it('actions and finalMessages are views, not a second accumulation', () => {
    // Two lists that are supposed to agree are two lists that will one day
    // not. Every item belongs to exactly one view, and together they are the
    // whole list.
    const { items, actions, finalMessages } = parseTurnActions(mixed);
    assert.strictEqual(actions.length + finalMessages.length, items.length);
    for (const a of actions) assert.ok(items.includes(a));
    for (const f of finalMessages) assert.ok(items.includes(f));
    assert.strictEqual(actions.some((a) => finalMessages.includes(a)), false);
  });

  it('every item carries an id, so rows have stable keys', () => {
    const { items } = parseTurnActions(mixed);
    const ids = items.map((i) => i.id);
    assert.strictEqual(ids.filter(Boolean).length, ids.length, JSON.stringify(ids));
    assert.strictEqual(new Set(ids).size, ids.length, 'duplicate ids would collapse rows');
  });

  it('a thought is an item too, before the prose it preceded', () => {
    const { items } = parseTurnActions({
      id: 2,
      steps: [{ role: 'assistant', content: '<thought>weighing it up</thought>The answer.' }],
    });
    assert.deepStrictEqual(items.map((i) => i.type), ['think', 'text']);
  });
});
