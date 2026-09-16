import React from 'react';
import { relative } from 'path';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import { formatPollTime, formatTokenExpiry, oneLine } from '../format.js';
import { KeyHints } from './KeyHints.jsx';

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
      : github.view === 'help'
        ? <GithubHelp />
        : github.view === 'pr_explorer'
        ? <PrExplorer agentLoop={agentLoop} github={github} maxRows={maxRows} />
        : <Activity agentLoop={agentLoop} github={github} maxRows={maxRows} />;

  /**
   * No border and no heading.
   *
   * The only other box-drawn frame in the product is the input field, and that
   * border *means* something — it is the mode, yellow for plan and cyan for
   * auto. A cyan frame here said nothing and read, at a glance, like the prompt
   * had grown to fill the screen. It also cost four rows of a live frame the
   * rest of the app budgets to the row.
   *
   * The heading went with it: you arrive by pressing `^o`, and the status bar
   * below already says `● github`. It told you where you were after you knew.
   */
  return (
    <Box flexDirection="column" width="100%">
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
        {authRejected ? 'GitHub token rejected' : 'GitHub setup pending'}
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
      {error ? <Text color="red" wrap="wrap">✗ {error}</Text> : null}
      <KeyHints hints={[['^o', 'back to the agent']]} />
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
      <KeyHints hints={[['⏎', 'add'], ['esc', 'back to the dashboard']]} />
    </Box>
  );
}

/**
 * A plan path a terminal can turn into a link.
 *
 * Relative to the workspace, because that is the cwd the terminal resolves
 * against. Absolute when the file is somewhere else entirely, since a `../..`
 * chain is neither clickable nor readable.
 */
function planPath(workspace, filePath) {
  const file = String(filePath || '');
  if (!file || !workspace) return file;
  const rel = relative(workspace, file);
  return !rel || rel.startsWith('..') ? file : rel;
}

/** Every binding on this tab, since the row only carries four. */
function GithubHelp() {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Keys</Text>
      {[
        ['↑ ↓', 'move through the list'],
        ['⏎', 'open the plan in your editor'],
        ['space', 'expand the comment'],
        ['r', 'poll GitHub now'],
        ['p', 'browse pull requests'],
        ['a', 'avoid words — comments to skip'],
        ['^o', 'back to the agent'],
        ['esc', 'back'],
      ].map(([key, what]) => (
        <Text key={key}>
          {'  '}<Text color="cyan">{key.padEnd(6)}</Text>
          <Text dimColor>{what}</Text>
        </Text>
      ))}
      <Box marginTop={1}><KeyHints hints={[['?', 'back'], ['esc', 'back']]} /></Box>
    </Box>
  );
}

/**
 * Who the agent is on GitHub, and whether it still can be.
 *
 * Drawn above every view that has a token, because the two facts that explain
 * an empty dashboard — the wrong account, and a token that has lapsed — were
 * both invisible from the PR explorer, which is where you go when the list
 * looks wrong.
 */
function GithubStatus({ agentLoop, github }) {
  const status = agentLoop?.githubHandler?.getStatus?.() || {};
  const token = formatTokenExpiry(status.tokenExpiry, github?.authRejected);
  const watched = status.prsWatched || 0;

  /**
   * One line, ranked, and quiet about what is merely the default.
   *
   * It used to print five fields of equal weight — `connecting… · token ok ·
   * 0 PRs watched · CI watch on · polled never` — so nothing stood out, two of
   * them contradicted each other at a glance, and at 78 columns the last one
   * was already being cut off.
   *
   * Identity first: "0 PRs watched" reads very differently once you can see it
   * is watching as the wrong account, which is the reasoning `getStatus()`
   * already has for reporting `username` at all.
   *
   * `CI watch` appears only when it is **off**, and the poll time only once a
   * poll has happened — the same rule the main status bar follows for `0
   * pastes`. A field that always says the same thing is not information.
   */
  const trouble = github?.authRejected || token.tone === 'red';

  return (
    <Text wrap="truncate">
      {trouble ? <Text color="yellow">{'! '}{token.label}</Text> : null}
      {!trouble && status.username
        ? <Text color="cyan" bold>@{status.username}</Text>
        : null}
      {!trouble && !status.username ? <Text dimColor>connecting…</Text> : null}

      {!trouble && status.username ? (
        <Text dimColor>{'  ·  '}{watched} PR{watched === 1 ? '' : 's'}</Text>
      ) : null}
      {!trouble && status.lastPollTime ? (
        <Text dimColor>{'  ·  '}polled {formatPollTime(status.lastPollTime)}</Text>
      ) : null}
      {!trouble && status.ciWatchEnabled === false ? (
        <Text dimColor>{'  ·  '}CI watch off</Text>
      ) : null}
    </Text>
  );
}

