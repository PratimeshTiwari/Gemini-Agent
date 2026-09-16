import React from 'react';
import { relative } from 'path';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import { formatPollTime, formatTokenExpiry, oneLine, blockLines } from '../format.js';
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
export function GithubTab({ agentLoop, wsServer, github, maxRows, width = 80 }) {
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
        : <Activity agentLoop={agentLoop} github={github} maxRows={maxRows} width={width} />;

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

/**
 * One comment's state, in a word.
 *
 * The one thing worth knowing before pressing enter, and it was invisible: a
 * comment whose analysis never ran has a file like any other, so the row read
 * identically either way. `⏎` means "open" or "analyse" depending on this.
 *
 * Nothing at all for the ordinary case — a plan that exists needs no label,
 * and marking every row would make the two that matter disappear among them.
 */
function commentState(payload, current) {
  const live = current && current.commentId === payload?.comment?.id;
  if (live) return { mark: '⟳ analysing', colour: 'yellow' };
  if (payload?.analysed === false) return { mark: '⚠ not analysed', colour: 'yellow' };
  return null;
}

/**
 * The activity feed, grouped by pull request.
 *
 * It was a flat list that repeated the PR number on every row. A reviewer
 * thread is a conversation *about* a PR, so the PR is the container — and
 * grouping means the number is written once instead of once per comment.
 *
 * No box. The only box-drawn frame in this product is the input field, where
 * the border means the mode; a second one devalues that and costs four rows of
 * a live frame that is budgeted to the row. The PR header is a rule to the
 * edge, which separates without enclosing.
 */
function Activity({ agentLoop, github, maxRows, width = 80 }) {
  const { activity, selectedPlanId, expandedComments } = github;
  const current = agentLoop.githubHandler?._currentAnalysis;

  const plans = [];
  const notices = [];
  for (const item of activity) {
    if (item.type === 'github_plan_generated') plans.push(item);
    else if (item.type === 'github_notification') notices.push(item);
  }

  /**
   * Newest PR first, and newest comment first inside it.
   *
   * A Map keeps insertion order, so the groups come out in the order their
   * most recent comment arrived — which is what "recent activity" has to mean
   * once the list is grouped.
   */
  const groups = new Map();
  for (const item of plans.slice().reverse()) {
    const pr = item.payload?.prNumber ?? '?';
    if (!groups.has(pr)) groups.set(pr, { pr, title: item.payload?.prTitle, branch: item.payload?.pr?.head_ref, items: [] });
    groups.get(pr).items.push(item);
  }

  /**
   * Windowed, not merely rendered.
   *
   * The single most important rule in `ui/` is that the live frame never
   * outgrows the viewport, and this list grows on its own — one PR comment at
   * a time, up to fifty. So rows are counted out and the remainder is stated
   * rather than drawn.
   */
  // `- 10`, not `- 8`: the hint row below and its margin are two more rows of
  // furniture, and a row you draw is a row you budget. Charging the list for
  // them is the whole of not reintroducing the overflow.
  const budget = Math.max(3, maxRows - 10);
  const rendered = [];
  let used = 0;
  let dropped = 0;

  for (const group of groups.values()) {
    if (used + 2 > budget) { dropped += group.items.length; continue; }
    const shown = [];
    used += 1; // the PR header
    for (const item of group.items) {
      const expanded = expandedComments.has(item.id);
      const cost = expanded ? 6 : 3;
      if (used + cost > budget) { dropped += 1; continue; }
      used += cost;
      shown.push(item);
    }
    if (shown.length > 0) rendered.push({ ...group, shown });
    else used -= 1;
  }

  const lastNotice = notices.length > 0 ? notices[notices.length - 1] : null;

  return (
    <Box flexDirection="column" marginTop={1}>
      <GithubStatus agentLoop={agentLoop} github={github} />

      {rendered.length === 0 ? (
        <Text dimColor>Nothing yet — waiting for PR comments or CI runs.</Text>
      ) : rendered.map((group) => (
        <Box key={group.pr} flexDirection="column" marginTop={1}>
          {/* The number once, not once per comment. */}
          <Text bold wrap="truncate">
            {`PR #${group.pr}`}
            {group.branch ? <Text dimColor>{'  '}{group.branch}</Text> : null}
            <Text dimColor>
              {'  ·  '}{group.items.length} comment{group.items.length === 1 ? '' : 's'}
            </Text>
          </Text>

          {group.shown.map((item) => {
            const payload = item.payload || {};
            const selected = item.id === selectedPlanId;
            const expanded = expandedComments.has(item.id);
            const state = commentState(payload, current);
            const body = payload.comment?.body || '';

            return (
              <Box key={item.id} flexDirection="column">
                <Text color={selected ? 'cyan' : undefined} wrap="truncate">
                  {selected ? '  ❯ ' : '    '}@{payload.comment?.author || 'someone'}
                  {state ? <Text color={state.colour}>{'  '}{state.mark}</Text> : null}
                </Text>

                {/*
                  The comment on a bar, because it is the one thing on this
                  screen a *person* wrote — the same fact the transcript marks
                  on the user's own message, drawn by the same function.
                  `blockLines` wraps and pads, which is the only way to get an
                  even edge: Ink paints characters, not lines.
                */}
                {body ? blockLines(expanded ? body : oneLine(body, 200), width, 6)
                  .slice(0, expanded ? 4 : 1)
                  .map((line, i) => (
                    // eslint-disable-next-line react/no-array-index-key
                    <Text key={i} backgroundColor="#303030" color="white">
                      {'      '}{line}
                    </Text>
                  )) : null}

                <Text dimColor wrap="truncate-start">
                  {'      '}{planPath(agentLoop?.workspace, payload.filePath)}
                </Text>
              </Box>
            );
          })}
        </Box>
      ))}

      {dropped > 0 ? (
        <Text dimColor>{'  '}… {dropped} more — the list is trimmed to fit</Text>
      ) : null}

      {/*
        One line, the newest. GitHub commands answer here rather than in the
        agent's transcript, and a polling notice is worth seeing once — a log
        of them is what the transcript was being filled with.
      */}
      {lastNotice ? (
        <Box marginTop={1}>
          <Text dimColor wrap="truncate">{'  '}{lastNotice.payload?.message}</Text>
        </Box>
      ) : null}

      {/*
        The screen you land on was the only one without a hint row.

        Every other view here has one, so `p`, `r`, `a` and `?` were all
        invisible from the one place everybody arrives — including `?` itself,
        which exists precisely to list the bindings a four-item row cannot fit
        and was advertised only inside the help it opens. A shortcut nobody can
        discover is a shortcut nobody uses, and that is doubly true of the one
        that discovers the others.

        Four items, because seven wrapped at 78 columns, and a hint row that
        wraps is charged one row and drawn as two — the frame-budget bug this
        file has hit twice.
      */}
      <Box marginTop={1}>
        <KeyHints hints={[['↑↓', 'move'], ['⏎', 'open'], ['p', 'PRs'], ['?', 'keys']]} />
      </Box>
    </Box>
  );
}
