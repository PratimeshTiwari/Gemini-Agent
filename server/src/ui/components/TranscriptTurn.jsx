import React from 'react';
import { Box, Text } from 'ink';
import { DiffRows } from './DiffRows.jsx';
import { rowsFromPatch } from '../diff-preview.js';
import { Dots } from './RunningLine.jsx';
import { renderMarkdown, oneLine, summarizeResult, clampForDisplay, formatCommandResult, blockLines } from '../format.js';
import { parseTurnActions } from '../transcript.js';

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
export function TranscriptTurn({ turn, isLive, verbose, status, liveBudget, tick = 0, terminalWidth = 80 }) {
  // Only shown when it can actually be worked out. A turn whose messages were
  // never stamped has no duration, and printing one anyway is how this shipped
  // reading `Worked for -6.2s`.
  const timed = typeof turn.startTime === 'number' && typeof turn.endTime === 'number'
    && turn.endTime >= turn.startTime;
  const duration = timed ? ((turn.endTime - turn.startTime) / 1000).toFixed(1) : null;
  const { actions, finalMessages } = parseTurnActions(turn);

  // A live turn shows its most recent steps; a committed one shows all of them.
  // Two rows of the budget go to the user's message and the "Worked for" line.
  const shown = isLive ? actions.slice(-Math.max(1, liveBudget - 2)) : actions;
  const hidden = actions.length - shown.length;

  return (
    <Box flexDirection="column" marginBottom={1} width="100%">
      {/*
        The user's own message, as a full-width bar.

        Ink's `backgroundColor` paints the characters and not the line, so a
        background on ordinary text stops where the words stop. `blockLines`
        wraps and pads instead, which is the only way to get an even edge — and
        it has to do the wrapping itself, because only the side that wraps can
        pad what it produced.

        The row count is unchanged: Ink was wrapping this text to the same
        width anyway. What is new is that we know the count, rather than
        inferring it.
      */}
      {turn.userMsg && (
        <Box flexDirection="column" marginBottom={1} width="100%">
          {blockLines(userMessageText(turn.userMsg.content, isLive), terminalWidth, 2)
            .map((line, i) => (
              // eslint-disable-next-line react/no-array-index-key
              /*
               * A hex grey, not `backgroundColor="gray"`.
               *
               * The named colour is ANSI bright-black, and what a terminal
               * paints for that is entirely up to its theme — VS Code's renders
               * it as a *light* grey, so the bar came out brighter than the text
               * it was meant to sit behind and pulled the eye away from the
               * reply. A hex value is the same grey everywhere and can be chosen
               * to sit below the text rather than above it.
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
      )}

      {actions.length > 0 && (
        <Box flexDirection="column" width="100%">
          <Text color="gray">
            {isLive ? (
              <>
                {'  '}Worked for{' '}
                <Text color="cyan"><Dots tick={tick} /> {status}</Text>
              </>
            ) : (
              <>{'  '}{duration === null ? 'Worked' : `Worked for ${duration}s`}</>
            )}
            <Text dimColor> · {actions.length} action{actions.length === 1 ? '' : 's'}</Text>
          </Text>

          {hidden > 0 && (
            <Text dimColor>{'  '}… {hidden} earlier step{hidden === 1 ? '' : 's'} scrolled off</Text>
          )}

          <Box flexDirection="column" marginLeft={2} width="100%">
            {shown.map((act) => <ActionRow key={act.id} act={act} verbose={verbose} isLive={isLive} />)}
          </Box>
        </Box>
      )}

      {finalMessages.map((fm, idx) => (
        <Box key={idx} flexDirection="row" marginTop={actions.length > 0 ? 1 : 0} width="100%">
          {!fm.msg.isLocal && <Text color="green">● </Text>}
          <Box flexGrow={1} flexShrink={1}>
            <Text wrap="wrap">{renderMarkdown(fm.content)}</Text>
          </Box>
        </Box>
      ))}
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
function ActionRow({ act, verbose, isLive }) {
  const limit = limitsFor(isLive, verbose);
  if (act.type === 'tool') {
    return (
      <Box flexDirection="column" width="100%">
        <Box flexDirection="row">
          <Text color={act.success === false ? 'red' : 'green'}>{(act.success === false ? '✗' : '⏺') + ' '}</Text>
          <Text bold color="gray">{act.toolName}</Text>
          <Text dimColor> · {summarizeResult(act.toolName, act.result)}</Text>
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
