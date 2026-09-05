import React from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import { Clickable } from './Clickable.jsx';
import { FOCUS_INPUT } from '../constants.js';

/**
 * The bottom of the agent tab: the thinking line while a turn runs, then the
 * prompt itself with its slash palette and the plan/auto chip.
 *
 * The palette rows and the chip are clickable as well as keyboard-driven —
 * clicking a row submits it outright rather than only completing it.
 */
export function InputBar({
  activeMenu,
  cycleMode,
  diffRequest,
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
  setFocus,
  setInput,
  setSlashIdx,
  slashMatches,
  slashOpen,
  slashSelected,
  status,
  syncTokenEstimate,
  terminalOpen,
  thinkingDisplayText,
}) {
  return (
    <>
      {/* Status Spinner */}
      {isProcessing && !diffRequest && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="cyan">
            <Spinner type="dots" /> {isToolRunningRef.current ? status : (thinkingDisplayText || status)}
            <Text dimColor>
              {' ('}{elapsed}s
              {syncTokenEstimate > 0 ? ` · ↑ ${syncTokenEstimate >= 1000 ? `${(syncTokenEstimate / 1000).toFixed(1)}k` : syncTokenEstimate} tokens` : ''}
              {')'}
            </Text>
          </Text>
          {isThinkingTooLong && (
            <Text color="yellow">  (Taking a while... ensure Chrome is not minimized!)</Text>
          )}
        </Box>
      )}

      {/* Main Input */}
      {!diffRequest && !terminalOpen && !activeMenu && (
        <Box flexDirection="column" marginTop={1}>
          {!extensionConnected && (
            <Box marginBottom={1}>
              <Text color="yellow">⚠️ Open a Gemini tab in Chrome — the extension is not connected</Text>
            </Box>
          )}
          {slashOpen && (
            <Box flexDirection="column" marginBottom={1} paddingX={1}>
              {slashMatches.map((cmd, idx) => (
                <Clickable
                  key={cmd.name}
                  onClick={() => {
                    setInput('');
                    setSlashIdx(0);
                    handleSubmit(`/${cmd.name}`);
                  }}
                  flexDirection="row"
                >
                  <Text color={idx === slashSelected ? 'cyan' : 'gray'} bold={idx === slashSelected}>
                    {(idx === slashSelected ? '❯ ' : '  ') + `/${cmd.name}`.padEnd(16)}
                  </Text>
                  <Text dimColor>{cmd.desc}</Text>
                </Clickable>
              ))}
            </Box>
          )}
          <Clickable
            onClick={() => setFocus(FOCUS_INPUT)}
            flexDirection="row"
            borderStyle="round"
            borderColor={focus === FOCUS_INPUT ? 'cyan' : 'gray'}
            paddingX={1}
            width="100%"
          >
            <Text bold color={focus === FOCUS_INPUT ? 'cyan' : 'gray'}>{'> '}</Text>
            {focus === FOCUS_INPUT ? (
              <TextInput
                focus={focus === FOCUS_INPUT}
                value={input}
                onChange={(v) => {
                  setInput(v);
                  setSlashIdx(0);
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
            ) : (
              <Text dimColor>{input || 'Press Tab to focus input…'}</Text>
            )}
          </Clickable>
          <Clickable onClick={cycleMode} paddingX={1}>
            <Text color={mode === 'auto' ? 'green' : 'yellow'}>
              ▶▶ {mode} mode on <Text dimColor>(shift+tab to cycle)</Text>
            </Text>
          </Clickable>
        </Box>
      )}
    </>
  );
}
