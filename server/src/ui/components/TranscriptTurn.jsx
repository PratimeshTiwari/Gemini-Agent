import React from 'react';
import { Box, Text } from 'ink';
import { DiffRows } from './DiffRows.jsx';
import { rowsFromPatch } from '../diff-preview.js';
import { Dots } from './RunningLine.jsx';
import { renderMarkdown, oneLine, summarizeResult, subjectOf, clampForDisplay, formatCommandResult, blockLines, liveMessageText, fsEventRow } from '../format.js';
import { parseTurnActions, describeArtifactWrite } from '../transcript.js';

/**
 * The user's own message, shortened to fit.
 *
 * A prompt is normally one line, but it can carry an expanded paste or a long
 * Shift+Enter block, and while the turn is live that text is inside Ink's
 * repainted frame — where going over the viewport costs the scrollback. It is
 * clamped once settled too, just less hard: nobody needs to re-read four
 * hundred lines they pasted themselves.
 */
function userMessageText(content, isLive) {
  const max = isLive ? 3 : 12;
  const lines = String(content ?? '').split('\n');
  if (lines.length <= max) return content;
  return `${lines.slice(0, max).join('\n')}\n… +${lines.length - max} more lines`;
}

/**
 * One turn of the transcript: the user's message, the action rows, and the
 * agent's reply.
 *
 * Two very different jobs behind one component:
 *
 * - `isLive` — the turn still running. It lives in Ink's repainted frame, so it
 *   is capped at `liveBudget` rows: a frame taller than the viewport makes Ink
 *   clear and repaint the whole terminal on every render, which is what used to
 *   destroy the scrollback and the user's selection mid-run.
 * - committed (`isLive` false) — handed to <Static>. Written once, in full,
 *   never repainted, and from then on it is ordinary scrollback the terminal
 *   scrolls and selects like any other output. Nothing here is truncated,
 *   because this is the copy the user actually reads.
 *
 * `verbose` (ctrl+e) opens every step's raw output. Because committed rows
 * cannot be repainted, App reprints the transcript when it changes.
 */
export function TranscriptTurn({ turn, isLive, verbose, status, liveBudget, tick = 0, terminalWidth = 80, fromItem = 0 }) {
  // Only shown when it can actually be worked out. A turn whose messages were
  // never stamped has no duration, and printing one anyway is how this shipped
  // reading `Worked for -6.2s`.
  const timed = typeof turn.startTime === 'number' && typeof turn.endTime === 'number'
    && turn.endTime >= turn.startTime;
  const duration = timed ? ((turn.endTime - turn.startTime) / 1000).toFixed(1) : null;
  /*
   * One list, drawn in the order the things happened.
   *
   * `actions` and `finalMessages` are derived views over `items`, and this
   * drew all of the first and then all of the second — so a file that changed
   * on disk *after* the reply appeared above it, and so would every voice
   * added later. Measured before the change, at all five sizes: the `∙` row
   * landed ahead of the reply that preceded it, every time.
   *
   * `actions` stays, for the summary line: it counts what the agent did, which
   * is a property of the turn rather than a row in it.
   */
  const { items, actions } = parseTurnActions(turn);

  // A live turn shows its most recent steps; a committed one shows all of them.
  // Two rows of the budget go to the user's message and the "Worked for" line.
  // Over `items`, so the trim keeps the *last* things that happened rather
  // than the last non-prose ones.
  /*
   * `fromItem` is how many of this turn's rows `<Static>` already holds. Only
   * what is left is live, which since rows commit as they settle is at most the
   * newest one — so the trim below almost never bites, where before it was the
   * only thing standing between a long turn and an over-tall frame.
   */
  const pending = fromItem > 0 ? items.slice(fromItem) : items;
  const shown = isLive ? pending.slice(-Math.max(1, liveBudget - 2)) : pending;
  const hidden = pending.length - shown.length;

  /**
   * What the agent did, counted separately from what happened to it.
   *
   * A file changing on disk is not work: a turn where the watcher fired three
   * times and the agent ran nothing used to read `Worked for 8.1s · 3
   * actions`. The files are still worth a row — you want to know the tree
   * moved under the answer you are reading — they are just not the agent's.
   */
  const worked = actions.filter((a) => a.type !== 'fs_event').length;
  const touched = actions.reduce((n, a) => (a.type === 'fs_event' ? n + a.paths.length : n), 0);

  return (
    /*
     * No bottom margin on a tail. The margin separates one turn from the next,
     * and a tail whose head is already committed is not the start of anything —
     * it is the bottom of a turn `<Static>` is already holding. At 9x72 the
     * live frame has three rows to spend and that margin was one of them.
     */
    <Box flexDirection="column" marginBottom={fromItem > 0 ? 0 : 1} width="100%">
      {turn.userMsg && fromItem === 0 && (
        <UserBar content={turn.userMsg.content} isLive={isLive} terminalWidth={terminalWidth} />
      )}

      {/*
        Outside the `actions` gate. A turn that is only prose has no summary
        line, and its trimmed items would otherwise be dropped with nothing
        saying so.
      */}
      {hidden > 0 && (
        <Text dimColor>{'  '}… {hidden} earlier step{hidden === 1 ? '' : 's'} scrolled off</Text>
      )}

      {shown.map((item, idx) => (
        <TurnRow
          key={item.id}
          item={item}
          previous={shown[idx - 1]}
          isLive={isLive}
          verbose={verbose}
          liveBudget={liveBudget}
          terminalWidth={terminalWidth}
        />
      ))}

      {actions.length > 0 && (
        <TurnSummary
          isLive={isLive}
          duration={duration}
          worked={worked}
          touched={touched}
          status={status}
          tick={tick}
        />
      )}
    </Box>
  );
}

