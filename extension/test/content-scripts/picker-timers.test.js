/**
 * The mode picker is read in a hidden tab, so it must not wait on a page timer.
 *
 * CLAUDE.md measured this once already, for completion detection: a page's own
 * `setInterval` in a hidden tab delivers **1.9%** of its ticks, collapsing to
 * roughly one per minute within 60 seconds, while a `MutationObserver` runs at
 * full rate and layout still works. The clock for completion was moved into the
 * service worker; the picker was left behind on the same throttled clock.
 *
 * That mattered because the picker is *always* read hidden. `discover_models`
 * and `switch_model` are messages to the tab rather than turns, so nothing
 * brings it to the front first — unlike an inject, which activates the tab to
 * paste and is why the `send` stage measures ~500ms while this one does not.
 *
 * The old code polled `20 × 50ms` to open the menu and `8 × 50ms` to confirm it
 * closed, the second of those inside the `finally` that the answer returns
 * through. Nominally 1.4 seconds; clamped, ≥28. The server gives it 8.
 * In `.agent/logs/errors.jsonl` that shows as 36 `model_options_unanswered`,
 * only 13 of which were "no tab to ask" — the other 23 reached a tab and the
 * answer was simply too late to be wanted.
 *
 * So these tests run `waitForDom` with `setTimeout` clamped the way Chrome
 * clamps it, which is the negative control: on the old code every one of them
 * fails by timing out, and a poll loop reintroduced later fails them again.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { loadFunction } from '../load-content-script.js';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '../../content-scripts/gemini-bridge.js');
const src = readFileSync(SCRIPT, 'utf8');

/**
 * A DOM whose timers are throttled the way a hidden tab's are.
 *
 * One minute is the floor Chrome's intensive throttling reaches, and every test
 * here finishes in milliseconds — so anything that resolves has resolved on a
 * mutation, and anything waiting on a timer simply never finishes.
 */
const HIDDEN_TAB_CLAMP_MS = 60_000;

function hiddenTab() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const { window } = dom;
  const timers = [];

  return {
    window,
    globals: {
      document: window.document,
      MutationObserver: window.MutationObserver,
      performance: window.performance,
      setTimeout: (fn) => {
        // Scheduled at the clamp, and never run by these tests.
        const id = timers.length;
        timers.push(fn);
        return id;
      },
      clearTimeout: () => {},
    },
    /** Fire what the page scheduled, standing in for a minute passing. */
    runClampedTimers() {
      const due = timers.splice(0);
      for (const fn of due) fn();
    },
    pendingTimers: () => timers.length,
    clamp: HIDDEN_TAB_CLAMP_MS,
  };
}

function load(tab) {
  return loadFunction(SCRIPT, 'waitForDom', tab.globals);
}

test('a condition already true does not touch a timer at all', async () => {
  const tab = hiddenTab();
  const waitForDom = load(tab);

  const got = await waitForDom(() => 'ready', tab.clamp);

  assert.equal(got, 'ready');
  assert.equal(tab.pendingTimers(), 0,
    'the fast path scheduled a backstop it did not need');
});

test('the menu opening resolves it, with the timer still pending', async () => {
  const tab = hiddenTab();
  const waitForDom = load(tab);
  const { document } = tab.window;

  const pending = waitForDom(
    () => document.querySelectorAll('.menu-item').length > 1
      ? [...document.querySelectorAll('.menu-item')]
      : null,
    tab.clamp,
  );

  // What the picker does a few hundred milliseconds after the trigger is
  // clicked. The observer sees it; the clamped timer is still a minute away.
  const menu = document.createElement('div');
  menu.innerHTML = '<div class="menu-item">Fast</div><div class="menu-item">Pro</div>';
  document.body.appendChild(menu);

  const items = await pending;

  assert.equal(items.length, 2, 'the observer never delivered the menu');
  assert.equal(items[1].textContent, 'Pro');
});

test('an attribute flip resolves it too — the trigger relabels in place', async () => {
  const tab = hiddenTab();
  const waitForDom = load(tab);
  const { document } = tab.window;

  const trigger = document.createElement('button');
  trigger.setAttribute('aria-label', 'Open mode picker, currently Fast');
  document.body.appendChild(trigger);

  const pending = waitForDom(
    () => /currently Pro/.test(trigger.getAttribute('aria-label')) || null,
    tab.clamp,
  );

  // `selectModelByLabel` waits on exactly this, in place of a 300ms sleep that
  // is not 300ms in a hidden tab. A childList-only observer would miss it.
  trigger.setAttribute('aria-label', 'Open mode picker, currently Pro');

  assert.equal(await pending, true);
});

test('nothing happening still settles, through the backstop', async () => {
  const tab = hiddenTab();
  const waitForDom = load(tab);

  const pending = waitForDom(() => null, tab.clamp);
  assert.equal(tab.pendingTimers(), 1, 'a still page would hang with no timer');

  // The one place a throttled timer is acceptable: it only makes a *failure*
  // late, and the server has already logged the silence by then.
  tab.runClampedTimers();

  assert.equal(await pending, null);
});

test('a mutation that does not satisfy the predicate does not resolve early', async () => {
  const tab = hiddenTab();
  const waitForDom = load(tab);
  const { document } = tab.window;

  let settled = false;
  const pending = waitForDom(() => document.querySelector('.menu-item'), tab.clamp)
    .then((v) => { settled = true; return v; });

  // Gemini's page mutates constantly on its own; only the menu counts.
  document.body.appendChild(document.createElement('span'));
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, false);

  const item = document.createElement('div');
  item.className = 'menu-item';
  document.body.appendChild(item);
  assert.ok(await pending);
});

