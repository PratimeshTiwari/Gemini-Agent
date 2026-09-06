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
import { appendFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Mouse } from 'xterm-mouse';
import { getBoundingClientRect, getElementDimensions } from '@ink-tools/ink-mouse';
import { BUTTON_TRACKING, frameOffsets, pickTarget } from './hit-test.js';


const MouseContext = createContext(null);

/**
 * Click tracing, for when clicks reach the terminal but land on nothing.
 *
 * Set GEMINI_AGENT_MOUSE_DEBUG=1 and every click appends a line to
 * <tmpdir>/gemini-agent-mouse.log: where the terminal said the pointer was,
 * how many targets were registered, what frame geometry we inferred, and which
 * offset (if any) resolved a hit. Silent and free when the variable is unset.
 */
const DEBUG = Boolean(process.env.GEMINI_AGENT_MOUSE_DEBUG);
const DEBUG_LOG = join(tmpdir(), 'gemini-agent-mouse.log');

function trace(line) {
  if (!DEBUG) return;
  try {
    appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* diagnostics must never break the app */
  }
}

/**
 * Ink's frame height, found by walking any registered element up to the root.
 * The offset search in hit-test.js needs it to place the frame on the screen.
 */
function frameHeight(entries) {
  for (const entry of entries) {
    let node = entry.ref?.current;
    if (!node) continue;
    while (node.parentNode) node = node.parentNode;
    const height = getElementDimensions(node)?.height;
    if (height) return height;
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
      const entries = [...handlersRef.current.values()].filter((e) => e.type === type);
      const candidates = entries.map((entry) => ({
        entry,
        rect: getBoundingClientRect(entry.ref?.current),
      }));

      if (DEBUG && type === 'click') {
        const withRect = candidates.filter((c) => c.rect);
        const height = frameHeight(entries);
        trace(
          `click x=${event.x} y=${event.y} | targets=${entries.length} withRect=${withRect.length}`
          + ` | frameHeight=${height} rows=${process.stdout.rows} offsets=${JSON.stringify(frameOffsets(height, process.stdout.rows))}`
          + ` | rects=${JSON.stringify(withRect.slice(0, 8).map((c) => [c.rect.top, c.rect.bottom, c.rect.left, c.rect.right]))}`,
        );
      }
      // Try the bottom-anchored offset first, then no offset at all. Which one
      // is right depends on whether the transcript has outgrown the screen yet,
      // and an element's own bounds are a better test of that than arithmetic:
      // whichever offset actually lands on something is the one in effect.
      for (const offsetY of frameOffsets(frameHeight(entries), process.stdout.rows)) {
        const target = pickTarget(candidates, event.x, event.y - offsetY);
        if (target) {
          if (DEBUG && type === 'click') trace(`  hit at offset ${offsetY} (y=${event.y - offsetY})`);
          target.entry.handler(event);
          return;
        }
      }
      if (DEBUG && type === 'click') trace('  no target matched at any offset');
    };
    const onClick = dispatch('click');
    const onWheel = dispatch('wheel');

    mouse.on('click', onClick);
    mouse.on('wheel', onWheel);
    mouseRef.current = mouse;
    setSupported(true);
    if (autoEnable) {
      mouse.enable();
      process.stdout.write(BUTTON_TRACKING);
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
    process.stdout.write(BUTTON_TRACKING);
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
