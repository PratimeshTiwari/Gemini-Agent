import { useInput } from 'ink';
import { FOCUS_INPUT, FOCUS_TERMINAL } from '../constants.js';
import { handleGithubKey } from './use-github-keys.js';

/**
 * Every keystroke the app answers outside a text field.
 *
 * The rule this enforces: **printable characters belong to the writing area and
 * nothing else.** Everything this hook claims is either a modifier combination
 * (ctrl+…, shift+tab) or a key that has no business in a prompt (escape, the
 * arrows, tab). The one exception is the GitHub tab, which is a dashboard
 * rather than a prompt — and even there the plain letters are given back the
 * moment a field on it is focused, which is why `a` used to be unusable in the
 * avoid-words editor.
 *
 * Order matters and is load-bearing: a pending diff or an open menu swallows
 * everything so a stray key can never answer for the user, the GitHub tab
 * claims its own letters before the agent hotkeys see them, and shift+tab is
 * checked ahead of plain tab, which would otherwise eat it.
 *
 * The ctrl+ chords are NOT here. They are pulled off stdin in `cli-ui.jsx` and
 * dispatched through `use-hotkeys.js`, because `ink-text-input` types every key
 * it does not recognise into the field and Ink offers no way to stop a handler
 * from running — so a ctrl+e handled here still left an "e" in the prompt.
 *
 * There is no selection model in the transcript and no mouse. Steps open with
 * ctrl+e, which toggles the whole transcript at once — Ink can never repaint
 * what <Static> has already committed, so App reprints it instead.
 */
export function useKeyBindings({
  activeMenu,
  activeTab,
  agentLoop,
  cycleMode,
  diffRequest,
  focus,
  github,
  handleSubmit,
  historyIdx,
  inputHistory,
  isProcessing,
  newlineRef,
  setActiveTab,
  setFocus,
  setHistoryIdx,
  setInput,
  setPaletteSuppressed,
  setSlashIdx,
  setTerminalOpen,
  slashMatches,
  slashOpen,
  slashSelected,
}) {
  useInput((char, key) => {
    // Deliberately inert while a modal owns the screen: diffs and menus are
    // answered through their own SelectInput, so a stray keystroke can never
    // approve an edit or pick an option. Without this the arrow keys would move
    // the menu *and* rewrite the prompt from input history at the same time.
    if (diffRequest || activeMenu) return;

    // Shift+Enter inserts a newline instead of submitting. Terminals only
    // report the modifier under the kitty keyboard protocol, which Ink
    // negotiates in cli-ui; Esc+Enter (\x1b\r) is the fallback terminals are
    // commonly configured to send, and reaches us as meta+return.
    if (key.return && (key.shift || key.meta)) {
      newlineRef.current = true;
      setInput((value) => `${value}\n`);
      return;
    }

    if (activeTab === 'github') {
      handleGithubKey(char, key, { github, agentLoop, handleSubmit, setActiveTab });
      return;
    }

    // Shift+Tab cycles plan <-> auto. Checked before the plain Tab handler,
    // which would otherwise swallow it.
    if (key.tab && key.shift) {
      cycleMode();
      return;
    }

    // Escape cancels processing if active, otherwise closes whatever is open
    // and puts the caret back in the prompt.
    if (key.escape) {
      if (slashOpen) {
        setInput('');
        setSlashIdx(0);
        return;
      }
      if (isProcessing) {
        handleSubmit(':stop');
        return;
      }
      setTerminalOpen(false);
      setFocus(FOCUS_INPUT);
      return;
    }

    // Tab completes an open slash command, and is otherwise the way back to the
    // writing area — the prompt used to advertise it and do nothing.
    if (key.tab) {
      if (slashOpen) {
        setInput(`/${slashMatches[slashSelected].name} `);
        setSlashIdx(0);
        return;
      }
      setTerminalOpen(false);
      setFocus(FOCUS_INPUT);
      return;
    }

    // The scratch shell owns its own arrows.
    if (focus === FOCUS_TERMINAL) return;

    if (key.upArrow) {
      if (slashOpen) {
        setSlashIdx(Math.max(0, slashSelected - 1));
        return;
      }
      if (inputHistory.length > 0) {
        const nextIdx = historyIdx === -1 ? inputHistory.length - 1 : Math.max(0, historyIdx - 1);
        setHistoryIdx(nextIdx);
        setInput(inputHistory[nextIdx]);
        // A recalled "/command" must not open the palette, which would take
        // these very arrows over and strand the user mid-scroll.
        setPaletteSuppressed(true);
      }
      return;
    }

    if (key.downArrow) {
      if (slashOpen) {
        setSlashIdx(Math.min(slashMatches.length - 1, slashSelected + 1));
        return;
      }
      if (historyIdx !== -1) {
        const nextIdx = historyIdx + 1;
        if (nextIdx >= inputHistory.length) {
          setHistoryIdx(-1);
          setInput('');
          setPaletteSuppressed(false);
        } else {
          setHistoryIdx(nextIdx);
          setInput(inputHistory[nextIdx]);
          setPaletteSuppressed(true);
        }
      }
    }
  });
}
