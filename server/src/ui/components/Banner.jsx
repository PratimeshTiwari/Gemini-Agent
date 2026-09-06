import React from 'react';
import { Box, Text } from 'ink';
import Gradient from 'ink-gradient';

/**
 * The header: figlet name, byline, and the one-line "where am I" summary —
 * workspace, the models actually in play for the current topology, and the
 * GitHub account the PR agent is polling as.
 */
export function Banner({ agentLoop, agentNameAscii }) {
  return (
        <Box key="banner" flexDirection="column" marginBottom={1} width="100%">
          <Gradient name="mind">
            <Text>{agentNameAscii}</Text>
          </Gradient>
          <Text color="magenta">Developed by Pratimesh Tiwari</Text>
          <Text dimColor>
            {agentLoop.workspace}
            {'  ·  '}
            {(() => {
              const topology = agentLoop.topology || 'single';
              const roles = ['main'];
              if (topology === 'duo' || topology === 'swarm') roles.push('reviewer');
              if (topology === 'swarm') roles.push('reasoner');
              return [...new Set(roles.map((r) => agentLoop.modelConfig?.[r]).filter(Boolean))].join(', ') || 'gemini';
            })()}
            {agentLoop.githubHandler?.poller?.username ? `  ·  github @${agentLoop.githubHandler.poller.username}` : ''}
          </Text>
        </Box>
  );
}
