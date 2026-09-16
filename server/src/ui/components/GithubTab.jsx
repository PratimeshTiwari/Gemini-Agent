import React from 'react';
import { relative } from 'path';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import { formatPollTime, formatTokenExpiry, oneLine, blockLines } from '../format.js';
import { KeyHints } from './KeyHints.jsx';

/**
 * The GitHub screen (ctrl+o).
 *
 * ## It is a screen, and that means it fills the terminal
 *
 * The figlet banner is a `<Static>` item, which Ink commits to the terminal
 * permanently and never repaints — so it cannot be cleared on a tab switch,
 * and must not be attempted: remounting `<Static>` reprints the whole
 * transcript, which is where the second banner came from.
 *
 * It does not need clearing. It needs pushing off, and `height={rows}` does
 * that for free: a frame that fills its budget scrolls the banner into
 * scrollback on the first paint. This screen used to draw three rows into a
 * budget of `terminalHeight - 8` and sit under nine rows of the agent's logo.
 *
 * The fixed height is also what lets the hint row be *pinned*. It used to
 * trail whatever content there happened to be, so it moved every time the list
 * changed length; now it is the last line of the screen, always, and your eye
 * can learn where it is.
 *
 * `overflow="hidden"` is the safety net behind the windowing, not a substitute
 * for it: the single most important rule in `ui/` is that the live frame never
 * outgrows the viewport, and a clipped row is a bug you can see where a
 * clear-and-repaint is a bug that eats the scrollback.
 *
 * ## One list, three levels
 *
 * PRs → that PR's comments → the analysis, in your editor. `⏎` goes deeper at
 * every level and `esc` comes back. Navigation lives in the key bindings; this
 * only draws.
 */
export function GithubTab({ agentLoop, wsServer, github, maxRows, width = 80 }) {
  // A rejected token means the poller has stopped for good, so ask for a new
  // one instead of drawing a dashboard that can never fill in.
  const needsToken = !agentLoop.githubHandler || github.authRejected;

  // Two rows of chrome — the status line and the hint row — plus the notice
  // when there is one. A row you draw is a row you budget.
  const chrome = 2 + (github.lastNotice ? 1 : 0);
  const rows = Math.max(3, maxRows - chrome);

  const body = needsToken
    ? <TokenSetup agentLoop={agentLoop} wsServer={wsServer} github={github} />
    : github.view === 'avoid_words'
      ? <AvoidWords github={github} maxRows={rows} />
      : github.view === 'help'
        ? <GithubHelp />
        : github.view === 'comments'
          ? <Comments agentLoop={agentLoop} github={github} maxRows={rows} width={width} />
          : <PrList github={github} maxRows={rows} width={width} />;

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
    <Box flexDirection="column" width="100%" height={maxRows} overflow="hidden">
      <GithubStatus agentLoop={agentLoop} github={github} />

      <Box flexDirection="column" flexGrow={1} overflow="hidden">{body}</Box>

      {/*
        One line, the newest. GitHub commands answer here rather than in the
        agent's transcript, and a polling notice is worth seeing once — a log
        of them is what the transcript was being filled with.
      */}
      {github.lastNotice ? (
        <Text dimColor wrap="truncate">{'  '}{github.lastNotice}</Text>
      ) : null}

      <KeyHints hints={hintsFor(github, needsToken)} />
    </Box>
  );
}

/**
 * The four bindings this screen offers, and `?` for the rest.
 *
 * Four, because seven wrapped at 78 columns — and a hint row that wraps is
 * charged one row and drawn as two, which is the frame-budget bug this file
 * has hit twice. `?` is last on every row that has one, because it is the
 * escape hatch *from* that row and has to be on it to be found.
 */
function hintsFor(github, needsToken) {
  if (needsToken) return [['⏎', 'save the token'], ['^o', 'agent']];
  if (github.view === 'help') return [['?', 'back'], ['esc', 'back']];
  if (github.view === 'avoid_words') return [['⏎', 'add'], ['esc', 'back']];
  if (github.view === 'comments') {
    return [['↑↓', 'move'], ['⏎', 'analysis'], ['esc', 'PRs'], ['?', 'keys']];
  }
  return [['↑↓', 'move'], ['⏎', 'comments'], ['r', 'refresh'], ['?', 'keys']];
}