/*
 * The menu that opens after we stopped waiting.
 *
 * Reported with a screenshot on 2026-09-25: the picker open over a composer
 * that was holding an unsent prompt. `closeModelMenu` used to click only when
 * `aria-expanded` was true *at that instant*, so an open budget that expired
 * a moment before the component set the attribute left the menu up with
 * nobody to close it. This file's own header says what that costs — a menu
 * left open swallows the next click, so the *following* turn's send lands on
 * the backdrop and the tab looks dead, two turns from the cause.
 */
test('a menu that opens late is still closed', async () => {
  const tab = hiddenTab();
  const waitForDom = load(tab);
  const { document } = tab.window;

  const trigger = document.createElement('button');
  trigger.setAttribute('aria-expanded', 'false');
  document.body.appendChild(trigger);
  let clicks = 0;
  trigger.addEventListener('click', () => { clicks += 1; });

  // What `closeModelMenu` does: wait for open, then click.
  const closing = waitForDom(
    () => trigger.getAttribute('aria-expanded') === 'true' || null,
    tab.clamp,
  ).then((open) => { if (open) trigger.click(); });

  assert.equal(clicks, 0, 'clicked a menu that was not open — that re-opens it');

  // The component catches up after the open budget already expired.
  trigger.setAttribute('aria-expanded', 'true');
  await closing;

  assert.equal(clicks, 1, 'the late menu was left open, and it eats the next send');
});

/*
 * And the poll loops must not come back.
 *
 * Both were plain `for` loops around `await new Promise(r => setTimeout(r, 50))`
 * — the most ordinary-looking code in the file, and the reason this is asserted
 * against the source rather than only against behaviour. A reviewer reading a
 * reintroduced poll sees a bounded wait, not a 28-second one.
 */
test('neither menu function waits on a page timer', () => {
  for (const name of ['openModelMenu', 'closeModelMenu']) {
    const start = src.indexOf(`function ${name}(`);
    assert.ok(start > -1, `${name} is gone — this test needs rewriting, not deleting`);
    const body = src.slice(start, src.indexOf('\n}', start));
    assert.ok(!/setTimeout/.test(body),
      `${name} is polling on a page timer again; in a hidden tab that is ~1 tick/second`);
  }
});

/*
 * The budget is a real deadline now, so its value matters in a way it did not
 * when throttling was silently paying for it. `20 × 50ms` read as one second
 * and waited twenty-plus; a literal 1000ms was a 20× cut nobody chose.
 */
test('and closeModelMenu is the function that does that, not a one-shot read', () => {
  const start = src.indexOf('async function closeModelMenu(');
  assert.ok(start > -1, 'closeModelMenu no longer waits for the menu it is closing');
  const body = src.slice(start, src.indexOf('\n}', start));
  assert.ok(/waitForDom/.test(body),
    'closeModelMenu checks aria-expanded once again; a menu that opens a moment '
    + 'later is then left up, and it swallows the next turn\'s send');
});

test('the open budget leaves room for a slow render, and beats the watchdog', () => {
  const open = Number(/const MENU_OPEN_BUDGET_MS = (\d+);/.exec(src)[1]);
  assert.ok(open >= 2000, `${open}ms is tighter than the throttled budget it replaced`);
  assert.ok(open < 8000, `${open}ms outlasts the server's 8s watchdog, so the answer is unwanted`);
});

test('the close is not awaited by the read that returns the list', () => {
  const start = src.indexOf('async function readModelOptions(');
  const body = src.slice(start, src.indexOf('\n}', start));
  assert.ok(/(?<!await )closeModelMenu\(trigger\)/.test(body),
    'the model list is being held behind the menu closing again');
});

/*
 * A freshly opened tab does not have a picker yet.
 *
 * `waitForBridge` gates on `canType` — the composer being in the DOM — which
 * is the right precondition for an *inject*. The mode picker is a different
 * control and Angular renders it a beat later, so a read fired the moment the
 * tab is ready finds no trigger, or a trigger whose menu is still empty.
 *
 * Reported from use exactly that way: the first `/effort` after a tab was
 * opened failed with "the picker did not open, or has no options" and the
 * second worked. That race is why the tab had to be opened by hand once before
 * the feature would work at all.
 */
test('a trigger that mounts late is still found', async () => {
  const tab = hiddenTab();
  const waitForDom = load(tab);
  const { document } = tab.window;

  const pending = waitForDom(() => document.querySelector('[data-test-id="bard-mode-menu-button"]'), tab.clamp);

  // Angular catching up, a beat after the composer was ready.
  const trigger = document.createElement('button');
  trigger.setAttribute('data-test-id', 'bard-mode-menu-button');
  document.body.appendChild(trigger);

  assert.ok(await pending, 'the read gave up before the picker had mounted');
});

test('the read waits for the trigger, and retries an empty menu once', () => {
  const body = src.slice(src.indexOf('async function readModelOptions('), src.indexOf('\n}', src.indexOf('async function readModelOptions(')));
  assert.match(body, /waitForDom\(/,
    'readModelOptions throws the moment the trigger is missing, so a tab opened '
    + 'for this very purpose is too young to answer');
  assert.match(body, /items = await openModelMenu\(trigger\)/,
    'an empty menu is reported as broken rather than retried');
});

test('and the wait is bounded, so a genuinely missing picker still fails', () => {
  const budget = Number(/const PICKER_READY_BUDGET_MS = (\d+);/.exec(src)[1]);
  assert.ok(budget > 0 && budget <= 15000,
    `${budget}ms — a changed selector would hang every read instead of erroring`);
});
