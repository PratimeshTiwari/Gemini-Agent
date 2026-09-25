/**
 * Which option the picker is actually on, read from the trigger.
 *
 * `switch_model` used to confirm a switch by calling `readModelOptions()` —
 * a **second** open of the menu, moments after the click closed it, purely to
 * read `selected` off the items. `selectModelByLabel` already had those items
 * from the open it performed itself, and `currentModelLabel` exists precisely
 * so the current model can be read with one DOM query and no interaction; its
 * own comment says to use it *instead of* `readModelOptions` for exactly this
 * reason.
 *
 * The cost of the second open was a menu left across the composer while the
 * session's first prompt was being typed into it, so the send landed on the
 * backdrop. Reported with two screenshots: the picker open over an unsent
 * prompt, with `3.1 Pro` correctly ticked behind it. **The switch had worked.**
 * The confirmation is what broke the turn.
 *
 * What this file guards is the comparison that replaced it, because the
 * obvious version of it is wrong.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadFunction } from '../load-content-script.js';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '../../content-scripts/gemini-bridge.js');

const norm = (s) => String(s || '').trim().toLowerCase();
const markSelected = loadFunction(SCRIPT, 'markSelected', { norm });

/** The live picker, in the order the DOM returns it. */
const PICKER = [
  { label: '3.5 Flash-Lite', description: 'Fastest answers' },
  { label: '3.8 Flash', description: 'All-around help' },
  { label: '3.1 Pro', description: 'Advanced reasoning' },
  { label: 'Extended thinking', description: 'Complex problem solving' },
];

const selected = (rows) => (rows.find((m) => m.selected) || {}).label ?? null;

test('the trigger saying "Pro" selects 3.1 Pro', () => {
  assert.equal(selected(markSelected(PICKER, 'Pro')), '3.1 Pro');
});

/*
 * The one that matters, and the reason substring alone will not do.
 *
 * `3.8 Flash` and `3.5 Flash-Lite` both contain "flash", and Flash-Lite comes
 * first in the DOM — so a plain `find` on a substring match confirms the *lite*
 * model when you switched to Flash, on the one code path whose whole purpose is
 * to report the truth rather than the request.
 */
test('the trigger saying "Flash" does not select Flash-Lite', () => {
  const rows = markSelected(PICKER, 'Flash');
  assert.equal(selected(rows), '3.8 Flash',
    'substring matching picked the first entry that happened to contain the word');
  assert.equal(rows.filter((m) => m.selected).length, 1, 'two options marked selected');
});

test('and "Flash-Lite" selects Flash-Lite', () => {
  assert.equal(selected(markSelected(PICKER, 'Flash-Lite')), '3.5 Flash-Lite');
});

test('an option with no version prefix still resolves', () => {
  assert.equal(selected(markSelected(PICKER, 'Extended thinking')), 'Extended thinking');
});

test('the version number moving does not break it', () => {
  // `3.1 Pro` → `3.2 Pro` is the rename this is designed to survive, and the
  // trigger drops the number entirely.
  const next = [{ label: '4.0 Pro', description: 'Advanced reasoning' }];
  assert.equal(selected(markSelected(next, 'Pro')), '4.0 Pro');
});

test('a name the picker does not offer selects nothing', () => {
  const rows = markSelected(PICKER, 'Ultra');
  assert.equal(selected(rows), null,
    'a name nobody offers must not land on a model by accident');
});

test('and an empty trigger label selects nothing', () => {
  assert.equal(selected(markSelected(PICKER, '')), null);
  assert.equal(selected(markSelected(PICKER, null)), null);
});

// Ambiguity is an answer of "no", the same rule `pickModelFor` applies to a
// config pin: one hit is an answer, several are not.
test('an ambiguous substring selects nothing rather than guessing', () => {
  const twins = [
    { label: 'Nova Alpha', description: '' },
    { label: 'Nova Beta', description: '' },
  ];
  assert.equal(selected(markSelected(twins, 'Nova')), null);
});