function TokenSetup({ agentLoop, wsServer, github }) {
  const { setupToken: token, setSetupToken: setToken, error, setError, authRejected } = github;
  const [busy, setBusy] = React.useState(false);

  const submit = async (val) => {
    const trimmed = (val || '').trim();
    if (!trimmed) return;
    setBusy(true);
    setError('');
    try {
      agentLoop.modelConfig = agentLoop.modelConfig || {};
      agentLoop.modelConfig.githubToken = trimmed;
      agentLoop._saveConfig();
      github.setAuthRejected(false);
      setToken('');
      const { GitHubEventHandler } = await import('../../github/github-event-handler.js');
      const handler = new GitHubEventHandler({
        token: trimmed, workspace: agentLoop.workspace, agentLoop,
      });
      agentLoop.githubHandler = handler;
      if (wsServer) {
        wsServer.githubHandler = handler;
        wsServer._wireGitHubEvents();
      }
      await handler.start();
    } catch (err) {
      setError(String(err?.message || err));
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
    </Box>
  );
}

function AvoidWords({ github, maxRows }) {
  const { avoidWords, newAvoidWord, setNewAvoidWord, addAvoidWord } = github;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color="yellow">Avoid words</Text>
      <Text dimColor wrap="wrap">Comments containing these are treated as noise (LGTM, +1) and never sent to the AI.</Text>
      <Box flexDirection="column" marginY={1}>
        {avoidWords.length === 0
          ? <Text dimColor>None configured.</Text>
          : avoidWords.slice(0, Math.max(1, maxRows - 5)).map((word, i) => <Text key={i}>• {word}</Text>)}
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

/** Every binding on this screen, since the row only carries four. */
function GithubHelp() {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Keys</Text>
      {[
        ['↑ ↓', 'move through the list'],
        ['⏎', 'go deeper — a PR\'s comments, then its analysis'],
        ['esc', 'come back one level, and out to the agent'],
        ['space', 'expand a comment'],
        ['r', 'poll GitHub now'],
        ['a', 'avoid words — comments to skip'],
        ['^o', 'back to the agent'],
      ].map(([key, what]) => (
        <Text key={key}>
          {'  '}<Text color="cyan">{key.padEnd(6)}</Text>
          <Text dimColor>{what}</Text>
        </Text>
      ))}
    </Box>
  );
}

/** The repo, when every PR is in the same one — otherwise the rows say it. */
function commonRepo(prs) {
  const names = new Set(prs.map((pr) => pr?.repo?.name).filter(Boolean));
  return names.size === 1 ? [...names][0] : null;
}

/**
 * Who the agent is on GitHub, and whether it still can be.
 *
 * Drawn above every view, because the two facts that explain an empty screen —
 * the wrong account, and a token that has lapsed — were both invisible from
 * the PR list, which is where you go when it looks wrong.
 *
 * The repo sits on the right, once. It used to be written on every PR row
 * (`[Gemini-Agent] #16`, `[Gemini-Agent] #15`), which is the same fault already
 * fixed one level down when the PR number was repeated on every comment: the
 * container is named once, not per row, and with a single repo it was pure
 * noise in the columns the title most needs.
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
  const repo = commonRepo(github?.prs || []);

  return (
    <Box flexDirection="row" justifyContent="space-between" width="100%">
      <Box flexShrink={1} overflow="hidden">
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
      </Box>
      {repo ? (
        <Box flexShrink={0}><Text dimColor wrap="truncate">{repo}</Text></Box>
      ) : null}
    </Box>
  );
}

/**
 * Level one: the pull requests.
 *
 * Two rows each, because one row could only ever carry the title — and the
 * question you open this screen with is *which of these needs me*, which the
 * title never answers. The second row is what the agent knows: how many
 * comments it has written about, how many of those have no analysis in them,
 * and when it last saw anything.
 */
function PrList({ github, maxRows, width = 80 }) {
  const { prs, prSummary, selectedPrIdx, loadingPrs } = github;

  if (loadingPrs && prs.length === 0) {
    return <Box marginTop={1}><Text dimColor><Spinner type="dots" /> Loading pull requests…</Text></Box>;
  }
  if (prs.length === 0) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>No open pull requests.</Text>
        <Text dimColor>Comments and CI failures on your PRs will show up here.</Text>
      </Box>
    );
  }

  // Two rows each, and keep the selected one on screen.
  const perRow = 2;
  const capacity = Math.max(1, Math.floor((maxRows - 1) / perRow));
  const start = Math.max(0, Math.min(selectedPrIdx - Math.floor(capacity / 2), prs.length - capacity));
  const shown = prs.slice(start, start + capacity);
  const hidden = prs.length - shown.length;
  const multiRepo = !commonRepo(prs);

  return (
    <Box flexDirection="column" marginTop={1}>
      {shown.map((pr, i) => {
        const selected = start + i === selectedPrIdx;
        const summary = prSummary.get(pr.number);
        return (
          <Box key={pr.number} flexDirection="column">
            <Text color={selected ? 'cyan' : undefined} wrap="truncate">
              {selected ? '❯ ' : '  '}
              <Text bold>#{pr.number}</Text>
              {multiRepo && pr.repo?.name ? <Text dimColor>{'  '}{pr.repo.name}</Text> : null}
              {'  '}{oneLine(pr.title || '(untitled)', Math.max(20, width - 14))}
            </Text>
            <Text dimColor wrap="truncate">
              {'     '}
              {pr.head_ref && pr.head_ref !== 'unknown' ? `${pr.head_ref}  ·  ` : ''}
              {/*
                "seen", not "comments": this is what the *agent* has processed,
                not what is on the PR. Without the word, a PR with three
                comments none of which have been analysed read "nothing yet"
                and then had three comments in it when you opened it.
              */}
              {summary
                ? `${summary.comments} comment${summary.comments === 1 ? '' : 's'} seen`
                : 'nothing seen yet'}
              {summary?.notAnalysed ? `  ·  ⚠ ${summary.notAnalysed} not analysed` : ''}
              {summary?.lastAt ? `  ·  ${formatPollTime(summary.lastAt)}` : ''}
            </Text>
          </Box>
        );
      })}
      {hidden > 0 ? (
        <Text dimColor>{'  '}… {hidden} more — the list is trimmed to fit</Text>
      ) : null}
    </Box>
  );
}

