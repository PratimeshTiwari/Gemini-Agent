/**
 * Terminal mouse support.
 *
 * Why not `@ink-tools/ink-mouse`'s own provider: it builds its `Mouse` from
 * `useStdin()`, which is the *filtered* stream Ink reads (see stdin-filter.js),
 * so it would never see a mouse byte. Ink's package exports map is `"." only`,
 * so its StdinContext cannot be deep-imported and overridden either. This
 * provider does the same job against raw stdin. Its geometry helpers are still
 * that package's — no reason to reimplement yoga hit-testing.
 *
 * Tracking is on by default so clicks just work. The cost is real and not
 * ours to hide: a terminal that is tracking owns the wheel and the drag, so
 * scrollback and text selection stop working (hold Option/Shift to select).
 * The wheel is reported as a button in every tracking mode, so there is no
 * "clicks only" setting that keeps scrollback — hence `/mouse off`.
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Mouse } from 'xterm-mouse';
import { getBoundingClientRect, getElementDimensions, isPointInRect } from '@ink-tools/ink-mouse';

/** All-motion tracking. `Mouse.enable()` turns it on with no way to opt out. */
const MOTION_TRACKING_OFF = '\x1b[?1003l';

const MouseContext = createContext(null);

/**
 * How far down the screen Ink's frame starts, in rows.
 *
 * Any registered element can reach the root by walking parents, and the root's
 * height is the frame height. Returns 0 until something is registered, which is
 * also the correct answer for a frame that fills the screen.
 */
function frameOffsetY(handlers) {
  for (const entry of handlers.values()) {
    let node = entry.ref?.current;
    if (!node) continue;
    while (node.parentNode) node = node.parentNode;
    const height = getElementDimensions(node)?.height;
    if (!height) continue;
    return Math.max(0, (process.stdout.rows || height) - height);
  }
  return 0;
}

export function MouseProvider({ children, autoEnable = true }) {
  const mouseRef = useRef(null);
  const handlersRef = useRef(new Map());
  const [enabled, setEnabled] = useState(false);
  const [supported, setSupported] = useState(false);

  useEffect(() => {
    if (!Mouse.isSupported(process.stdin, process.stdout)) return undefined;

    const mouse = new Mouse({
      inputStream: process.stdin,
      outputStream: process.stdout,
      // Deliberately inert: Ink owns raw mode for as long as the app runs.
      // xterm-mouse's disable() "restores" whatever it recorded before enable —
      // false, since it never set it — which drops the tty back into line mode
      // and makes Enter insert a newline instead of submitting.
      setRawMode: () => {},
    });

    const dispatch = (type) => (event) => {
      // Mouse coordinates are screen rows; yoga's are rows within Ink's own
      // frame, which starts at 1. Everything <Static> has committed scrolls
      // above that frame, so the two only line up if nothing was ever printed.
      // Once the transcript is longer than the screen — the normal case — the
      // frame sits flush with the bottom, so the gap is height minus height.
      const offsetY = frameOffsetY(handlersRef.current);
      for (const entry of handlersRef.current.values()) {
        if (entry.type !== type) continue;
        const rect = getBoundingClientRect(entry.ref?.current);
        if (rect && isPointInRect(event.x, event.y - offsetY, rect)) entry.handler(event);
      }
    };
    const onClick = dispatch('click');
    const onWheel = dispatch('wheel');

    mouse.on('click', onClick);
    mouse.on('wheel', onWheel);
    mouseRef.current = mouse;
    setSupported(true);
    if (autoEnable) {
      mouse.enable();
      process.stdout.write(MOTION_TRACKING_OFF);
      setEnabled(true);
    }

    return () => {
      mouse.off('click', onClick);
      mouse.off('wheel', onWheel);
      try {
        mouse.disable();
      } catch {
        /* already off, or the terminal went away */
      }
      // disable() pauses the shared stdin; Ink still needs it flowing.
      process.stdin.resume();
      mouseRef.current = null;
    };
  }, [autoEnable]);

  const enable = useCallback(() => {
    const mouse = mouseRef.current;
    if (!mouse || enabled) return;
    mouse.enable();
    // Buttons, drag and wheel are enough; all-motion would put a report on the
    // wire for every cell the pointer crosses.
    process.stdout.write(MOTION_TRACKING_OFF);
    setEnabled(true);
  }, [enabled]);

  const disable = useCallback(() => {
    const mouse = mouseRef.current;
    if (!mouse || !enabled) return;
    mouse.disable();
    process.stdin.resume();
    setEnabled(false);
  }, [enabled]);

  const registry = useMemo(() => ({
    register(id, type, ref, handler) {
      handlersRef.current.set(id, { type, ref, handler });
    },
    unregister(id) {
      handlersRef.current.delete(id);
    },
  }), []);

  const value = useMemo(
    () => ({ enabled, supported, enable, disable, registry }),
    [enabled, supported, enable, disable, registry],
  );

  return <MouseContext.Provider value={value}>{children}</MouseContext.Provider>;
}

let nextHandlerId = 0;

function useMouseHandler(type, ref, handler) {
  const context = useContext(MouseContext);
  const idRef = useRef(null);
  if (idRef.current === null) idRef.current = `${type}-${nextHandlerId++}`;

  useEffect(() => {
    if (!context || !ref || !handler) return undefined;
    const id = idRef.current;
    context.registry.register(id, type, ref, handler);
    return () => context.registry.unregister(id);
  }, [context, type, ref, handler]);
}

/** Fire `handler` when a click lands inside the element `ref` points at. */
export function useOnClick(ref, handler) {
  useMouseHandler('click', ref, handler);
}

/** Fire `handler` when the wheel turns over the element `ref` points at. */
export function useOnWheel(ref, handler) {
  useMouseHandler('wheel', ref, handler);
}

/**
 * Tracking state for the `/mouse` command and the footer indicator.
 * @returns {{ enabled: boolean, supported: boolean, enable: () => void,
 *   disable: () => void, toggle: () => void }}
 */
export function useMouseTracking() {
  const context = useContext(MouseContext);
  const enabled = context?.enabled ?? false;
  const enable = context?.enable;
  const disable = context?.disable;

  const toggle = useCallback(() => {
    if (enabled) disable?.();
    else enable?.();
  }, [enabled, enable, disable]);

  return {
    enabled,
    supported: context?.supported ?? false,
    enable: enable ?? (() => {}),
    disable: disable ?? (() => {}),
    toggle,
  };
}
