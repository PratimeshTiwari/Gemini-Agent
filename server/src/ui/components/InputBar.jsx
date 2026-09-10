import React from 'react';
import { Box, Text, usePaste } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import { FOCUS_INPUT } from '../constants.js';
import { applyPaste, attachedPastes, nextPasteId } from '../paste.js';

/** First `n` non-empty lines of an artifact, for the one-glance summary. */
function head(text, n) {
  return String(text || '')
    .split('\n')
    .filter((l) => l.trim())
    .slice(0, n)
    .join('\n');
}

/**
 * The bottom of the agent tab: the thinking line while a turn runs, then the
 * prompt with its slash palette and the plan/auto chip.
 *
 * Everything here is bounded on purpose. It sits in Ink's repainted frame, so
 * an unbounded row — the artifact dump this used to render in full — pushes the
 * frame past the viewport and Ink starts clearing the terminal on every render.
 *
 * The text field is the only place keystrokes land. It is always mounted while
 * the prompt is visible, so there is no state in which typing goes nowhere.
 */
export function InputBar({
  activeMenu,
  addPaste,
  artifacts,
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
}) {
  const hasArtifacts = Boolean(artifacts?.task || artifacts?.walkthrough);
  // Derived from the prompt, not from the list — see attachedPastes.
  const attached = attachedPastes(input, pastes);
  const promptVisible = !diffRequest && !terminalOpen && !activeMenu;

  // Bracketed paste, which this hook turns on, is what separates "the user
  // pasted forty lines" from "the user typed forty lines very fast". Ink routes
  // the text here instead of through useInput, so a paste can never be
  // misparsed as keystrokes — and a big one is folded to a marker rather than
  // rendered at full height into a frame that must stay short.
  usePaste((text) => {
    const { value, paste } = applyPaste(input, text, nextPasteId(pastes));
    setInput(value);
    setPaletteSuppressed(true);
    if (paste) addPaste(paste);
  }, { isActive: promptVisible && focus === FOCUS_INPUT });

  return (
    <>
      {isProcessing && !diffRequest && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="cyan">
            <Spinner type="dots" /> {isToolRunningRef.current ? status : thinkingText}
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

      {promptVisible && (
        <Box flexDirection="column">
          {hasArtifacts && !isProcessing && (
            <Box flexDirection="column" marginBottom={1}>
              <Text color="yellow">
                📋 {[artifacts.task && 'task.md', artifacts.walkthrough && 'walkthrough.md'].filter(Boolean).join(' · ')}
                <Text dimColor>{verbose ? '' : ' — ctrl+e to expand'}</Text>
              </Text>
              {verbose && artifacts.task && (
                <Text dimColor wrap="wrap">{head(artifacts.task, 6)}</Text>
              )}
              {verbose && artifacts.walkthrough && (
                <Text dimColor wrap="wrap">{head(artifacts.walkthrough, 6)}</Text>
              )}
            </Box>
          )}

          {!extensionConnected && (
            <Text color="yellow">⚠️  Open a Gemini tab in Chrome — the extension is not connected</Text>
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

          <Box
            flexDirection="row"
            borderStyle="round"
            borderColor={focus === FOCUS_INPUT ? 'cyan' : 'gray'}
            paddingX={1}
            width="100%"
          >
            <Text bold color={focus === FOCUS_INPUT ? 'cyan' : 'gray'}>{'> '}</Text>
            <TextInput
              focus={focus === FOCUS_INPUT}
              value={input}
              onChange={(v) => {
                setInput(v);
                setSlashIdx(0);
                // Typing is what opens the palette; history recall is not.
                setPaletteSuppressed(false);
              }}
              onSubmit={(value) => {
                // TextInput's own useInput is registered before ours (child
                // effects run first), so it calls this before the key bindings
                // have seen the keystroke. Defer a tick to find out whether
                // that Enter was really a Shift+Enter asking for a newline.
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
              placeholder="Ask anything, or / for commands"
            />
          </Box>

          <Box paddingX={1} marginTop={1}>
            <Text color={mode === 'auto' ? 'green' : 'yellow'}>
              ▶▶ {mode} mode on <Text dimColor>(shift+tab to cycle)</Text>
              {attached.length > 0 && (
                <Text dimColor>
                  {'  · '}{attached.length} paste{attached.length === 1 ? '' : 's'} attached
                  {' — delete the marker to drop one'}
                </Text>
              )}
            </Text>
          </Box>
        </Box>
      )}
    </>
  );
}
