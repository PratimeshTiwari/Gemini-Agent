import React from 'react';
import { Box, Text } from 'ink';
import os from 'os';

/**
 * The header: the wordmark, the attribution, and the one line that says where
 * you are — workspace, the models actually in play, and the GitHub account the
 * PR agent is polling as.
 *
 * It is committed to <Static>, so its height costs scrollback rather than the
 * live frame. That is why it is allowed to be six rows of figlet: it is written
 * once and then owned by the terminal.
 *
 * What it is *not* allowed to be is the loudest thing on screen. It used to run
 * the wordmark through a rainbow gradient and put the byline in magenta above a
 * dimmed workspace path — so the two rows carrying no information were the two
 * rows the eye went to first, and the row that actually orients you was the
 * quietest. Solid accent, dim everything else: the hierarchy now matches what
 * the rows are worth.
 */
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
      <Text color="cyan">{agentNameAscii}</Text>
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
