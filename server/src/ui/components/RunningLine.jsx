import React from 'react';
import { Text } from 'ink';

/**
 * The one row that says the agent is working.
 *
 * It replaces `ink-spinner` on this line rather than sitting next to it, and
 * that is the whole design constraint. `ink-spinner` drives a state update
 * every 80ms, and every one of those repaints the live frame — measured at
 * 31 KB/s during a running turn, with zero full-screen clears. Adding a second
 * animated thing would have doubled that for decoration. One timer in, one
 * timer out: the cost is exactly what it already was.
 *
 * The effect is a highlight sweeping through the text, left to right, at the
 * same cadence the spinner already ticked. Nothing about the row's *width*
 * changes as it animates — a line that grows and shrinks is how the live frame
 * ends up one row taller than the viewport, which is the bug this whole file
 * exists downstream of (see ui/constants.js).
 */

/** Braille dots, the same sequence ink-spinner used, so the rhythm is familiar. */
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** How far either side of the crest still gets brightened. */
const SPREAD = 3;

const TICK_MS = 80;

export function RunningLine({ text, color = 'cyan' }) {
  const [tick, setTick] = React.useState(0);

  React.useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), TICK_MS);
    return () => clearInterval(id);
  }, []);

  const label = String(text ?? '');
  const frame = FRAMES[tick % FRAMES.length];

  // The crest travels a little past both ends, so the sweep has a moment of
  // rest instead of snapping back the instant it arrives.
  const period = label.length + SPREAD * 4;
  const crest = (tick % period) - SPREAD * 2;

  return (
    <Text>
      <Text color={color}>{frame}</Text>
      {' '}
      {[...label].map((ch, i) => {
        const distance = Math.abs(i - crest);
        if (distance === 0) return <Text key={i} bold color={color}>{ch}</Text>;
        if (distance <= SPREAD) return <Text key={i} color={color}>{ch}</Text>;
        return <Text key={i} dimColor>{ch}</Text>;
      })}
    </Text>
  );
}