/**
 * The user's own message, as a full-width bar.
 *
 * Ink's `backgroundColor` paints the characters and not the line, so a
 * background on ordinary text stops where the words stop. `blockLines` wraps
 * and pads instead, which is the only way to get an even edge — and it has to
 * do the wrapping itself, because only the side that wraps can pad what it
 * produced.
 *
 * Its own component because it is **final the moment it is drawn**, which is
 * the property `<Static>` requires and the turn around it does not have.
 */
export function UserBar({ content, isLive, terminalWidth = 80 }) {
  return (
    <Box flexDirection="column" marginBottom={1} width="100%">
      {blockLines(userMessageText(content, isLive), terminalWidth, 2)
        .map((line, i) => (
          // eslint-disable-next-line react/no-array-index-key
          /*
           * A hex grey, not `backgroundColor="gray"`.
           *
           * The named colour is ANSI bright-black, and what a terminal paints
           * for that is entirely up to its theme — VS Code's renders it as a
           * *light* grey, so the bar came out brighter than the text it was
           * meant to sit behind and pulled the eye away from the reply. A hex
           * value is the same grey everywhere and can be chosen to sit below
           * the text rather than above it.
           *
           * Dark enough to be a background on a dark theme, and white text
           * keeps it readable on a light one, where it reads as an inverted
           * bar rather than a highlight.
           */
          <Text key={i} backgroundColor="#303030" color="white" bold>
            {i === 0 ? ' ❯ ' : '   '}{line}
          </Text>
        ))}
    </Box>
  );
}

/**
 * What the turn cost, drawn **after** the rows it is counting.
 *
 * It used to sit above them, and that is the one thing it could not do if the
 * rows are ever to be committed as they finish. `<Static>` advances on
 * `items.length` and never redraws an item, so anything handed to it has to be
 * final when written — and a header that reads `2 actions` cannot be final
 * before the second action exists. Above the rows and append-only are not both
 * available; below, it is written last with the numbers it ended on.
 *
 * While the turn runs it is the spinner, which now sits directly above the
 * input box rather than four rows up.
 */
export function TurnSummary({ isLive, duration, worked, touched, status, tick = 0 }) {
  return (
    <Text color="gray">
      {isLive ? (
        <>
          {'  '}Worked for{' '}
          <Text color="cyan"><Dots tick={tick} /> {status}</Text>
        </>
      ) : (
        <>{'  '}{duration === null ? 'Worked' : `Worked for ${duration}s`}</>
      )}
      {worked > 0 && (
        <Text dimColor> · {worked} action{worked === 1 ? '' : 's'}</Text>
      )}
      {touched > 0 && (
        <Text dimColor> · {touched} file{touched === 1 ? '' : 's'} changed on disk</Text>
      )}
    </Text>
  );
}

