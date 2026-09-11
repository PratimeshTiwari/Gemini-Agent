import { useEffect, useRef } from 'react';
import { hotkeys } from '../hotkeys.js';

/**
 * Subscribe to the application chords `cli-ui.jsx` pulls off stdin.
 *
 * The handlers close over state that changes every render, so they are kept in
 * a ref and the listeners are attached exactly once. Re-subscribing on every
 * render would be a listener leak and a re-entrancy hazard while a chord is
 * being dispatched.
 *
 * @param {Record<string, () => void>} handlers - keyed by event name
 * @param {boolean} [isActive] - false while a modal owns the screen, so a
 *   chord cannot act behind a diff or a menu the user has not answered.
 */
export function useHotkeys(handlers, isActive = true) {
  const ref = useRef(handlers);
  ref.current = handlers;

  const activeRef = useRef(isActive);
  activeRef.current = isActive;

  useEffect(() => {
    const names = Object.keys(ref.current);
    const listeners = names.map((name) => {
      const listener = () => {
        if (!activeRef.current) return;
        ref.current[name]?.();
      };
      hotkeys.on(name, listener);
      return [name, listener];
    });
    return () => {
      for (const [name, listener] of listeners) hotkeys.off(name, listener);
    };
  }, []);
}
