/**
 * Everything a content script sends must have a relay in the worker.
 *
 * This is the test that would have saved five releases.
 *
 * `readModelOptions` worked the whole time — measured against the live page at
 * 27.7ms, returning every option with `selected` correct. It handed the list to
 * `safeSend`, which is `chrome.runtime.sendMessage`, which arrives at the
 * worker's relay in `main.js` — where `model_options` was **not a case**. It
 * fell to `default`, was dropped one hop before the socket, and the server
 * waited out every budget it had and reported, accurately, that nothing came
 * back.
 *
 * `gemini_response` *is* in that list. That single difference is why prompts
 * worked while `/effort`, `ctrl+b` and the mismatch warning did not, and why
 * five fixes aimed at every other hop could not have helped.
 *
 * CLAUDE.md states the rule, about the side panel: *"a surface that ignores an
 * unknown message type is not equally harmless for every type. Dropping a
 * notification costs a missing line; dropping a request deadlocks whatever is
 * waiting on the answer."* The worker is such a surface too, and nothing was
 * checking it. This is that check.
 *
 * It is deliberately derived from the **content script's** source rather than
 * from a list kept here: a hand-maintained list is the thing that drifted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, '../..', p), 'utf8');

const bridge = read('content-scripts/gemini-bridge.js');
const worker = read('src/background/main.js');

/** Every `type:` a `safeSend(...)` call in the content script can carry. */
function typesSentFromPage(src) {
  const found = new Set();
  // safeSend({ type: 'x', ... }) — the only way the page reaches the worker.
  for (const m of src.matchAll(/safeSend\(\s*\{[\s\S]{0,400}?type:\s*'([a-z_]+)'/g)) {
    found.add(m[1]);
  }
  return found;
}

/** Every `case 'x':` in the worker's `chrome.runtime.onMessage` switch. */
function typesRelayedByWorker(src) {
  const start = src.indexOf('chrome.runtime.onMessage.addListener');
  assert.ok(start > -1, 'the worker no longer has an onMessage listener');
  const end = src.indexOf('chrome.alarms.onAlarm', start);
  const body = src.slice(start, end === -1 ? undefined : end);
  return new Set([...body.matchAll(/case\s+'([a-z_]+)'\s*:/g)].map((m) => m[1]));
}

const sent = typesSentFromPage(bridge);
const relayed = typesRelayedByWorker(worker);

test('the content script does send messages this test can see', () => {
  // A regex that matches nothing passes every assertion below, which is the
  // way this file would rot into a green no-op.
  assert.ok(sent.size >= 3, `only found ${sent.size} sent types — the scrape has broken`);
  assert.ok(sent.has('model_options'), 'model_options is the one this was written for');
});

test('every type the page sends has a relay in the worker', () => {
  const dropped = [...sent].filter((t) => !relayed.has(t));
  assert.deepEqual(dropped, [],
    `the worker would drop these before they reach the agent: ${dropped.join(', ')}. `
    + 'Add a case to the relay switch in src/background/main.js.');
});

/*
 * And the negative control for the guard itself: a type nobody sends must not
 * be treated as relayed, or the check above would pass against an empty world.
 */
test('a type nobody sends is not claimed to be relayed', () => {
  assert.equal(relayed.has('a_type_that_does_not_exist'), false);
});

/*
 * The systemic half. Even with the list correct today, the *next* message type
 * added to the page is dropped in silence unless the fallback says so — and a
 * console line alone dies with the worker, which MV3 evicts constantly.
 */
test('an unrelayed type is reported to the server, not just to the console', () => {
  const start = worker.indexOf('default:', worker.indexOf('chrome.runtime.onMessage.addListener'));
  const arm = worker.slice(start, start + 900);
  assert.match(arm, /sendToServer\(/,
    'the default arm answers the sender and tells the agent nothing, which is how '
    + 'model_options vanished between two processes with no trace in either');
  assert.match(arm, /unrelayed_message/);
});
