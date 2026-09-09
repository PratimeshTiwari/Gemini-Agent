import React from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import { formatPollTime, oneLine } from '../format.js';

/**
 * The GitHub PR dashboard (ctrl+o).
 *
 * One screen at a time, never nested: no token yet means the setup screen and
 * nothing else, and with a token exactly one of activity / avoid-words / PR
 * explorer is drawn. The setup screen used to be rendered *inside* the activity
 * view, so it only appeared in one of the three states.
 *
 * Everything here is bounded by `maxRows`, because this whole tab lives in Ink's
 * repainted frame. A list that outgrows the viewport makes Ink clear and
 * repaint the terminal on every render — the flicker, and the reason the
 * dashboard could not be scrolled or copied out of.
 *
 * Navigation lives in the key bindings; this only draws.
 */
export function GithubTab({ agentLoop, wsServer, github, maxRows }) {
  // A rejected token means the poller has stopped for good, so ask for a new
  // one instead of drawing a dashboard that can never fill in.
  const body = (!agentLoop.githubHandler || github.authRejected)
    ? <TokenSetup agentLoop={agentLoop} wsServer={wsServer} github={github} />
    : github.view === 'avoid_words'
      ? <AvoidWords github={github} maxRows={maxRows} />
      : github.view === 'pr_explorer'
        ? <PrExplorer github={github} maxRows={maxRows} />
        : <Activity agentLoop={agentLoop} github={github} maxRows={maxRows} />;

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1} width="100%">
      <Text bold color="cyan">📋 GitHub PR Dashboard</Text>
      {body}
    </Box>
  );
}

function TokenSetup({ agentLoop, wsServer, github }) {
  const { setupToken: token, setSetupToken: setToken, error, setError, authRejected } = github;
  const [busy, setBusy] = React.useState(false);

  const submit = async (val) => {
    const trimmed = val.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${trimmed}`, 'User-Agent': 'Gemini-Agent' },
      });
      if (!res.ok) {
        setError(`GitHub rejected the token (HTTP ${res.status}). It needs the \`repo\` scope.`);
        setBusy(false);
        return;
      }

      // Persisted to <workspace>/.agent/config.json — see core/paths.js. The env
      // var is set for this process only; it does not outlive the session,
      // which is why the config is the store.
      agentLoop.modelConfig = agentLoop.modelConfig || {};
      agentLoop.modelConfig.githubToken = trimmed;
      agentLoop._saveConfig();
      process.env.GITHUB_TOKEN = trimmed;

      // Two levels up, not one: this file lives in ui/components/, so the old
      // '../github/…' resolved to ui/github/ and every token submission died
      // on ERR_MODULE_NOT_FOUND — which was then swallowed by console.error
      // straight into Ink's frame, so it read as "some error".
      const { GitHubEventHandler } = await import('../../github/github-event-handler.js');
      const handler = new GitHubEventHandler({
        token: trimmed,
        workspace: agentLoop.workspace,
        configOverrides: { enableCIWatch: true },
      });
      handler.on('error', ({ message }) => setError(String(message)));

      agentLoop.githubHandler = handler;
      if (wsServer) {
        wsServer.githubHandler = handler;
        if (typeof wsServer._wireGitHubEvents === 'function') wsServer._wireGitHubEvents();
      }
      handler.start().catch((err) => setError(String(err?.message || err)));
      github.setAuthRejected(false);
      setToken('');
    } catch (e) {
      // Never console.error from inside an Ink app: it writes straight into the
      // frame Ink is repainting and the message is gone on the next render.
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={authRejected ? 'red' : 'yellow'} bold>
        {authRejected ? '🔒 GitHub token rejected' : '⚠️  GitHub setup pending'}
      </Text>
      <Text wrap="wrap">Generate a token with the <Text bold>repo</Text> scope at https://github.com/settings/tokens/new and paste it below.</Text>
      <Text dimColor wrap="wrap">Stored in this workspace's .agent/config.json; the integration starts immediately.</Text>
      <Box marginTop={1}>
        <Text bold color="green">Token: </Text>
        {busy
          ? <Text dimColor><Spinner type="dots" /> verifying…</Text>
          : (
            <TextInput
              focus
              mask="*"
              value={token}
              onChange={setToken}
              onSubmit={submit}
            />
          )}
      </Box>
      {error ? <Text color="red" wrap="wrap">❌ {error}</Text> : null}
      <Text dimColor>ctrl+o returns to the agent.</Text>
    </Box>
  );
}

function AvoidWords({ github, maxRows }) {
  const { avoidWords, newAvoidWord, setNewAvoidWord, addAvoidWord } = github;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color="yellow">🚫 Avoid words</Text>
      <Text dimColor wrap="wrap">Comments containing these are treated as noise (LGTM, +1) and never sent to the AI.</Text>
      <Box flexDirection="column" marginY={1}>
        {avoidWords.length === 0
          ? <Text dimColor>None configured.</Text>
          : avoidWords.slice(0, Math.max(1, maxRows - 6)).map((word, i) => <Text key={i}>• {word}</Text>)}
      </Box>
      <Box>
        <Text bold color="green">Add: </Text>
        <TextInput
          focus
          value={newAvoidWord}
          onChange={setNewAvoidWord}
          onSubmit={addAvoidWord}
        />
      </Box>
      <Text dimColor>enter adds · esc returns to the dashboard</Text>
    </Box>
  );
}

