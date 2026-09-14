import React, { useState, useEffect, useRef } from 'react';
import { Text, useInput } from 'ink';

/**
 * The prompt field. Replaces `ink-text-input`, which could not do two things
 * this needs.
 *
 * **It owns its cursor and never gives it back.** `ink-text-input` reads
 * `value.length` into `cursorOffset` once, on mount, and its only effect clamps
 * the offset *down* when the value shrinks — nothing moves it forward when the
 * value grows, and there is no prop to set it. So text put into the prompt from
 * outside the keyboard (an editor selection, a failed terminal command, a
 * recalled history entry, a completed slash command) left the caret at column
 * zero and the next thing typed landed in front of the paste. The workaround was
 * to remount the field on every such write, which is a strange thing for the
 * most-used component in the app to be doing.
 *
 * **It has no idea what a line is.** A prompt long enough to need a second line
 * is ordinary — a stack trace, a spec, a paragraph of context — and up/down
 * inside one has to mean "move a line", not "recall the previous command".
 * That decision cannot be made without knowing which line the caret is on.
 *
 * Deliberately *not* handled here: up and down. Those stay in
 * `use-key-bindings`, where the precedence between the slash palette, line
 * movement and input history already lives; it calls `moveUp`/`moveDown`
 * through `cursorRef` and uses the boolean they return to decide whether the
 * keypress was spent. Ink has no way to stop a handler running, so the rule is
 * that exactly one place answers a given key.
 *
 * Newlines are `ctrl+j` (a literal line feed, which every terminal sends and no
 * protocol negotiation can take away) and `shift+enter` where the terminal
 * speaks the kitty keyboard protocol. Enter on its own always submits.
 */
export function PromptInput({
  value,
  onChange,
  onSubmit,
  onNewline,
  focus = true,
  placeholder = '',
  cursorRef,
}) {
  const [offset, setOffset] = useState(value.length);

  /**
   * The last value this component itself produced.
   *
   * Everything here is a controlled edit: a keystroke calls `onChange`, the
   * parent stores it, and it comes back as a new `value`. Without a way to
   * recognise its own work the effect below treats every edit as text arriving
   * from outside and drags the caret to the end — so backspacing in the middle
   * of a line deleted the right character and then put the caret after the last
   * one, and the next keystroke landed at the end.
   */
  const selfEdit = useRef(value);
  const lastValue = useRef(value);

  const edit = (next, nextOffset) => {
    selfEdit.current = next;
    lastValue.current = next;
    setOffset(nextOffset);
    onChange(next);
  };

  // Text that arrived from somewhere else — a paste, a recalled history entry, a
  // cleared prompt — puts the caret at the end, which is where someone who has
  // just been handed text wants to carry on typing.
  useEffect(() => {
    if (value === lastValue.current) return;
    lastValue.current = value;
    if (value === selfEdit.current) return;
    setOffset(value.length);
  }, [value]);

  /** Line and column for an offset, so up/down can keep the column. */
  const locate = (text, at) => {
    const before = text.slice(0, at);
    const lines = before.split('\n');
    return { line: lines.length - 1, column: lines[lines.length - 1].length };
  };

  /** The offset of the start of each line. */
  const lineStarts = (text) => {
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
    return starts;
  };

  const moveByLine = (delta) => {
    const starts = lineStarts(value);
    const { line, column } = locate(value, offset);
    const target = line + delta;
    if (target < 0 || target >= starts.length) return false;   // the caller takes it
    const start = starts[target];
    const end = target + 1 < starts.length ? starts[target + 1] - 1 : value.length;
    setOffset(Math.min(start + column, end));
    return true;
  };

  // The imperative handle use-key-bindings reaches through. A ref rather than
  // props because the answer ("did that arrow move the caret?") has to come back
  // synchronously, inside the keypress.
  if (cursorRef) {
    cursorRef.current = {
      moveUp: () => moveByLine(-1),
      moveDown: () => moveByLine(1),
      isMultiline: () => value.includes('\n'),
      toEnd: () => setOffset(value.length),
    };
  }

  useInput((input, key) => {
    // Up and down belong to use-key-bindings; see the note above.
    if (key.upArrow || key.downArrow) return;
    if (key.tab) return;                       // cycles menus elsewhere

    if (key.leftArrow) { setOffset((n) => Math.max(0, n - 1)); return; }
    if (key.rightArrow) { setOffset((n) => Math.min(value.length, n + 1)); return; }

    if (key.return) {
      // Shift+Enter, or Esc+Enter arriving as meta, means a newline. The parent
      // owns the distinction because it also has to stop `onSubmit` firing.
      if (key.shift || key.meta) {
        onNewline?.();
        edit(`${value.slice(0, offset)}\n${value.slice(offset)}`, offset + 1);
        return;
      }
      onSubmit?.(value);
      return;
    }

    if (key.backspace || key.delete) {
      if (offset === 0) return;
      edit(value.slice(0, offset - 1) + value.slice(offset), offset - 1);
      return;
    }

    if (key.ctrl || key.escape) {
      // ctrl+j is a line feed and is the newline that works in every terminal.
      if (input === '\n') {
        onNewline?.();
        edit(`${value.slice(0, offset)}\n${value.slice(offset)}`, offset + 1);
      }
      return;                                   // every other chord is handled upstream
    }

    if (!input) return;
    // A bare line feed can also arrive without the ctrl flag depending on the
    // terminal, and it means the same thing.
    if (input === '\n') {
      onNewline?.();
      edit(`${value.slice(0, offset)}\n${value.slice(offset)}`, offset + 1);
      return;
    }
    edit(value.slice(0, offset) + input + value.slice(offset), offset + input.length);
  }, { isActive: focus });

  if (!value) {
    return focus
      ? <Text><Text inverse>{placeholder.slice(0, 1) || ' '}</Text><Text dimColor>{placeholder.slice(1)}</Text></Text>
      : <Text dimColor>{placeholder}</Text>;
  }

  // The caret is drawn rather than moved: Ink repaints the frame wherever it
  // likes, so a real terminal cursor would land in the wrong place.
  if (!focus) return <Text>{value}</Text>;
  const at = Math.min(offset, value.length);
  return (
    <Text>
      {value.slice(0, at)}
      <Text inverse>{value[at] === undefined || value[at] === '\n' ? ' ' : value[at]}</Text>
      {value[at] === '\n' ? value.slice(at) : value.slice(at + 1)}
    </Text>
  );
}
