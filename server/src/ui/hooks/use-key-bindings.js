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
  input,
  isProcessing,
  newlineRef,
  queued = [],
  setQueued,
  setActiveTab,
  setFocus,
  setHistoryIdx,
  setInput,
  setInputAtEnd,
  cursorRef,
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

    /**
     * Escape, cheapest thing first — and never the destructive one by default.
     *
     * The order used to be: close the palette, else **stop the turn**, else
     * tidy up. So the fallback for "escape while a turn is running" was to
     * kill it, and reaching that fallback took nothing more than having text
     * in the box the palette did not recognise: `//effort` fails
     * `/^\/[a-z-]*$/`, and `/efforttt` matches no command, so `slashOpen` is
     * false for both. Reported twice, from both spellings — typed a command,
     * changed their mind, pressed escape, and the answer the browser was in
     * the middle of producing was thrown away.
     *
     * Clearing what you typed is what escape means in a text field, it is the
     * only branch here that undoes something *you* just did, and it is free.
     * The interrupt is still one key — it just needs the box to be empty
     * first, which is exactly the state you are in when the thing you want to
     * stop is the turn rather than the line.
     */
    if (key.escape) {
      if (slashOpen) {
        setInput('');
        setSlashIdx(0);
        return;
      }
      if (input) {
        setInput('');
        setSlashIdx(0);
        setPaletteSuppressed(false);
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
        setInputAtEnd(`/${slashMatches[slashSelected].name} `);
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
      // Inside a prompt of several lines, up means "up a line". Only when the
      // caret is already on the first line does it mean "the previous command" —
      // the same rule a text field and a shell each follow on their own, and
      // the reason the field cannot decide this for itself is that the slash
      // palette outranks both.
      if (cursorRef?.current?.moveUp?.()) {
        setPaletteSuppressed(true);
        return;
      }
      /**
       * A queued prompt has not been sent yet, so up takes it back.
       *
       * Prompts typed during a turn now wait rather than being discarded —
       * and the thing you want next is almost always to change one you have
       * not sent, not to scroll through ones you have. So while the queue has
       * something in it and the box is empty, up pulls the most recent queued
       * prompt back into the field and drops it from the queue. Press enter
       * and it goes to the back again; press nothing and it is simply gone,
       * which is the "cancel" nobody had to invent a key for.
       *
       * Only when the box is empty: half a typed sentence must not be
       * replaced by something you queued a minute ago.
       */
      if (queued.length > 0 && input === '') {
        setQueued((q) => q.slice(0, -1));
        setInputAtEnd(queued[queued.length - 1]);
        setPaletteSuppressed(true);
        return;
      }

      if (inputHistory.length > 0) {
        const nextIdx = historyIdx === -1 ? inputHistory.length - 1 : Math.max(0, historyIdx - 1);
        setHistoryIdx(nextIdx);
        setInputAtEnd(inputHistory[nextIdx]);
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
      if (cursorRef?.current?.moveDown?.()) {
        setPaletteSuppressed(true);
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
          setInputAtEnd(inputHistory[nextIdx]);
          setPaletteSuppressed(true);
        }
      }
    }
  });
}
