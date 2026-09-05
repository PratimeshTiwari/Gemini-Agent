const fs = require('fs');
let code = fs.readFileSync('server/src/ui/App.jsx', 'utf8');

code = code.replace("import Spinner from 'ink-spinner';", "import Spinner from 'ink-spinner';\nimport Gradient from 'ink-gradient';");

code = code.replace(/\/\/ 2\. Compute dense array of ALL focusable items for UI navigation[\s\S]*?activeToolCalls\.forEach\(/, `// 2. Compute dense array of ALL focusable items for UI navigation
  const focusableItems = [];
  turns.forEach(turn => {
    const hasActions = turn.steps.some(m => m.type === 'tool_call' || m.type === 'tool_result' || m.role === 'system' || (m.role === 'assistant' && m.content.includes('<think>')));
    if (hasActions) {
      focusableItems.push({ type: 'turn_actions', id: \`turn_\${turn.id}\`, turnId: turn.id, turn });
    }
  });

  activeToolCalls.forEach(`);

code = code.replace(/\{turn\.userMsg && \([\s\S]*?\{\/\* Agent Actions Block \*\/\}/, `{turn.userMsg && (
                  <Box flexDirection="column" marginBottom={1} width="100%" flexShrink={1}>
                    <Text bold wrap="wrap">❯ {turn.userMsg.content}</Text>
                  </Box>
                )}

                {/* Agent Actions Block */}`);

code = code.replace(/\{\/\* Agent Actions Block \*\/\}[\s\S]*?\{\/\* Artifacts Summary Box \*\/\}/, `{/* Agent Actions Block */}
                {turn.steps.length > 0 && (
                  <Box flexDirection="column" width="100%" flexShrink={1}>
                    {(() => {
                      const actions = [];
                      const finalMessages = [];
                      
                      turn.steps.forEach((msg, sIdx) => {
                        if (msg.role === 'assistant' || msg.role === 'agent') {
                          const thinkMatch = msg.content.match(/<think>([\\s\\S]*?)<\\/think>/);
                          let cleanContent = msg.content.replace(/<think>[\\s\\S]*?<\\/think>/, '').trim();
                          const imgMatch = cleanContent.match(/🖼️ Image attached: (.*?\\.png|.*?\\.jpg|.*?\\.jpeg|.*?\\.webp)/);
                          
                          if (imgMatch) {
                            cleanContent = cleanContent.replace(imgMatch[0], '').trim();
                            actions.push({ type: 'image', content: imgMatch[1], msg });
                          }
                          
                          if (thinkMatch) {
                            actions.push({ type: 'think', content: thinkMatch[1].trim(), msg });
                          }
                          if (cleanContent) {
                            finalMessages.push({ type: 'text', content: cleanContent, msg });
                          }
                        } else if (msg.type === 'tool_call') {
                          actions.push({ type: 'tool_call', msg });
                        } else if (msg.type === 'tool_result') {
                          actions.push({ type: 'tool_result', msg });
                        } else if (msg.role === 'system') {
                          actions.push({ type: 'system', msg });
                        }
                      });

                      const isFocused = !isStatic && focus === FOCUS_CHAT && focusableItems[clampedSelectedToolIdx]?.id === \`turn_\${turn.id}\`;
                      const isExpanded = isStatic || expandedLogIds.has(\`turn_\${turn.id}\`) || (isLastTurn && isProcessingTurn);
                      const focusPrefix = isFocused ? <Text color="cyan">❯ </Text> : <Text>  </Text>;

                      return (
                        <Box flexDirection="column" width="100%" flexShrink={1}>
                          {actions.length > 0 && (
                            <Box flexDirection="column" marginBottom={1} width="100%" flexShrink={1}>
                              <Text color={isFocused ? 'cyan' : 'gray'}>
                                {focusPrefix}
                                {isExpanded ? '▼' : '▶'} Thinking & Actions {isLastTurn && isProcessingTurn ? <Text color="cyan"><Spinner type="dots" /> {status}</Text> : <Text dimColor>[{duration}s]</Text>}
                              </Text>
                              
                              {isExpanded && (
                                <Box flexDirection="column" paddingLeft={2} borderLeftStyle="single" borderLeftColor="dim" marginLeft={4} marginTop={1} width="100%" flexShrink={1}>
                                  {actions.map((act, idx) => {
                                    if (act.type === 'tool_call') {
                                      return (
                                        <Text key={idx} dimColor wrap="wrap">
                                          ∙ ran {act.msg.toolName} {JSON.stringify(act.msg.args || {}).substring(0, 40)}...
                                        </Text>
                                      );
                                    }
                                    if (act.type === 'tool_result') {
                                      const resultStr = typeof act.msg.result === 'string' ? act.msg.result : JSON.stringify(act.msg.result, null, 2);
                                      const lines = resultStr.split('\\n');
                                      const truncatedStr = lines.length > 15 ? lines.slice(0, 15).join('\\n') + '\\n... [Truncated]' : resultStr;
                                      return (
                                        <Box key={idx} flexDirection="column" marginY={1} width="100%" flexShrink={1}>
                                          <Box borderStyle="round" borderColor="dim" paddingX={1} width="100%" flexShrink={1}>
                                            <Text dimColor wrap="wrap">{truncatedStr}</Text>
                                          </Box>
                                        </Box>
                                      );
                                    }
                                    if (act.type === 'think') {
                                      const lines = act.content.split('\\n');
                                      const truncatedStr = lines.length > 10 ? lines.slice(0, 10).join('\\n') + '\\n... [Truncated]' : act.content;
                                      return (
                                        <Box key={idx} marginY={1} width="100%" flexShrink={1}>
                                          <Text dimColor wrap="wrap">∙ {truncatedStr}</Text>
                                        </Box>
                                      );
                                    }
                                    if (act.type === 'system') {
                                      return (
                                        <Box key={idx} marginY={1} width="100%" flexShrink={1}>
                                          <Text dimColor wrap="wrap">{act.msg.content}</Text>
                                        </Box>
                                      );
                                    }
                                    if (act.type === 'image') {
                                      return <Text key={idx} dimColor>∙ Attached Image: {act.content}</Text>;
                                    }
                                    return null;
                                  })}
                                </Box>
                              )}
                            </Box>
                          )}
                          
                          {finalMessages.map((fm, idx) => (
                            <Box key={idx} paddingLeft={2} marginTop={actions.length > 0 ? 0 : 1} marginBottom={1} width="100%" flexShrink={1}>
                              <Text wrap="wrap">{marked.parse((fm.content || '').replace(/\\*\\*(.*?)\\*\\*/g, '\\x1b[1m$1\\x1b[22m').replace(/^###\\s+(.*$)/gm, '\\x1b[1;32m$1\\x1b[0m')).trim()}</Text>
                            </Box>
                          ))}
                        </Box>
                      );
                    })()}

                    {/* Artifacts Summary Box */}`);

fs.writeFileSync('server/src/ui/App.jsx', code);
