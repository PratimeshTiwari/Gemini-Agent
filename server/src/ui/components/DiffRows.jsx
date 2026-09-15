import React from 'react';
import { Box, Text } from 'ink';

/**
 * A unified diff, drawn.
 *
 * This existed already, inline in the approval prompt, and only there — so the
 * one place you could see a change in colour was the moment *before* it was
 * applied. Afterwards the transcript showed the same edit as a line of dim
 * generic text, which is the wrong way round: the approval prompt has the file
 * name and the risk line to go on, and the transcript, read later, has nothing.
 *
 * Colours are the palette's, not new ones: green is "a step succeeded" and red
 * is "a step failed", which is exactly what an added and a removed line are
 * claiming. Context is `dimColor` — structure — and the `@@` header is accent.
 *
 * The line-number gutter is off by default. It earns its width when you are
 * deciding whether to approve something, and wastes it in a transcript row that
 * is already indented under a tool name.
 */
const COLOUR = { add: 'green', del: 'red', header: 'cyan' };

export function DiffRows({ rows, gutter = false, dimContext = true }) {
  if (!rows || rows.length === 0) return null;

  // One width for every number, so the text starts in the same column on every
  // row. A gutter that moves is worse than no gutter.
  const width = gutter
    ? String(Math.max(1, ...rows.map((r) => Math.max(r.oldNo ?? 0, r.newNo ?? 0)))).length
    : 0;

  return (
    <Box flexDirection="column">
      {rows.map((row, i) => (
        <Text
          key={i}
          wrap="truncate"
          dimColor={row.type === 'more' || (dimContext && row.type === 'ctx')}
          color={COLOUR[row.type]}
        >
          {gutter && (
            <Text dimColor>
              {/* The side that moved. A removed line has no new number and an
                  added line has no old one, so showing both would be two
                  columns of mostly blanks. */}
              {String(row.newNo ?? row.oldNo ?? '').padStart(width)}
              {'  '}
            </Text>
          )}
          {row.text}
        </Text>
      ))}
    </Box>
  );
}