/**
 * Level two: one PR's comments, each joined to the agent's analysis of it.
 *
 * Every comment on the PR, not only the ones the agent processed — the list
 * you want is the one you would see on GitHub, with the agent's work marked on
 * it. `⚠ not analysed` covers both "no plan at all" and "a plan that is the
 * placeholder saying the analysis did not run", because `⏎` does the same
 * thing for both: go and get the analysis.
 */
function Comments({ agentLoop, github, maxRows, width = 80 }) {
  const {
    commentRows, selectedPrCommentIdx, loadingPrComments, selectedPr, expandedComments,
  } = github;

  const title = (
    <Text bold color="cyan" wrap="truncate">
      {`#${selectedPr?.number ?? '?'} `}
      <Text bold={false}>{oneLine(selectedPr?.title || '', Math.max(20, width - 8))}</Text>
    </Text>
  );

  if (loadingPrComments) {
    return (
      <Box flexDirection="column" marginTop={1}>
        {title}
        <Text dimColor><Spinner type="dots" /> Loading comments…</Text>
      </Box>
    );
  }
  if (commentRows.length === 0) {
    return (
      <Box flexDirection="column" marginTop={1}>
        {title}
        <Text dimColor>No comments on this pull request.</Text>
      </Box>
    );
  }

  /**
   * Windowed, not merely rendered.
   *
   * A comment costs three rows — author, one line of body, the plan path — and
   * six when expanded. The list grows on its own, so rows are counted out
   * against the budget and the remainder is stated rather than drawn.
   */
  const budget = Math.max(3, maxRows - 2);
  const costOf = (i) => (expandedComments.has(commentRows[i].comment.id) ? 6 : 3);

  // Grown outward from the selected row, so the row you are on is the one that
  // can never be the one trimmed away. Downward first, because that is the
  // direction a list reads and the direction ↓ is about to take you.
  const cursor = Math.max(0, Math.min(selectedPrCommentIdx, commentRows.length - 1));
  let from = cursor;
  let to = cursor;
  let used = costOf(cursor);
  for (;;) {
    const canDown = to < commentRows.length - 1 && used + costOf(to + 1) <= budget;
    const canUp = from > 0 && used + costOf(from - 1) <= budget;
    if (canDown) { to += 1; used += costOf(to); }
    else if (canUp) { from -= 1; used += costOf(from); }
    else break;
  }
  const shown = [];
  for (let i = from; i <= to; i++) shown.push(i);
  const hidden = commentRows.length - shown.length;

  return (
    <Box flexDirection="column" marginTop={1}>
      {title}
      {shown.map((i) => {
        const row = commentRows[i];
        // Against the clamped cursor, not the raw index: a selection left past
        // the end of a shorter list would otherwise highlight nothing at all.
        const selected = i === cursor;
        const expanded = expandedComments.has(row.comment.id);
        const body = row.comment.body || '';
        return (
          <Box key={row.comment.id} flexDirection="column">
            <Text color={selected ? 'cyan' : undefined} wrap="truncate">
              {selected ? '❯ ' : '  '}@{row.comment.author || 'someone'}
              {row.comment.type === 'review_comment' ? <Text dimColor>{'  review'}</Text> : null}
              {row.analysed ? null : <Text color="yellow">{'  ⚠ not analysed'}</Text>}
            </Text>

            {/*
              The comment on a bar, because it is the one thing on this screen
              a *person* wrote — the same fact the transcript marks on the
              user's own message, drawn by the same function. `blockLines`
              wraps and pads, which is the only way to get an even edge: Ink
              paints characters, not lines.
            */}
            {body ? blockLines(expanded ? body : oneLine(body, 200), width, 4)
              .slice(0, expanded ? 4 : 1)
              .map((line, j) => (
                // eslint-disable-next-line react/no-array-index-key
                <Text key={j} backgroundColor="#303030" color="white">
                  {'    '}{line}
                </Text>
              )) : null}

            {row.filePath ? (
              <Text dimColor wrap="truncate-start">
                {'    '}{planPath(agentLoop?.workspace, row.filePath)}
              </Text>
            ) : null}
          </Box>
        );
      })}
      {hidden > 0 ? (
        <Text dimColor>{'  '}… {hidden} more — the list is trimmed to fit</Text>
      ) : null}
    </Box>
  );
}