/**
 * One item of a turn, whichever kind it is.
 *
 * The two shapes differ in more than their content — prose sits at the margin
 * behind a `●`, everything else is indented two — so the indent moved onto the
 * row from the wrapper that used to hold all the action rows together. That
 * wrapper is what made the order impossible: it could only be in one place.
 *
 * The gap above prose is `previous`-dependent rather than "always, when the
 * turn has actions". Two consecutive replies used to get a blank row between
 * them; now a gap marks the change of voice, which is what it was for, and the
 * live frame is charged for strictly fewer rows than before — never more,
 * which is the only direction that is safe here.
 */
export function TurnRow({ item, previous, isLive, verbose, liveBudget, terminalWidth }) {
  if (item.type !== 'text') {
    return (
      <Box flexDirection="column" marginLeft={2} width="100%">
        <ActionRow act={item} verbose={verbose} isLive={isLive} width={terminalWidth} />
      </Box>
    );
  }

  return (
    <Box
      flexDirection="row"
      marginTop={previous && previous.type !== 'text' ? 1 : 0}
      width="100%"
    >
      {!item.msg.isLocal && <Text color="green">● </Text>}
      <Box flexGrow={1} flexShrink={1}>
        {/*
          Clamped while live and whole once committed — the reply is the
          tallest row there is, and `items.slice` above counts it as one.
          See `liveMessageText`.
        */}
        <Text wrap="wrap">
          {isLive
            ? liveMessageText(renderMarkdown(item.content, terminalWidth), liveBudget, terminalWidth)
            : renderMarkdown(item.content, terminalWidth)}
        </Text>
      </Box>
    </Box>
  );
}

/**
 * The diff for an edit, if this step is one and carries a patch.
 *
 * `edit_file` and `create_file` return `patch` — the whole unified diff —
 * alongside hunks trimmed to a ten-line preview. The trimmed hunks are what
 * keeps the model's copy of the result small; the patch is what makes the
 * transcript readable. Parsing it here costs nothing at the source.
 *
 * @returns {JSX.Element|null} null when this is not an edit, so the caller can
 *                             fall through to its other shapes
 */
function diffRowsFor(act) {
  if (act.toolName !== 'edit_file' && act.toolName !== 'create_file') return null;
  const patch = act.result?.patch;
  if (typeof patch !== 'string' || !patch) return null;

  const rows = rowsFromPatch(patch, { maxLines: 24 });
  if (rows.length === 0) return null;
  return <DiffRows rows={rows} />;
}

/**
 * How much of one step's output may be drawn.
 *
 * Only the **live** turn has to fit the viewport. It is in the frame Ink
 * repaints, and a frame taller than the terminal is answered with
 * `ESC[2J ESC[3J` and a full repaint on every render — the flicker-and-cannot-
 * scroll bug. A **committed** step is `<Static>` output: written once, never
 * repainted, ordinary scrollback the terminal scrolls and selects like any
 * other command's. It does not need a cap, and capping it is why expanding a
 * step that finished ten minutes ago still ended in `... [truncated]` with
 * nothing you could do about it.
 *
 * Collapsed rows stay short either way — that is the summary, not the output.
 */
const limitsFor = (isLive, verbose) => {
  if (!verbose) return { lines: 6, chars: 400 };
  return isLive ? { lines: 20, chars: 1200 } : { lines: Infinity, chars: Infinity };
};

