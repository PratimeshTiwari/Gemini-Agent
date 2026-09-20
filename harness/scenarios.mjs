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
    // The row names the files; the *count* belongs to the summary line above
    // it, which already reads `· 3 files changed on disk`. It used to say both
    // — `∙ 3 files changed on disk — one.txt, …` — four rows apart. The `∙`
    // in `absent` is what separates the row from that summary, so this fails
    // against the old wording and passes against the new.
    expect: ['WATCHED', '∙ changed on disk — '],
    // `files changed on disk — ` is the old row exactly: `∙ 3 files changed on
    // disk — one.txt, …`. The summary line keeps the count and ends there, so
    // the em-dash is what tells the two apart — and unlike a filename it does
    // not depend on the watcher's ordering or on where a 72-column row
    // truncates, both of which vary run to run.
    absent: ['3 actions', 'was modified externally', 'files changed on disk — '],
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
    // The positive control for the fresh-chat rule below: an artifact the
    // agent wrote *this* session must still reach the panel.
    expect: ['task list written', 'review.md written', 'task done', 'read it',
             'ctrl+g to expand'],
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
  {
    name: 'plan mode offers the mode switch on the diff, not as a banner',
    // The model asked in prose — "Ready to exit PLAN MODE?" — which spends a
    // turn on a question no keypress can answer. The same question belongs on
    // the screen that enforces the mode, where the user can see the change.
    replies: [
      'Working.\n\n```json\n' + JSON.stringify({
        name: 'create_file',
        args: { path: 'switch.js', content: 'const a = 1;\n' },
      }) + '\n```',
      'WRITTEN after the switch.',
    ],
    steps: [
      { send: 'make a file\r' },
      { wait: 'stop asking', timeout: 40 },
      { key: 'down' },
      { key: 'down' },
      { send: '\r' },
      { wait: 'WRITTEN', timeout: 40 },
    ],
    expect: ['Approve, and stop asking', 'WRITTEN'],
    wrote: 'switch.js',
    rows: 24, cols: 90,
    maxClears: 0,
  },
  {
    name: 'a fresh chat does not show the last one\'s task list',
    // The panel reads the files off disk and they outlive the conversation,
    // so a brand-new chat drew the previous session's review.md — a lie in
    // the one place that is supposed to say what the agent is doing now.
    replies: ['NOTHING to do yet.'],
    steps: [
      { seed: { '.agent/artifacts/task.md': '- [ ] left over from last time\n' } },
      { send: 'hello\r' },
      { wait: 'NOTHING to do', timeout: 30 },
    ],
    // On the panel's own marker, not on the file's text: collapsed, the row
    // shows only the filename, so asserting the *content* was absent proved
    // nothing — the negative control passed with the fix removed.
    expect: ['NOTHING to do'],
    absent: ['ctrl+g to expand'],
    rows: 24, cols: 90,
    maxClears: 0,
  },
  {
    name: 'a filtered settings list pads to what it is showing',
    // `width` was measured over every row and applied to the filtered ones, so
    // narrowing to one short setting still spaced it for `Command rules` — the
    // widest label in the set. That is where `Effort              standard`
    // came from: a gap wide enough to read as a missing column, on the one
    // screen whose whole job is showing what is set to what.
    replies: [],
    steps: [
      { send: '/settings\r' },
      { wait: 'Settings   Status', timeout: 20 },
      { send: 'effort' },
      { wait: '⌕ effort', timeout: 10 },
    ],
    // `expect` alone, and deliberately: the *unfiltered* list is in this same
    // transcript a moment earlier and pads to 13 perfectly correctly, so an
    // `absent` on wide padding would fail on the right behaviour. Three spaces
    // after a six-character label is a width the old code could not produce
    // at all — it measured every row, always.
    expect: ['Effort   pro'],
    rows: 24, cols: 90,
    maxClears: 0,
  },
  {
    name: 'the agent name is edited in place, not printed at you',
    // The row ran `/name`, and `/name` with no argument prints the current
    // name — so the one row that reads as directly editable was the one that
    // could not be edited, and its answer landed in the transcript behind the
    // page. `absent` carries both halves: that printout is the old behaviour
    // *and* the thing `applyAndReturn` exists to prevent.
    replies: [],
    steps: [
      { send: '/settings\r' },
      { wait: 'Settings   Status', timeout: 20 },
      { send: 'agent name' },
      { wait: 'Agent name', timeout: 10 },
      { send: '\r' },
      { wait: 'enter save', timeout: 10 },
      { send: 'Nova' },
      { wait: 'Nova', timeout: 10 },
      { send: '\r' },
      { wait: 'Agent name   Nova', timeout: 10 },
    ],
    expect: ['Agent name   Nova'],
    absent: ['The agent is called'],
    rows: 24, cols: 90,
    maxClears: 0,
  },
  {
    name: 'a turn draws its prose and its tools in the order they happened',
    // Phase 4.1. `parseTurnActions` returned `actions` and `finalMessages`,
    // and the renderer drew all of the first and then all of the second — so
    // a reply that came *before* a tool call was drawn after it, and every
    // voice added later inherited the same ordering. One reply, one tool, one
    // reply is the smallest turn where that is visible at all.
    replies: [
      'Looking at it.\n\n```json\n' + JSON.stringify({
        name: 'read_file', args: { path: 'a.txt' },
      }) + '\n```',
      'DONE — one line, and nothing else references it.',
    ],
    steps: [
      { seed: { 'a.txt': 'hello\n' } },
      { send: 'what is in a.txt\r' },
      { wait: 'DONE', timeout: 40 },
    ],
    expect: ['Looking at it.', 'read_file a.txt', 'DONE — one line'],
    // Both pairs flip under the old renderer, which drew the tool row first
    // and then both replies.
    order: [
      ['Looking at it.', 'read_file a.txt'],
      ['read_file a.txt', 'DONE — one line'],
    ],
    rows: 24, cols: 90,
    maxClears: 0,
  },
  {
    name: 'a tall terminal draws the transcript once, not once per tool round',
    /*
     * Reported from use at 210x64: the banner, the prompt and the whole turn
     * printed three times, each copy further along than the last; resizing
     * small and back fixed it. `<Static>` was handed a *turn*, a turn grows
     * while the loop runs, and the only repair for a grown Static item is
     * remounting it — which reprints everything *below* what is already on
     * screen, because Ink cannot un-write. On a short terminal the old copies
     * scroll away and it looks like it worked.
     *
     * 64 rows is the point of the scenario: nothing scrolls off, so every copy
     * is counted. Two tool rounds, because it duplicated once per round.
     */
    replies: [
      'First, the directory.\n\n```json\n' + JSON.stringify({
        name: 'list_directory', args: { path: '.' },
      }) + '\n```',
      'Now the file.\n\n```json\n' + JSON.stringify({
        name: 'read_file', args: { path: 'a.txt' },
      }) + '\n```',
      'DONE — one line, nothing else references it.',
    ],
    steps: [
      { seed: { 'a.txt': 'hello\n' } },
      { send: 'what is in a.txt\r' },
      { wait: 'DONE', timeout: 90 },
    ],
    expect: ['DONE — one line'],
    /*
     * The banner, and only the banner. Everything else in a turn is drawn in
     * the live frame before it commits, and a live row is rewritten on every
     * repaint — the prompt bar counts 6x on a correct run. The banner is never
     * live, so the only thing that can write it twice is `<Static>` printing
     * the transcript again, which is the bug. It counted 3x here.
     */
    counts: { 'Developed by': 1 },
    rows: 64, cols: 210,
    maxClears: 0,
  },
  {
    name: 'ask_subagent runs a second session and its answer comes back',
    /*
     * The one tool never verified end to end — the handoff has said so for
     * days, on the grounds that it needs a real browser. It does not: a
     * subagent turn is an ordinary `inject_prompt` carrying `isSubagent` and
     * its own `requestId`, and the fake extension already echoes both. What it
     * needs is the replies sequenced across two sessions.
     *
     * Three scripted replies, in the order the loop asks for them:
     *   1. main       — delegates
     *   2. subagent   — answers with `return_result`
     *   3. main       — reports what came back
     *
     * `CLAUDE.md` records a fake extension that answered subagent requests
     * *without* `isSubagent` and hung compaction, so the echo is load-bearing
     * and this scenario is also its regression test.
     */
    replies: [
      'Delegating the read.\n\n```json\n' + JSON.stringify({
        name: 'ask_subagent',
        args: { role: 'research', prompt: 'What is in a.txt? Answer in one line.' },
      }) + '\n```',
      'Read it.\n\n```json\n' + JSON.stringify({
        name: 'return_result',
        args: { result: 'SUBAGENT SAYS the file holds one line.' },
      }) + '\n```',
      'DELEGATION DONE — the subagent reported one line.',
    ],
    steps: [
      { seed: { 'a.txt': 'hello\n' } },
      { send: 'ask a subagent what is in a.txt\r' },
      { wait: 'DELEGATION DONE', timeout: 90 },
    ],
    expect: ['ask_subagent', 'DELEGATION DONE'],
    // The turn must not end on the failure path `CLAUDE.md` describes, where a
    // reviewer that answers in prose has its whole answer thrown away.
    absent: ['Subagent failed to use the return_result tool'],
    rows: 30, cols: 100,
    maxClears: 0,
  },
  {
    name: 'the prompt bar is drawn once, not once per repaint',
    /*
     * Reported from use with a screenshot: two identical `❯ can you list files`
     * rows on screen while the turn was still at "Analyzing syntax… (7s)".
     *
     * A regression from handing `<Static>` rows instead of turns. The bar is
     * committed the moment the turn exists, but `TranscriptTurn` decided
     * whether to draw it from `fromItem === 0` — and `fromItem` only moves when
     * the first *row* settles. Between those two, which is the whole thinking
     * phase, both the committed copy and the live one were drawn.
     *
     * A slow reply is the point: the window only exists while the turn has a
     * user message and no rows yet. Measured before the fix, **8** bars
     * co-resident in one frame and 68 writes; after, 1 and 1.
     *
     * Unlike the banner count, this one is exact rather than a floor — a
     * committed row is written once and never repainted, so any number above
     * one is the live frame drawing it again.
     */
    replies: ['SLOW REPLY.'],
    delayMs: 5000,
    steps: [
      { send: 'can you list files\r' },
      { wait: 'SLOW REPLY', timeout: 40 },
    ],
    expect: ['SLOW REPLY'],
    counts: { '❯ can you list files': 1 },
    rows: 24, cols: 90,
    maxClears: 0,
  },
  {
    name: 'a browser on the wrong model says so, and how to fix it',
    /*
     * Reported from use with a screenshot: the status bar read **PRO** while
     * the Gemini tab's picker read **Flash** — a pro-tier prompt typed into a
     * Flash tab, which `CLAUDE.md` names as the worst case, the long prompt to
     * the model that handles long prompts worst. Nothing said so.
     *
     * Both names, because "wrong model" without saying which is a warning you
     * cannot act on, and the key that shows the tab, so the row carries the fix
     * rather than only the complaint.
     */
    replies: ['HI THERE.'],
    models: [
      { label: '3.8 Flash', selected: true },
      { label: '3.1 Pro', description: 'reasoning' },
    ],
    steps: [
      { send: '/effort pro\r' },
      { wait: 'ctrl+b shows the tab', timeout: 20 },
    ],
    expect: ['⚠ browser is on 3.8 Flash', 'this rung wants 3.1 Pro', 'ctrl+b shows the tab'],
    rows: 24, cols: 100,
    maxClears: 0,
  },
  {
    name: 'a browser on the right model says nothing at all',
    // The control, and the one that matters: a warning that fires when there is
    // nothing wrong is one people learn to dismiss, at which point it costs
    // more than the mismatch it exists to catch.
    replies: ['HI THERE.'],
    models: [
      { label: '3.1 Pro', description: 'reasoning', selected: true },
      { label: '3.8 Flash' },
    ],
    steps: [
      { send: 'hello\r' },
      { wait: 'HI THERE', timeout: 30 },
    ],
    expect: ['HI THERE'],
    absent: ['browser is on', 'ctrl+b shows the tab'],
    rows: 24, cols: 100,
    maxClears: 0,
  },
];
