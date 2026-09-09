import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { renderMarkdown, oneLine, summarizeResult, clampForDisplay } from '../format.js';
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
export function TranscriptTurn({ turn, isLive, verbose, status, liveBudget }) {
  const duration = ((turn.endTime - turn.startTime) / 1000).toFixed(1);
  const { actions, finalMessages } = parseTurnActions(turn);

  // A live turn shows its most recent steps; a committed one shows all of them.
  // Two rows of the budget go to the user's message and the "Worked for" line.
  const shown = isLive ? actions.slice(-Math.max(1, liveBudget - 2)) : actions;
  const hidden = actions.length - shown.length;

  return (
    <Box flexDirection="column" marginBottom={1} width="100%">
      {turn.userMsg && (
        <Box marginBottom={1} width="100%">
          <Text bold wrap="wrap">
            <Text color="white">❯</Text> {userMessageText(turn.userMsg.content, isLive)}
          </Text>
        </Box>
      )}

      {actions.length > 0 && (
        <Box flexDirection="column" width="100%">
          <Text color="gray">
            {'  '}Worked for{' '}
            {isLive
              ? <Text color="cyan"><Spinner type="dots" /> {status}</Text>
              : <Text>{duration}s</Text>}
            <Text dimColor> · {actions.length} action{actions.length === 1 ? '' : 's'}</Text>
          </Text>

          {hidden > 0 && (
            <Text dimColor>{'  '}… {hidden} earlier step{hidden === 1 ? '' : 's'} scrolled off</Text>
          )}

          <Box flexDirection="column" marginLeft={2} width="100%">
            {shown.map((act) => <ActionRow key={act.id} act={act} verbose={verbose} />)}
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

/** One step inside a turn. Collapsed to a line unless `verbose`. */
function ActionRow({ act, verbose }) {
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
            <Text dimColor wrap="wrap">{clampForDisplay(act.result, 20)}</Text>
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
            <Text dimColor wrap="wrap">{clampForDisplay(act.result, 20)}</Text>
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
            <Text dimColor wrap="wrap">{act.content}</Text>
          </Box>
        )}
      </Box>
    );
  }

  if (act.type === 'command_output') {
    return (
      <Box width="100%">
        <Text dimColor wrap="wrap">{clampForDisplay(act.content, verbose ? 40 : 6, verbose ? 4000 : 400)}</Text>
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
