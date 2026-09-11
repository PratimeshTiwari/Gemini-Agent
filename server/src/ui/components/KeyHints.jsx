import React from 'react';
import { Box, Text } from 'ink';

/**
 * A row of keyboard hints.
 *
 * Written as a component because the hand-built version read as prose:
 *
 *     ↑↓ move · space expand · enter open plan · a avoid words · p PRs
 *
 * With one separator doing two jobs — between a key and its label, and between
 * pairs — "a avoid words" parses as a sentence rather than as a key bound to an
 * action, and the eye cannot find the keys at all. Colour separates the key
 * from the label, and the gap between pairs is wider than the gap inside one.
 *
 * @param {{ hints: Array<[string, string]> }} props - [key, what it does]
 */
export function KeyHints({ hints }) {
  return (
    <Box flexDirection="row" flexWrap="wrap">
      {hints.map(([key, label], i) => (
        <Text key={key + label}>
          {i > 0 ? <Text dimColor>{'  ·  '}</Text> : null}
          <Text color="cyan">{key}</Text>
          <Text dimColor> {label}</Text>
        </Text>
      ))}
    </Box>
  );
}
