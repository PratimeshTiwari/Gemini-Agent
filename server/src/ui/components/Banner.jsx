import React from 'react';
import { Box, Text } from 'ink';
import os from 'os';

/**
 * The header: the wordmark, the attribution, and the one line that says where
 * you are — workspace, the models actually in play, and the GitHub account the
 * PR agent is polling as.
 *
 * It is committed to <Static>, so its height and its node count cost scrollback
 * rather than the live frame. That is why it is allowed to be six rows of
 * figlet painted in bands: it is written once and then owned by the terminal.
 *
 * What it is *not* allowed to be is the loudest thing on screen. It used to run
 * the wordmark through `ink-gradient`'s "mind" preset — a full rainbow — and put
 * the byline in magenta above a dimmed workspace path, so the two rows carrying
 * no information were the two the eye went to first.
 *
 * Flat cyan fixed that and overshot: a wordmark with no depth reads as
 * unfinished. The answer is not the rainbow back. A rainbow is many hues
 * competing with every other coloured thing in the app; a two-stop ramp inside
 * one hue family is a brand mark, and it stays inside the five-role palette
 * because both stops are the accent. Everything under it is dim, so the
 * hierarchy still matches what the rows are worth.
 */

/** The ramp: accent cyan into indigo. Both ends are the accent, not new roles. */
const FROM = [0x22, 0xd3, 0xee];
const TO = [0x60, 0x7d, 0xff];

/**
 * Vertical bands rather than per-character colour. A 49-column wordmark is ~300
 * characters; at ten bands it is sixty `<Text>` nodes, and the ramp is smooth
 * enough that nobody has ever counted the steps.
 */
const BANDS = 10;

const hex = (t) => {
  const c = FROM.map((from, i) => Math.round(from + (TO[i] - from) * t));
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
};

/**
 * The ramp runs across the *block*, not across each line — measured from the
 * widest row so a column is the same colour on every row. Ramping each line
 * independently makes the short rows (figlet's descenders) sweep through the
 * whole range in a few characters, and the wordmark shears.
 */
function Wordmark({ text }) {
  const lines = String(text ?? '').split('\n');
  const width = Math.max(1, ...lines.map((l) => l.length));
  const step = Math.max(1, Math.ceil(width / BANDS));

  return lines.map((line, row) => (
    <Text key={row}>
      {Array.from({ length: BANDS }, (_, b) => {
        const slice = line.slice(b * step, (b + 1) * step);
        if (!slice) return null;
        return <Text key={b} color={hex(BANDS === 1 ? 0 : b / (BANDS - 1))}>{slice}</Text>;
      })}
    </Text>
  ));
}

export function Banner({ agentLoop, agentNameAscii }) {
  const models = (() => {
    const topology = agentLoop.topology || 'single';
    const roles = topology === 'duo' ? ['main', 'reviewer'] : ['main'];
    const named = roles.map((r) => agentLoop.modelConfig?.[r]).filter(Boolean);
    return [...new Set(named)].join(', ') || 'gemini';
  })();

  const account = agentLoop.githubHandler?.poller?.username;

  // `~/Documents/Gemini-Agent`, not the absolute path. The banner is committed
  // to <Static> so a wrap here costs scrollback rather than the frame, but it
  // is still the first line anyone reads and the prefix carries nothing.
  const home = os.homedir();
  const where = agentLoop.workspace?.startsWith(home)
    ? `~${agentLoop.workspace.slice(home.length)}`
    : agentLoop.workspace;

  return (
    <Box key="banner" flexDirection="column" marginBottom={1} width="100%">
      <Wordmark text={agentNameAscii} />
      <Text dimColor>Developed by Pratimesh Tiwari</Text>
      <Text dimColor>
        {where}
        {'  ·  '}
        {models}
        {account ? `  ·  @${account}` : ''}
      </Text>
    </Box>
  );
}
