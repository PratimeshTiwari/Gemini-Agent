import React from 'react';
import { Text } from 'ink';

/**
 * The row that says the agent is working, and the frames everything else uses.
 *
 * The constraint this file was written around is that `ink-spinner` drives a
 * state update every 80ms and every one of those repaints the whole live frame,
 * so replacing it here rather than sitting beside it kept the cost at one timer.
 *
 * That was true of this row and false of the frame. Three more `<Spinner>`s were
 * live at the same time — the status bar's, the "Worked for" line's, and **one
 * per in-flight tool call** — each with its own unsynchronised interval, each
 * repainting everything. So the frame was being redrawn three-plus-N times per
 * tick to animate one idea.
 *
 * The tick is now owned once, by App, and passed in. Nothing here starts a
 * timer; `Dots` is the same braille sequence for everywhere that used
 * `ink-spinner`, driven by that one tick.
 *
 * The effect is a highlight sweeping through the text, left to right, at the
 * same cadence the spinner already ticked. Nothing about the row's *width*
 * changes as it animates — a line that grows and shrinks is how the live frame
 * ends up one row taller than the viewport, which is the bug this whole file
 * exists downstream of (see ui/constants.js).
 */

/** Braille dots, the same sequence ink-spinner used, so the rhythm is familiar. */
export const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** What `<Spinner type="dots" />` drew, without a timer of its own. */
export function Dots({ tick = 0, color = 'cyan' }) {
  return <Text color={color}>{FRAMES[tick % FRAMES.length]}</Text>;
}

/** How far either side of the crest still gets brightened. */
const SPREAD = 3;

export function RunningLine({ text, tick = 0, color = 'cyan' }) {
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