function PrExplorer({ agentLoop, github, maxRows }) {
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
        <GithubStatus agentLoop={agentLoop} github={github} />
        <Text bold color="cyan" wrap="truncate">PR #{pr?.number} — {pr?.title}</Text>
        <KeyHints hints={[['↑↓', 'move'], ['⏎', 'send to the agent'], ['esc', 'back']]} />
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
      <GithubStatus agentLoop={agentLoop} github={github} />
      <Text bold color="cyan">PR explorer</Text>
      <KeyHints hints={[['↑↓', 'move'], ['⏎', 'open comments'], ['r', 'refresh'], ['esc', 'back']]} />
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
  const recent = activity.slice().reverse().slice(0, Math.max(1, Math.floor((maxRows - 6) / 2)));

  return (
    <Box flexDirection="column" marginTop={1}>
      <GithubStatus agentLoop={agentLoop} github={github} />

      {agentLoop.githubHandler?._currentAnalysis && (
        <Text color="yellow" wrap="truncate">
          Analysing @{agentLoop.githubHandler._currentAnalysis.author} on PR #{agentLoop.githubHandler._currentAnalysis.prNumber}
          <Text dimColor> · queue {agentLoop.githubHandler?._commentQueue?.length || 0}</Text>
        </Text>
      )}

      <Box flexDirection="column" marginTop={1}>
        {/*
          The heading earns its place only when there is a list under it. An
          empty state used to cost three rows — heading, sentence, and the
          blank line above them — to say nothing is happening.
        */}
        {recent.length > 0 ? <Text bold>Recent activity</Text> : null}
        {recent.length === 0
          ? <Text dimColor>Nothing yet — waiting for PR comments or CI runs.</Text>
          : recent.map((activity) => {
            if (activity.type === 'github_plan_generated') {
              const isSelected = activity.id === selectedPlanId;
              const isExpanded = expandedComments.has(activity.id);
              const body = activity.payload?.comment?.body || '';
              /**
               * Who said it, not what the classifier called it.
               *
               * The row used to read `PR #42 — plan generated · requires_review`.
               * `requires_review` is the **only** non-noise value
               * `comment-classifier.js` can return, and anything it calls noise
               * is dropped before a plan is written — so on a comment row that
               * word was a constant. `plan generated` was another: every row in
               * this list is a plan.
               *
               * Meanwhile the author was already in the payload and not shown,
               * which is the wrong way round — "@alice commented" is what this
               * list is scanned for.
               *
               * There is no LLM verdict to put here instead. The classifier
               * stopped categorising when the AI took that over, and what the
               * AI produces is the plan itself, not a label; inventing one to
               * display would be the second classifier that was removed.
               */
              const author = activity.payload?.comment?.author;
              const what = author
                ? `@${author} commented`
                : activity.payload?.category === 'ci_failure'
                  ? 'CI failed'
                  : 'plan written';
              return (
                <Box key={activity.id} flexDirection="column">
                  <Text color={isSelected ? 'cyan' : 'white'} wrap="truncate">
                    {isSelected ? '❯ ' : '  '}PR #{activity.payload.prNumber}
                    <Text dimColor>{'  ·  '}</Text>{what}
                  </Text>
                  {body ? (
                    <Text dimColor wrap={isExpanded ? 'wrap' : 'truncate'}>
                      {'    💬 '}{isExpanded ? body : oneLine(body, 80)}
                    </Text>
                  ) : null}
                  {/*
                    Relative to the workspace, not the last two segments.
                    VS Code turns a terminal path into a link by resolving it
                    against the shell's cwd — which is the workspace — so
                    `PR-15/comment-….md` resolved to nothing and clicking it
                    said "No matching results". `.agent/github-reviews/PR-15/…`
                    resolves, and is still far shorter than the absolute path.
                    `truncate-start` keeps the identifying tail when it is too
                    wide.
                  */}
                  <Text dimColor wrap="truncate-start">
                    {'    → '}{planPath(agentLoop?.workspace, activity.payload.filePath)}
                  </Text>
                </Box>
              );
            }
            if (activity.type === 'github_notification') {
              return <Text key={activity.id} wrap="truncate">  {activity.payload.message}</Text>;
            }
            return null;
          })}
      </Box>

      <Box marginTop={1}>
        {/*
          Four, not seven. At 78 columns seven wrapped mid-list and left a
          separator stranded at the start of the second row — `KeyHints` uses
          `flexWrap`, which knows nothing about the separators it wraps
          between. The transcript settled this already: the status bar carries
          what is live and `/help` lists the rest.
        */}
        <KeyHints hints={[
          ['↑↓', 'move'],
          ['⏎', 'open plan'],
          ['r', 'refresh'],
          ['?', 'more'],
        ]} />
      </Box>
    </Box>
  );
}
