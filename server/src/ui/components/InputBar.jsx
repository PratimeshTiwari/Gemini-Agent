import React from 'react';
import { Box, Text, usePaste } from 'ink';
import { PromptInput } from './PromptInput.jsx';
import { RunningLine } from './RunningLine.jsx';
import { FOCUS_INPUT } from '../constants.js';
import { applyPaste, nextPasteId } from '../paste.js';
import { oneLine } from '../format.js';
import { hasClipboardImage } from '../clipboard-image.js';

/** First `n` non-empty lines of an artifact, for the one-glance summary. */
/**
 * The bottom of the agent tab: the thinking line while a turn runs, then the
 * prompt with its slash palette.
 *
 * Everything here is bounded on purpose. It sits in Ink's repainted frame, so
 * an unbounded row — the artifact dump this used to render in full — pushes the
 * frame past the viewport and Ink starts clearing the terminal on every render.
 *
 * The text field is the only place keystrokes land. It is always mounted while
 * the prompt is visible, so there is no state in which typing goes nowhere.
 */
export function InputBar({
  queued = [],
  activeMenu,
  addPaste,
  artifacts,
  artifactsOpen,
  artifactLines = 6,
  filedSession,
  history,
  diffRequest,
  setPaletteSuppressed,
  elapsed,
  extensionConnected,
  focus,
  handleSubmit,
  input,
  isProcessing,
  isThinkingTooLong,
  isToolRunningRef,
  mode,
  newlineRef,
  setInput,
  cursorRef,
  promptMaxRows,
  animTick,
  setSlashIdx,
  slashMatches,
  slashOpen,
  slashSelected,
  status,
  syncTokenEstimate,
  terminalOpen,
  pastes,
  thinkingText,
  verbose,
  compact,
}) {
  const hasArtifacts = Boolean(artifacts?.task || artifacts?.review || artifacts?.walkthrough);

  /**
   * `3/6 done` on the header row, so the panel answers the question it exists
   * for without being opened at all. Counted from the file, which is the only
   * copy either the user or the model can be looking at.
   */
  const progress = (() => {
    if (!artifacts?.task) return '';
    const items = String(artifacts.task).match(/^\s*[-*]\s*\[[ xX]\]/gm) || [];
    if (items.length === 0) return '';
    const done = items.filter((l) => /\[[xX]\]/.test(l)).length;
    return `${done}/${items.length} done`;
  })();

  /**
   * Counted before it is cut, or the count is always zero.
   *
   * The first version ran `head(task, artifactLines)` and *then* sliced to
   * `artifactLines`, so the overflow was the difference between a number and
   * itself — the `… +N more` row could never appear, and a list cut to two
   * lines looked like a list with two items.
   */
  const artifactBody = [artifacts?.task, artifacts?.review, artifacts?.walkthrough]
    .filter(Boolean)
    .join('\n')
    .split('\n')
    .filter((l) => l.trim());
  const shownArtifactLines = artifactBody.slice(0, artifactLines);
  const artifactOverflow = artifactBody.length - shownArtifactLines.length;
  const promptVisible = !diffRequest && !terminalOpen && !activeMenu;

  // Bracketed paste, which this hook turns on, is what separates "the user
  // pasted forty lines" from "the user typed forty lines very fast". Ink routes
  // the text here instead of through useInput, so a paste can never be
  // misparsed as keystrokes — and a big one is folded to a marker rather than
  // rendered at full height into a frame that must stay short.
  usePaste((text) => {
    // **An empty paste is how a pasted image arrives.**
    //
    // `Cmd+V` in a terminal on macOS is the *terminal's* paste, not ours: it
    // sends the clipboard as text, and a screenshot has no text, so the
    // terminal dutifully sends a bracketed paste with nothing between the
    // markers and the app is never told a picture was involved. That is why
    // pasting a screenshot looked broken — `ctrl+v` was bound and working, and
    // it is not the key anybody presses.
    //
    // Ink emits that as `{paste: ''}` (verified against its own parser — there
    // is no emptiness check on the slice), and nothing else produces one, so it
    // is a signal rather than a guess. The clipboard probe costs ~60ms and runs
    // only on this path, which is already the rare one.
    if (text === '' && hasClipboardImage()) {
      handleSubmit('/paste-image');
      return;
    }

    const { value, paste } = applyPaste(input, text, nextPasteId(pastes));
    setInput(value);
    setPaletteSuppressed(true);
    if (paste) addPaste(paste);
  }, { isActive: promptVisible && focus === FOCUS_INPUT });

  return (
    <>
      {isProcessing && !diffRequest && (
        <Box flexDirection="column" marginBottom={compact ? 0 : 1}>
          <Text color="cyan">
            <RunningLine tick={animTick} text={isToolRunningRef.current ? status : thinkingText} />
            <Text dimColor>
              {' ('}{elapsed}s
              {syncTokenEstimate > 0 ? ` · ↑ ${syncTokenEstimate >= 1000 ? `${(syncTokenEstimate / 1000).toFixed(1)}k` : syncTokenEstimate} tokens` : ''}
              {' · esc to stop)'}
            </Text>
          </Text>
          {isThinkingTooLong && (
            <Text color="yellow">  (Taking a while — make sure the Chrome tab is not minimised)</Text>
          )}
        </Box>
      )}

      {/*
        A blank row above the prompt. Without it the input box sits directly
        against the last line of the transcript, and the two read as one block —
        there is nothing to tell you where the agent stopped talking and where
        you start typing. RESERVED_ROWS pays for this row; raising one without
        the other is how the frame outgrows the viewport.
      */}
      {promptVisible && (
        <Box flexDirection="column" marginTop={compact ? 0 : 1}>
          {/*
            What happened to the last conversation.

            Starting without `--continue` files it and clears the screen, which
            from the outside is indistinguishable from losing it. The storage,
            the flags and the picker were all built and nothing ever said a
            session had been put anywhere — asked directly: "didn't we plan on
            displaying the session id for resume?"

            One row, once, and only on the run that filed something. It is
            dismissed by the first message, because after that it is history
            rather than an offer.

            **It used to print `--resume <id>`, and that was the wrong offer.**
            A 28-character timestamp id is not something anyone reads or types,
            and the command it belonged to only works at launch — so the CLI's
            answer to "where did my last chat go?" was to quit and start again.
            Reported as exactly that. `/history` is in the session you are
            already in, lists every conversation rather than the most recent
            one, and says per row whether the model still remembers it.
          */}
          {filedSession && !isProcessing && history.length === 0 && (
            <Box marginBottom={1}>
              <Text dimColor wrap="truncate">
                {'  ↺ previous conversation filed'}
                {filedSession.turns ? `, ${filedSession.turns} turns` : ''}
                {'  · '}
                <Text color="cyan">/history</Text>
                {' to reopen it'}
              </Text>
            </Box>
          )}

          {/*
            Prompts waiting their turn.
            
            They used to be discarded: the loop returns early when busy, and
            the only trace was a status line the thinking cycle painted over —
            while the transcript had already echoed the message and the input
            box had already been cleared. It looked sent. Reported after
            typing four prompts and getting one reply.
            
            Bounded, because this is the live frame: three rows and a count.
            `wrap="truncate"` for the same reason — a queued prompt can be a
            paragraph, and a row that wraps is charged as one and drawn as two.
          */}
          {queued.length > 0 && (
            <Box flexDirection="column" marginBottom={1}>
              {queued.slice(0, 3).map((q, i) => (
                <Text key={i} dimColor wrap="truncate">
                  {'  ⏸ queued  '}{oneLine(q, 64)}
                </Text>
              ))}
              {queued.length > 3 && (
                <Text dimColor>{'  ⏸ '}… {queued.length - 3} more queued</Text>
              )}
            </Box>
          )}

          {hasArtifacts && !isProcessing && (
            <Box flexDirection="column" marginBottom={1}>
              <Text color="cyan" wrap="truncate">
                {artifactsOpen ? '▾ ' : '▸ '}
                {[artifacts.task && 'task.md', artifacts.review && 'review.md',
                  artifacts.walkthrough && 'walkthrough.md'].filter(Boolean).join(' · ')}
                {progress ? <Text dimColor>{'  '}{progress}</Text> : null}
                <Text dimColor>{artifactsOpen ? ' — ctrl+g to collapse' : ' — ctrl+g to expand'}</Text>
              </Text>
              {/*
                Bounded, because this is the live frame. Unbudgeted it cost
                4 clears at 13x80 on a six-item list, on top of the two the
                toggle itself pays — and the toggle used to be ctrl+e, which
                reprints the whole transcript to show you six lines.

                `truncate` per row for the same reason the GitHub rows have
                it: a row that wraps is charged as one and drawn as two.
              */}
              {artifactsOpen && shownArtifactLines.map((line, i) => (
                // eslint-disable-next-line react/no-array-index-key
                <Text key={i} dimColor wrap="truncate">{'  '}{line}</Text>
              ))}
              {artifactsOpen && artifactOverflow > 0 && (
                <Text dimColor>{'  '}… +{artifactOverflow} more — open the file</Text>
              )}
            </Box>
          )}

          {!extensionConnected && (
            <Text color="yellow">! Open a Gemini tab in Chrome — the extension is not connected</Text>
          )}

          {slashOpen && (
            <Box flexDirection="column" paddingX={1}>
              {slashMatches.map((cmd, idx) => (
                <Text key={cmd.name} color={idx === slashSelected ? 'cyan' : 'gray'} bold={idx === slashSelected}>
                  {(idx === slashSelected ? '❯ ' : '  ') + `/${cmd.name}`.padEnd(16)}
                  <Text dimColor>{cmd.desc}</Text>
                </Text>
              ))}
            </Box>
          )}

          {/*
            The border is the mode. Plan vs auto is the answer to "will this
            edit happen without asking me?", and it used to be a yellow chip two
            rows *below* the box it governs — the most consequential state on
            screen rendered as a footnote, for two rows of frame budget. The
            border is already the most visible line here and it costs nothing.
          */}
          <Box
            flexDirection="row"
            borderStyle="round"
            borderColor={focus === FOCUS_INPUT ? (mode === 'plan' ? 'yellow' : 'cyan') : 'gray'}
            paddingX={1}
            width="100%"
          >
            <Text bold color={focus === FOCUS_INPUT ? (mode === 'plan' ? 'yellow' : 'cyan') : 'gray'}>{'> '}</Text>
            <PromptInput
              focus={focus === FOCUS_INPUT}
              value={input}
              cursorRef={cursorRef}
              maxRows={promptMaxRows}
              placeholder="Ask anything, or / for commands"
              onNewline={() => { newlineRef.current = true; }}
              onChange={(v) => {
                setInput(v);
                setSlashIdx(0);
                // Typing is what opens the palette; history recall is not.
                setPaletteSuppressed(false);
              }}
              onSubmit={(value) => {
                // Our own useInput is registered before the key bindings'
                // (child effects run first), so this fires before they have
                // seen the keystroke. Defer a tick to find out whether that
                // Enter was really a Shift+Enter asking for a newline.
                setTimeout(() => {
                  if (newlineRef.current) {
                    newlineRef.current = false;
                    return;
                  }
                  if (slashOpen) {
                    const picked = `/${slashMatches[slashSelected].name}`;
                    setInput('');
                    setSlashIdx(0);
                    handleSubmit(picked);
                    return;
                  }
                  handleSubmit(value);
                }, 0);
              }}
            />
          </Box>
        </Box>
      )}
    </>
  );
}
