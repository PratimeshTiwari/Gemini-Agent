import React from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import { Clickable } from './Clickable.jsx';

/**
 * The GitHub PR dashboard (Ctrl+O).
 *
 * Three views behind one tab — recent activity, the avoid-words editor and the
 * PR explorer — plus the token-setup screen shown when no handler exists yet.
 * Navigation lives in the key bindings; this only draws.
 */
export function GithubTab({
  activeTab,
  agentLoop,
  wsServer,
  avoidWords,
  setAvoidWords,
  newAvoidWord,
  setNewAvoidWord,
  githubSetupToken,
  setGithubSetupToken,
  githubView,
  expandedComments,
  explorerMode,
  githubActivity,
  loadingPrs,
  loadingPrComments,
  prList,
  prComments,
  selectedPlanId,
  selectedPrIdx,
  setSelectedPrIdx,
  selectedPrCommentIdx,
  setSelectedPrCommentIdx,
  setSelectedPlanId,
  setExpandedComments,
}) {
  return (
        <Box flexDirection="column" flexGrow={1} borderStyle="single" borderColor="cyan" padding={1}>
          <Text bold color="cyan">📋 GitHub PR Dashboard</Text>
          
          
          {githubView === "avoid_words" && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold color="yellow">🚫 Avoid Words Editor</Text>
              <Text color="gray">These words indicate that a comment is noise (e.g. LGTM, +1) and should not be analyzed by the AI.</Text>
              
              <Box flexDirection="column" marginY={1} borderStyle="single" borderColor="gray" padding={1}>
                {avoidWords.map((word, i) => (
                  <Text key={i}>• {word}</Text>
                ))}
                {avoidWords.length === 0 && <Text dimColor>No avoid words configured.</Text>}
              </Box>
              
              <Box>
                <Text bold color="green">Add Word: </Text>
                <TextInput
                  focus={githubView === "avoid_words"}
                  value={newAvoidWord}
                  onChange={setNewAvoidWord}
                  onSubmit={(val) => {
                    if (!val.trim()) return;
                    const updated = [...avoidWords, val.trim()];
                    setAvoidWords(updated);
                    setNewAvoidWord("");
                    
                    if (agentLoop.githubHandler) {
                      agentLoop.githubHandler.config.avoidWords = updated;
                      agentLoop.modelConfig = agentLoop.modelConfig || {};
                      agentLoop.modelConfig.githubAvoidWords = updated;
                      agentLoop._saveConfig();
                    }
                  }}
                />
              </Box>
              <Text dimColor marginTop={1}>[Enter] to add | [ESC] to return to Dashboard</Text>
            </Box>
          )}


          {githubView === "pr_explorer" && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold color="magenta">🧭 PR Explorer</Text>
              
              {explorerMode === "prs" && (
                <Box flexDirection="column" marginY={1}>
                  <Text color="gray">Select a PR to view comments:</Text>
                  {loadingPrs ? (
                    <Text dimColor><Spinner type="dots" /> Loading PRs...</Text>
                  ) : prList.length === 0 ? (
                    <Box marginY={1}>
                      <Text dimColor>No open PRs found.</Text>
                    </Box>
                  ) : null}
                  {prList.map((pr, i) => (
                    <Clickable key={i} onClick={() => setSelectedPrIdx(i)}>
                      <Text color={i === selectedPrIdx ? "white" : "gray"}>
                        {i === selectedPrIdx ? "❯ " : "  "}[{pr.repo.name}] #{pr.number} {pr.title}
                      </Text>
                    </Clickable>
                  ))}
                </Box>
              )}
              
              {explorerMode === "comments" && (
                <Box flexDirection="column" marginY={1}>
                  <Box marginBottom={1}>
                    <Text bold color="cyan">PR #{prList[selectedPrIdx]?.number}</Text>
                    <Text color="gray"> — </Text>
                    <Text color="white">{prList[selectedPrIdx]?.title}</Text>
                  </Box>
                  <Text color="gray" dimColor>↵ Enter to dispatch to AI Agent  ·  ESC to go back</Text>
                  <Box flexDirection="column" marginTop={1}>
                    {loadingPrComments ? (
                      <Text dimColor><Spinner type="dots" /> Loading comments...</Text>
                    ) : prComments.length === 0 ? (
                      <Text dimColor>No comments found for this PR.</Text>
                    ) : null}
                    {prComments.map((c, i) => {
                      const isSelected = i === selectedPrCommentIdx;
                      const date = c.created_at ? new Date(c.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
                      const typeTag = c.type === 'review_comment' ? '[review]' : '[comment]';
                      return (
                        <Clickable key={i} onClick={() => setSelectedPrCommentIdx(i)} flexDirection="column" marginBottom={1} borderStyle={isSelected ? 'single' : undefined} borderColor={isSelected ? 'cyan' : undefined} paddingX={isSelected ? 1 : 0}>
                          <Box flexDirection="row">
                            <Text color={isSelected ? 'cyan' : 'yellow'} bold>{isSelected ? '❯ ' : '  '}@{c.author}</Text>
                            <Text color="gray"> {typeTag}</Text>
                            {date ? <Text color="gray" dimColor>  {date}</Text> : null}
                            {c.path ? <Text color="magenta" dimColor>  📄 {c.path}</Text> : null}
                          </Box>
                          <Box marginLeft={isSelected ? 0 : 2}>
                            <Text color={isSelected ? 'white' : 'gray'} wrap="wrap">
                              {c.body.replace(/\n/g, ' ').substring(0, 100)}{c.body.length > 100 ? '...' : ''}
                            </Text>
                          </Box>
                        </Clickable>
                      );
                    })}
                  </Box>
                </Box>
              )}
              
              <Text dimColor marginTop={1}>[↑/↓] Navigate | [Enter] Select | [ESC] Back</Text>
            </Box>
          )}

          {githubView === "activity" && (
            <Box flexDirection="column" marginTop={1}>

          {!agentLoop.githubHandler ? (
            <Box flexDirection="column" marginTop={1}>
              <Text color="yellow" bold>⚠️ GitHub Setup Pending</Text>
              <Text>The GitHub PR integration is currently disabled because the <Text bold>GITHUB_TOKEN</Text> environment variable is not set.</Text>
              <Text></Text>
              <Text>To enable PR comment and CI failure watching:</Text>
              <Text>1. Go to <Text color="blue" underline>https://github.com/settings/tokens/new</Text> and generate a token with `repo` scope.</Text>
              <Text>2. Paste it below to automatically save it to your ~/.zshrc and start the integration.</Text>
              <Text></Text>
              <Box>
                <Text bold color="green">Token: </Text>
                <TextInput 
                  focus={activeTab === 'github' && !agentLoop.githubHandler}
                  value={githubSetupToken}
                  onChange={setGithubSetupToken}
                  onSubmit={async (val) => {
                    const token = val.trim();
                    if (!token) return;
                    try {
                      // Validate token first
                      const res = await fetch('https://api.github.com/user', {
                        headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'Gemini-Agent' }
                      });
                      if (!res.ok) {
                        console.error(`❌ Invalid token: GitHub API returned ${res.status}`);
                        setGithubSetupToken('');
                        return;
                      }

                      // Save to .gemini/config.json
                      agentLoop.modelConfig = agentLoop.modelConfig || {};
                      agentLoop.modelConfig.githubToken = token;
                      agentLoop._saveConfig(); // Fixed method name
                      
                      process.env.GITHUB_TOKEN = token;
                      
                      const { GitHubEventHandler } = await import('../github/github-event-handler.js');
                      const handler = new GitHubEventHandler({
                        token,
                        workspace: agentLoop.workspace,
                        configOverrides: { enableCIWatch: true }
                      });
                      
                      handler.on('status', ({ message }) => console.log(`  [GitHub] ${message}`));
                      handler.on('error', ({ message }) => console.error(`  [GitHub] ❌ ${message}`));
                      handler.on('notification', ({ message }) => console.log(`  [GitHub] ${message}`));
                      
                      agentLoop.githubHandler = handler;
                      wsServer.githubHandler = handler;
                      if (typeof wsServer._wireGitHubEvents === 'function') {
                        wsServer._wireGitHubEvents();
                      }
                      handler.start().catch(err => console.error(err));
                      
                      setGithubSetupToken('');
                    } catch (e) {
                      console.error("Failed to setup token:", e);
                    }
                  }}
                />
              </Box>
              <Text></Text>
              <Text dimColor>Press [Ctrl+O] to return to the Agent tab.</Text>
            </Box>
          ) : (
            <Box borderStyle="round" borderColor="cyan" padding={1} flexDirection="column" width="100%" flexShrink={1}>
              <Box flexDirection="row" marginBottom={1}>
                <Text bold color="cyan">📋 GitHub PR Dashboard</Text>
              </Box>
              <Box flexDirection="row" marginBottom={1} justifyContent="space-between">
                <Text>Status: {agentLoop.githubHandler?.getStatus()?.prsWatched || 0} PRs Watched | CI Watch: <Text color="green" bold>{agentLoop.githubHandler?.config?.enableCIWatch ? 'ON' : 'OFF'}</Text></Text>
                <Text dimColor>Last poll: {agentLoop.githubHandler?.getStatus()?.lastPollTime || 'Never'}</Text>
              </Box>

              {agentLoop.githubHandler?._currentAnalysis && (
                <Box borderStyle="round" borderColor="yellow" paddingX={2} marginBottom={1} flexDirection="column">
                  <Text color="yellow" bold>
                    <Text>🔄 Analyzing comment by @{agentLoop.githubHandler._currentAnalysis.author} on PR #{agentLoop.githubHandler._currentAnalysis.prNumber}...</Text>
                  </Text>
                  <Text dimColor>Please wait while the AI generates a plan. Queue size: {agentLoop.githubHandler?._commentQueue?.length || 0}</Text>
                </Box>
              )}
              <Box borderStyle="single" borderColor="gray" flexDirection="column" flexGrow={1} padding={1}>
                <Text bold marginBottom={1}>── Recent Activity ───────────────────────</Text>
                {githubActivity.length === 0 ? (
                  <Text dimColor>No activity yet. Waiting for PR comments or CI runs...</Text>
                ) : (
                  githubActivity.slice().reverse().map((activity, i) => {
                    if (activity.type === 'github_plan_generated') {
                      const visiblePlans = githubActivity.slice().reverse().filter(a => a.type === 'github_plan_generated').slice(0, 10);
                      const isSelected = activity.id === selectedPlanId || (selectedPlanId === null && visiblePlans[0]?.id === activity.id);
                      const isExpanded = expandedComments.has(activity.id);
                      let snippet = '';
                      if (activity.payload.comment && activity.payload.comment.body) {
                        snippet = activity.payload.comment.body;
                        if (!isExpanded) {
                          const lines = snippet.split('\n');
                          snippet = lines.slice(0, 2).join('\n') + (lines.length > 2 || snippet.length > 100 ? '...' : '');
                          if (snippet.length > 100) snippet = snippet.substring(0, 100) + '...';
                        }
                      }
                      return (
                        <Clickable
                          key={activity.id}
                          onClick={() => {
                            setSelectedPlanId(activity.id);
                            setExpandedComments((prev) => {
                              const next = new Set(prev);
                              if (next.has(activity.id)) next.delete(activity.id);
                              else next.add(activity.id);
                              return next;
                            });
                          }}
                          flexDirection="column"
                          marginBottom={1}
                        >
                          <Text color={isSelected ? 'cyan' : 'white'}>{isSelected ? '❯ ' : '  '}📝 PR #{activity.payload.prNumber} — AI Plan Generated</Text>
                          <Text dimColor marginLeft={4}>Category: {activity.payload.category}</Text>
                          {snippet && (
                            <Box marginLeft={4} flexDirection="column">
                              <Text dimColor>💬 {snippet}</Text>
                            </Box>
                          )}
                          <Text dimColor marginLeft={4}>→ {activity.payload.filePath.split('/').slice(-2).join('/')}</Text>
                        </Clickable>
                      );
                    } else if (activity.type === 'github_notification') {
                      return (
                        <Box key={activity.id} flexDirection="column" marginBottom={1}>
                          <Text>  ℹ️ {activity.payload.message}</Text>
                        </Box>
                      );
                    }
                    return null;
                  }).filter(Boolean).slice(0, 10)
                )}
              </Box>

              <Box marginTop={1}>
                <Text dimColor>[↑/↓] Navigate  [Space] Expand Comment  [Enter] Open Plan  [A] Avoid Words  [P] PR Explorer  [R] Refresh  [Ctrl+O] Agent</Text>
              </Box>
            </Box>
          )}
          </Box>
          )}
        </Box>
  );
}