/** One step inside a turn. Collapsed to a line unless `verbose`. */
function ActionRow({ act, verbose, isLive, width = 80 }) {
  const limit = limitsFor(isLive, verbose);
  /*
   * The subject is budgeted against the real terminal width, not a constant.
   *
   * This row had no `wrap` at all, so it could already wrap — and a row that
   * wraps is charged as one and drawn as two, which is the bug this frame has
   * had twice. Naming the file makes it longer, so the width has to come in.
   *
   * Two columns for the glyph, the tool name, the separator and the summary;
   * whatever is left over is the subject's, and `wrap="truncate"` is the
   * backstop for the summary, which is not bounded here.
   */
  const subjectRoom = Math.max(12, width - String(act.toolName || '').length - 28);
  if (act.type === 'tool') {
    /**
     * A write to the agent's own artifacts is drawn as what it means.
     *
     * `⏺ edit_file` on `.agent/artifacts/task.md` is the agent ticking a box —
     * which the system prompt tells it to do every turn — and it is exempt
     * from approval for that reason. Drawn with the same row as a source edit
     * it reads as an unapproved write to the user's code, which is exactly how
     * it was reported: two `edit_file` rows on a turn that had said "don't
     * implement", both of them the checklist.
     */
    const artifact = act.success !== false && describeArtifactWrite(act.toolName, act.args);
    if (artifact) {
      return (
        <Text wrap="truncate">
          <Text color="green">{'✓ '}</Text>
          <Text color="gray">{artifact.verb}</Text>
          {artifact.detail ? <Text dimColor> · {artifact.detail}</Text> : null}
        </Text>
      );
    }
    return (
      <Box flexDirection="column" width="100%">
        <Box flexDirection="row">
          <Text color={act.success === false ? 'red' : 'green'}>{(act.success === false ? '✗' : '⏺') + ' '}</Text>
          <Text bold color="gray">{act.toolName}</Text>
          {/* Which file, which pattern, which command. Without it two reads in
              one turn are the same row twice, which is how a turn reading four
              files reads as a turn that did nothing in particular. */}
          {subjectOf(act.toolName, act.args, subjectRoom) ? (
            <Text color="gray" wrap="truncate">
              {' '}{subjectOf(act.toolName, act.args, subjectRoom)}
            </Text>
          ) : null}
          <Text dimColor wrap="truncate"> · {summarizeResult(act.toolName, act.result)}</Text>
        </Box>
        {verbose && act.result !== null && act.result !== undefined && (
          <Box paddingLeft={2} width="100%">
            {/* An edit gets diff shape, a shell result gets shell shape, and
                everything else falls back to the generic clamp. The diff
                renderer existed only on the approval prompt, so the one place a
                change could be read in colour was the moment before it was
                applied — and the transcript, which is what you read afterwards
                and days later, showed it as a line of dim text. */}
            {diffRowsFor(act) ?? (
              <Text dimColor wrap="wrap">
                {formatCommandResult(act.result, limit.lines)
                  ?? clampForDisplay(act.result, limit.lines, limit.chars)}
              </Text>
            )}
          </Box>
        )}
      </Box>
    );
  }

  if (act.type === 'tool_result') {
    return (
      <Box flexDirection="column" width="100%">
        <Text color="green">{'⏺ '}<Text dimColor>{oneLine(act.result)}</Text></Text>
        {verbose && (
          <Box paddingLeft={2} width="100%">
            <Text dimColor wrap="wrap">{clampForDisplay(act.result, limit.lines, limit.chars)}</Text>
          </Box>
        )}
      </Box>
    );
  }

  if (act.type === 'think') {
    const lineCount = act.content.split('\n').length;
    return (
      <Box flexDirection="column" width="100%">
        <Text dimColor>✻ Thinking… ({lineCount} line{lineCount === 1 ? '' : 's'})</Text>
        {verbose && (
          <Box paddingLeft={2} width="100%">
            {/* Thinking had no cap at all, so one long block in a running turn
                could push the live frame past the viewport on its own. */}
            <Text dimColor wrap="wrap">{clampForDisplay(act.content, limit.lines, limit.chars)}</Text>
          </Box>
        )}
      </Box>
    );
  }

  if (act.type === 'command_output') {
    return (
      <Box width="100%">
        <Text dimColor wrap="wrap">{clampForDisplay(act.content, limit.lines, limit.chars)}</Text>
      </Box>
    );
  }

  if (act.type === 'fs_event') {
    /**
     * One row, however many files, and never prose.
     *
     * The watcher's own sentence is 70 characters for one path; three of them
     * filled a quarter of a short terminal to say the same thing three times.
     * `wrap="truncate"` because this is drawn in the live frame and a row
     * that wraps is charged as one and drawn as two.
     *
     * The wording is `fsEventRow`, in `format.js`, because that is where a
     * test can reach it — the same reason `liveMessageText` lives there.
     */
    return (
      <Text dimColor wrap="truncate">{fsEventRow(act.paths)}</Text>
    );
  }

  if (act.type === 'system') {
    return (
      <Box width="100%">
        <Text dimColor wrap="wrap">{act.content ?? act.msg?.content}</Text>
      </Box>
    );
  }

  if (act.type === 'image') {
    return <Text dimColor>∙ Attached image: {act.content}</Text>;
  }

  return null;
}
