import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { Clickable } from './Clickable.jsx';
import { FOCUS_CHAT } from '../constants.js';
import { marked, oneLine, summarizeResult, clampForDisplay } from '../format.js';
import { parseTurnActions } from '../transcript.js';

/**
 * One turn of the transcript: the user's message, the collapsed action rows,
 * and the agent's reply.
 *
 * `isStatic` marks a turn Ink has already committed through <Static>. Committed
 * output is never repainted, so those turns render fully expanded and ignore
 * focus — there is no way to change them after the fact.
 */
export function TranscriptTurn({
  turn,
  isLastTurn,
  isProcessingTurn,
  isStatic,
  artifacts,
  clampedSelectedToolIdx,
  expandedLogIds,
  focus,
  focusableItems,
  revealedLength,
  status,
  terminalHeight,
  toggleExpanded,
}) {
      const duration = ((turn.endTime - turn.startTime) / 1000).toFixed(1);
      const { actions, finalMessages } = parseTurnActions(turn);

      const isTurnHeaderFocused = !isStatic && focus === FOCUS_CHAT && focusableItems[clampedSelectedToolIdx]?.id === `turn_${turn.id}`;
      const isTurnActionsExpanded = isStatic || expandedLogIds.has(`turn_${turn.id}`) || (isLastTurn && isProcessingTurn);
      const turnHeaderPrefix = isTurnHeaderFocused ? <Text color="cyan">❯ </Text> : <Text>  </Text>;

      return (
        <Box key={turn.id} flexDirection="column" marginBottom={1} width="100%" flexShrink={1}>
          {/* User Message */}
          {turn.userMsg && (
            <Box flexDirection="column" marginBottom={1} width="100%" flexShrink={1}>
              <Text bold wrap="wrap"><Text color="white">❯</Text> {turn.userMsg.content}</Text>
            </Box>
          )}

          {/* Agent Actions Block */}
          {turn.steps.length > 0 && (
            <Box flexDirection="column" width="100%" flexShrink={1}>
              {(() => {
                const isFocused = !isStatic && focus === FOCUS_CHAT && focusableItems[clampedSelectedToolIdx]?.id === `turn_${turn.id}`;
                const isExpanded = isStatic || expandedLogIds.has(`turn_${turn.id}`) || (isLastTurn && isProcessingTurn);
                const focusPrefix = isFocused ? <Text color="cyan">❯ </Text> : <Text>  </Text>;

                return (
                  <Box flexDirection="column" width="100%" flexShrink={1}>
                    {actions.length > 0 && (
                      <Box flexDirection="column" marginBottom={1} width="100%" flexShrink={1}>
                        <Clickable onClick={() => toggleExpanded(`turn_${turn.id}`)}>
                          <Text color={isFocused ? 'cyan' : 'gray'}>
                            {focusPrefix}
                            {isExpanded ? '▼' : '▶'} Worked for {isLastTurn && isProcessingTurn ? <Text color="cyan"><Spinner type="dots" /> {status}</Text> : <Text>{duration}s</Text>}
                          </Text>
                        </Clickable>
                        
                        {isExpanded && (
                          <Box flexDirection="column" paddingLeft={1} borderLeftStyle="single" borderLeftColor="dim" marginLeft={2} marginTop={1} width="100%" flexShrink={1}>
                            {(() => {
                              // Static turns are painted once and never repainted, so they
                              // may be any height. A live turn must stay inside the viewport.
                              const liveBudget = Math.max(3, Math.floor((terminalHeight - 16) / 3));
                              const hidden = isStatic ? 0 : Math.max(0, actions.length - liveBudget);
                              return hidden > 0 ? (
                                <Text dimColor>  … {hidden} earlier step{hidden === 1 ? '' : 's'} hidden — they appear in full once the turn finishes</Text>
                              ) : null;
                            })()}
                            {(isStatic
                              ? actions
                              : actions.slice(Math.max(0, actions.length - Math.max(3, Math.floor((terminalHeight - 16) / 3))))
                            ).map((act, idx) => {
                              // Paired tool_call + tool_result: one collapsed row.
                              if (act.type === 'tool') {
                                const open = expandedLogIds.has(act.id);
                                const mark = act.success === false ? '✗' : '⏺';
                                const markColor = act.success === false ? 'red' : 'green';
                                return (
                                  <Box key={act.id} flexDirection="column" width="100%" flexShrink={1}>
                                    <Clickable onClick={() => toggleExpanded(act.id)} flexDirection="row">
                                      <Text color={markColor}>{'  ' + mark + ' '}</Text>
                                      <Text bold color={isFocused ? 'cyan' : 'gray'}>{act.toolName}</Text>
                                      <Text dimColor> · {summarizeResult(act.toolName, act.result)}</Text>
                                    </Clickable>
                                    {open && (
                                      <Box flexDirection="column" paddingLeft={4} marginY={1} width="100%" flexShrink={1}>
                                        <Text dimColor wrap="wrap">{clampForDisplay(act.result, 20)}</Text>
                                      </Box>
                                    )}
                                  </Box>
                                );
                              }
                              // A result with no matching call (rare, but possible mid-stream).
                              if (act.type === 'tool_result') {
                                const open = expandedLogIds.has(act.id);
                                return (
                                  <Box key={act.id} flexDirection="column" width="100%" flexShrink={1}>
                                    <Clickable onClick={() => toggleExpanded(act.id)} flexDirection="row">
                                      <Text color="green">{'  ⏺ '}</Text>
                                      <Text dimColor>{oneLine(act.result)}</Text>
                                    </Clickable>
                                    {open && (
                                      <Box flexDirection="column" paddingLeft={4} marginY={1} width="100%" flexShrink={1}>
                                        <Text dimColor wrap="wrap">{clampForDisplay(act.result, 20)}</Text>
                                      </Box>
                                    )}
                                  </Box>
                                );
                              }
                              if (act.type === 'think') {
                                const open = expandedLogIds.has(act.id);
                                const lineCount = act.content.split('\n').length;
                                return (
                                  <Box key={act.id} flexDirection="column" width="100%" flexShrink={1}>
                                    <Clickable onClick={() => toggleExpanded(act.id)}>
                                      <Text dimColor>{'  ✻ Thinking… '}({lineCount} line{lineCount === 1 ? '' : 's'})</Text>
                                    </Clickable>
                                    {open && (
                                      <Box paddingLeft={4} marginY={1} width="100%" flexShrink={1}>
                                        <Text dimColor wrap="wrap">{act.content}</Text>
                                      </Box>
                                    )}
                                  </Box>
                                );
                              }
                              if (act.type === 'command_output') {
                                return (
                                  <Box key={act.id} marginY={0} width="100%" flexShrink={1}>
                                    <Text dimColor wrap="wrap">{clampForDisplay(act.content, 6, 400)}</Text>
                                  </Box>
                                );
                              }
                              if (act.type === 'system') {
                                return (
                                  <Box key={act.id} marginY={0} width="100%" flexShrink={1}>
                                    <Text dimColor wrap="wrap">{act.content ?? act.msg?.content}</Text>
                                  </Box>
                                );
                              }
                              if (act.type === 'image') {
                                return <Text key={act.id} dimColor>{'  ∙ Attached image: '}{act.content}</Text>;
                              }
                              return null;
                            })}
                          </Box>
                        )}
                      </Box>
                    )}
                    
                    {finalMessages.map((fm, idx) => {
                      const isLastFinalMsg = isLastTurn && !isProcessingTurn && idx === finalMessages.length - 1;
                      const rawParsed = marked.parse((fm.content || '').replace(/\*\*(.*?)\*\*/g, '\x1b[1m$1\x1b[22m').replace(/^###\s+(.*$)/gm, '\x1b[1;32m$1\x1b[0m')).trim();
                      const displayText = (isLastFinalMsg && !isStatic && revealedLength < Infinity)
                        ? rawParsed.substring(0, revealedLength)
                        : rawParsed;
                      return (
                        <Box key={idx} flexDirection="row" marginTop={actions.length > 0 ? 1 : 0} marginBottom={1} width="100%" flexShrink={1}>
                          {!fm.msg.isLocal && <Text color="green">● </Text>}
                          <Box flexGrow={1} flexShrink={1}>
                            <Text wrap="wrap">{displayText}{isLastFinalMsg && !isStatic && revealedLength < Infinity ? <Text color="cyan">▋</Text> : null}</Text>
                          </Box>
                        </Box>
                      );
                    })}
                  </Box>
                );
              })()}

              {/* Artifacts Summary Box */}
              {isLastTurn && !isProcessingTurn && (artifacts.task || artifacts.walkthrough) && (
                <Box flexDirection="column" borderStyle="round" borderColor="yellow" padding={1} marginTop={1}>
                  <Text bold color="yellow">📋 Workspace Artifacts Summary</Text>
                  
                  {artifacts.task && (
                    <Box flexDirection="column" marginTop={1}>
                      <Text bold underline color="cyan">task.md</Text>
                      <Box paddingLeft={2}>
                        <Text dimColor wrap="wrap">{artifacts.task}</Text>
                      </Box>
                    </Box>
                  )}
                  
                  {artifacts.walkthrough && (
                    <Box flexDirection="column" marginTop={1}>
                      <Text bold underline color="cyan">walkthrough.md</Text>
                      <Box paddingLeft={2}>
                        <Text dimColor wrap="wrap">{artifacts.walkthrough}</Text>
                      </Box>
                    </Box>
                  )}
                </Box>
              )}
            </Box>
          )}
        </Box>
      );
}