function PrExplorer({ github, maxRows }) {
  const {
    explorerMode, loadingPrs, loadingPrComments, prList, prComments,
    selectedPrIdx, selectedPrCommentIdx,
  } = github;
  // Keep the selected row on screen without letting the list grow the frame.
  const window = Math.max(3, maxRows - 6);
  const slice = (items, selected) => {
    const start = Math.max(0, Math.min(selected - Math.floor(window / 2), items.length - window));
    return { start: Math.max(0, start), items: items.slice(Math.max(0, start), Math.max(0, start) + window) };
  };

  if (explorerMode === 'comments') {
    const pr = prList[selectedPrIdx];
    const view = slice(prComments, selectedPrCommentIdx);
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text bold color="magenta" wrap="truncate">🧭 PR #{pr?.number} — {pr?.title}</Text>
        <Text dimColor>enter dispatches to the agent · esc goes back</Text>
        {loadingPrComments ? <Text dimColor><Spinner type="dots" /> Loading comments…</Text> : null}
        {!loadingPrComments && prComments.length === 0 ? <Text dimColor>No comments on this PR.</Text> : null}
        {view.items.map((c, i) => {
          const idx = view.start + i;
          const isSelected = idx === selectedPrCommentIdx;
          const date = c.created_at
            ? new Date(c.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
            : '';
          return (
            <Text key={idx} wrap="truncate">
              <Text color={isSelected ? 'cyan' : 'yellow'} bold>{isSelected ? '❯ ' : '  '}@{c.author}</Text>
              <Text dimColor> {c.type === 'review_comment' ? '[review]' : '[comment]'}{date ? ` ${date}` : ''} </Text>
              <Text color={isSelected ? 'white' : 'gray'}>{oneLine(c.body, 70)}</Text>
            </Text>
          );
        })}
      </Box>
    );
  }

  const view = slice(prList, selectedPrIdx);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color="magenta">🧭 PR explorer</Text>
      <Text dimColor>↑↓ move · enter opens comments · esc back</Text>
      {loadingPrs ? <Text dimColor><Spinner type="dots" /> Loading PRs…</Text> : null}
      {!loadingPrs && prList.length === 0 ? <Text dimColor>No open PRs found.</Text> : null}
      {view.items.map((pr, i) => {
        const idx = view.start + i;
        return (
          <Text key={idx} color={idx === selectedPrIdx ? 'white' : 'gray'} wrap="truncate">
            {idx === selectedPrIdx ? '❯ ' : '  '}[{pr.repo?.name}] #{pr.number} {pr.title}
          </Text>
        );
      })}
    </Box>
  );
}

function Activity({ agentLoop, github, maxRows }) {
  const { activity, selectedPlanId, expandedComments } = github;
  const status = agentLoop.githubHandler?.getStatus?.() || {};
  const watched = status.prsWatched || 0;
  const recent = activity.slice().reverse().slice(0, Math.max(1, Math.floor((maxRows - 6) / 2)));

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text wrap="wrap">
        {status.username
          ? <Text color="cyan" bold>@{status.username}<Text dimColor> · </Text></Text>
          : <Text dimColor>connecting… · </Text>}
        <Text bold>{watched}</Text>
        <Text dimColor> PR{watched === 1 ? '' : 's'} watched · CI watch </Text>
        <Text bold color={agentLoop.githubHandler?.config?.enableCIWatch ? 'green' : 'gray'}>
          {agentLoop.githubHandler?.config?.enableCIWatch ? 'on' : 'off'}
        </Text>
        <Text dimColor> · polled {formatPollTime(status.lastPollTime)}</Text>
      </Text>

      {agentLoop.githubHandler?._currentAnalysis && (
        <Text color="yellow" wrap="truncate">
          🔄 Analysing @{agentLoop.githubHandler._currentAnalysis.author} on PR #{agentLoop.githubHandler._currentAnalysis.prNumber}
          <Text dimColor> · queue {agentLoop.githubHandler?._commentQueue?.length || 0}</Text>
        </Text>
      )}

      <Box flexDirection="column" marginTop={1}>
        <Text bold>Recent activity</Text>
        {recent.length === 0
          ? <Text dimColor>Nothing yet — waiting for PR comments or CI runs.</Text>
          : recent.map((activity) => {
            if (activity.type === 'github_plan_generated') {
              const isSelected = activity.id === selectedPlanId;
              const isExpanded = expandedComments.has(activity.id);
              const body = activity.payload?.comment?.body || '';
              return (
                <Box key={activity.id} flexDirection="column">
                  <Text color={isSelected ? 'cyan' : 'white'} wrap="truncate">
                    {isSelected ? '❯ ' : '  '}PR #{activity.payload.prNumber} — plan generated
                    <Text dimColor> · {activity.payload.category}</Text>
                  </Text>
                  {body ? (
                    <Text dimColor wrap={isExpanded ? 'wrap' : 'truncate'}>
                      {'    💬 '}{isExpanded ? body : oneLine(body, 80)}
                    </Text>
                  ) : null}
                  <Text dimColor wrap="truncate-start">
                    {'    → '}{String(activity.payload.filePath || '').split('/').slice(-2).join('/')}
                  </Text>
                </Box>
              );
            }
            if (activity.type === 'github_notification') {
              return <Text key={activity.id} wrap="truncate">  ℹ️  {activity.payload.message}</Text>;
            }
            return null;
          })}
      </Box>

      <Box marginTop={1}>
        <Text dimColor wrap="wrap">↑↓ move · space expand · enter open plan · a avoid words · p PRs · r refresh · ctrl+o agent</Text>
      </Box>
    </Box>
  );
}
