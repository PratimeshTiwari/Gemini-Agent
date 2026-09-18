/**
 * What a turn is supposed to do, end to end, with no browser.
 *
 * Every bug found by hand this session was a scenario nobody could run. Each
 * one below is a bug that reached the user first: a reply that never drew, a
 * prompt silently discarded, a file written without approval.
 *
 * `expect` strings must appear in the terminal output; `absent` must not.
 * `maxClears` is the frame budget — a full clear wipes the scrollback, so the
 * answer is almost always 0. `reply` entries are what the fake model says, in
 * order, and `delayMs` is how long it pretends to think.
 */
const toolCall = (path, content) =>
  'Working on it.\n\n```json\n' + JSON.stringify({ name: 'create_file', args: { path, content } }) + '\n```';

export const SCENARIOS = [
  {
    name: 'a plain turn renders its reply',
    replies: ['THE ANSWER is here.'],
    steps: [{ send: 'hello\r' }, { wait: 'THE ANSWER', timeout: 30 }],
    expect: ['THE ANSWER'],
    maxClears: 0,
  },
  {
    name: 'approving a write shows the reply that follows it',
    // The reply after an approval landed in a group <Static> had already
    // printed, so it could never be drawn. Reported as "file created, diff
    // showed, then nothing".
    replies: [toolCall('probe.js', 'const a = 1;\n'), 'AFTER APPROVAL is here.'],
    steps: [{ send: 'make a file\r' }, { wait: 'Approve' }, { send: '\r' },
            { wait: 'AFTER APPROVAL', timeout: 40 }],
    expect: ['Approve', 'AFTER APPROVAL'],
    wrote: 'probe.js',
    maxClears: 0,
  },
  {
    name: 'rejecting a write leaves the file alone',
    replies: [toolCall('nope.js', 'should not exist\n'), 'REJECTED and understood.'],
    steps: [{ send: 'make a file\r' }, { wait: 'Approve' },
            { key: 'down' }, { send: '\r' }, { wait: 'REJECTED', timeout: 40 }],
    expect: ['REJECTED'],
    didNotWrite: 'nope.js',
    maxClears: 0,
  },
  {
    name: 'plan mode asks before writing a markdown file',
    // It did not: the exemption keyed on the extension rather than the
    // location, so any .md was written with no approval.
    replies: [toolCall('notes.md', '# hello\n'), 'DONE writing.'],
    steps: [{ send: 'write notes\r' }, { wait: 'Approve', timeout: 30 }],
    expect: ['Approve'],
    // The CLI has no --auto flag; plan is the only mode it starts in, which
    // is why every write scenario here meets the approval prompt.
    maxClears: 0,
  },
  {
    name: 'prompts typed during a turn are queued, not dropped',
    // Four prompts typed, one reply. handleUserMessage returned early and
    // discarded the rest after the box had already been cleared.
    replies: ['FIRST done.', 'SECOND done.'],
    steps: [{ send: 'one\r', quiet: 0 }, { send: 'two\r', quiet: 0 },
            { wait: 'queued', timeout: 15 }, { wait: 'SECOND done', timeout: 50 }],
    expect: ['queued', 'FIRST done', 'SECOND done'],
    delayMs: 4000,
    maxClears: 0,
  },
  {
    name: 'a long reply does not blow the frame on a short terminal',
    // The live frame must never outgrow the viewport: when it does, Ink
    // clears and repaints on every render and the scrollback goes with it.
    replies: [Array.from({ length: 40 }, (_, i) => `line ${i + 1} of a long answer`).join('\n')],
    steps: [{ send: 'say a lot\r' }, { wait: 'line 1 of', timeout: 30 }],
    expect: ['line 1 of'],
    rows: 14, cols: 72,
    maxClears: 0,
  },
  {
    name: 'files changing on disk are one row, not one row each',
    // The watcher's turns were counted as agent actions, so a turn where the
    // agent ran nothing read `Worked for 8.1s · 3 actions` and spent three
    // rows of the live budget saying one thing three times.
    replies: ['WATCHED and answered.'],
    steps: [
      { touch: ['one.txt', 'two.txt', 'three.txt'] },
      { send: 'what changed\r' },
      { wait: 'WATCHED', timeout: 30 },
    ],
    expect: ['WATCHED'],
    absent: ['3 actions', 'was modified externally'],
    rows: 14, cols: 72,
    maxClears: 0,
  },
  {
    name: 'the task panel opens on its own key without clearing',
    replies: [
      'Working on it.\n\n```json\n' + JSON.stringify({
        name: 'create_file',
        args: {
          path: '.agent/artifacts/task.md',
          content: '- [x] read the file\n- [x] find the caller\n- [ ] write the test\n'
            + '- [ ] run the suite\n- [ ] check the frame budget\n- [ ] update the docs\n',
        },
      }) + '\n```',
      'TASK LIST written.',
    ],
    steps: [
      { send: 'make a task list\r' },
      { wait: 'TASK LIST', timeout: 40 },
      { send: '\u0007' },
      { wait: 'read the file', timeout: 10 },
      { send: '\u0007' },
    ],
    // The header answers the question without being opened, and the body
    // appears on ctrl+g — with no clear, because the panel is in the live
    // frame and needs no reprint. ctrl+e used to be the only way in, and it
    // reprints the whole transcript.
    // Two body rows is all a 13-row terminal can spare, and the panel says
    // so rather than drawing six and blowing the frame.
    expect: ['TASK LIST', '2/6 done', 'read the file', '+4 more'],
    rows: 13, cols: 80,
    maxClears: 0,
  },
  {
    name: 'ticking the checklist does not look like editing your code',
    // Reported after "do everything but don't implement": two `⏺ edit_file`
    // rows on a read-only turn, both of them the agent ticking its own box.
    replies: [
      'Working.\n\n```json\n' + JSON.stringify({
        name: 'create_file',
        args: { path: '.agent/artifacts/task.md', content: '- [ ] read it\n- [ ] verify it\n' },
      }) + '\n```',
      'And the checks.\n\n```json\n' + JSON.stringify({
        name: 'create_file',
        args: { path: '.agent/artifacts/review.md', content: '- [ ] npm test passes\n' },
      }) + '\n```',
      'Ticking.\n\n```json\n' + JSON.stringify({
        name: 'edit_file',
        args: {
          path: '.agent/artifacts/task.md',
          edits: [{ oldText: '- [ ] read it', newText: '- [x] read it' }],
        },
      }) + '\n```',
      'READ AND VERIFIED.',
    ],
    steps: [
      { send: 'read and verify only\r' },
      { wait: 'READ AND VERIFIED', timeout: 50 },
    ],
    expect: ['task list written', 'review.md written', 'task done', 'read it'],
    absent: ['⏺ edit_file'],
    rows: 24, cols: 90,
    maxClears: 0,
  },
  {
    name: 'a table fits the terminal instead of wrapping its own borders',
    // `cli-table3` sizes to content and ignores its width option: measured at
    // 158 visible columns on a three-column table, whatever the terminal was.
    replies: [
      'Here is the check:\n\n'
      + '| Review Item | Task Status | Verdict |\n'
      + '| --- | --- | --- |\n'
      + '| Direct text fallback in `agent-loop.js` | Task 2: root-cause verification |'
      + ' Verified: inspected lines 1929-1951 and confirmed the early exit. |\n'
      + '| Tool boundary integrity | Task 3: registry audit | Confirmed in `mcp-server.js`. |\n',
    ],
    steps: [{ send: 'compare them\r' }, { wait: 'Verdict', timeout: 30 }],
    // A wrapped border shows up as a corner glyph with nothing before it on
    // the line; the box characters are the assertion that one was drawn at all.
    expect: ['┌', '│ Review Item', '└'],
    rows: 24, cols: 90,
    maxClears: 0,
  },
];
