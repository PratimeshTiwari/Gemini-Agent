import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  retryDelay, resolvePort, socketUrlFor,
  RETRY_LADDER_MS, RETRY_STEADY_MS, ALARM_FLOOR_MS, DEFAULT_PORT,
} from '../../src/background/policy.js';

describe('retryDelay — the ladder that used to be a constant', () => {
  test('climbs, then holds', () => {
    assert.deepEqual(RETRY_LADDER_MS.map((_, i) => retryDelay(i)), RETRY_LADDER_MS);
    assert.equal(retryDelay(RETRY_LADDER_MS.length), RETRY_STEADY_MS);
    assert.equal(retryDelay(99), RETRY_STEADY_MS);
  });

  test('is strictly increasing while it climbs', () => {
    for (let i = 1; i < RETRY_LADDER_MS.length; i++) {
      assert.ok(retryDelay(i) > retryDelay(i - 1), `rung ${i} does not climb`);
    }
  });

  /**
   * The regression, stated as the rule it broke.
   *
   * `RECONNECT_MAX` was 30000 and `chrome.alarms` clamps to a 30-second floor,
   * so every rung of the old ladder resolved to the same 30 seconds as the
   * backstop alarm — the arithmetic above it was decorative, and the symptom
   * was the extension taking half a minute to notice the agent.
   *
   * Any delay at or above the floor is indistinguishable from the alarm, so no
   * rung may reach it. A future edit that raises the ladder "a bit" fails here.
   */
  test('no delay reaches the alarm floor, or the ladder is decorative again', () => {
    for (let i = 0; i < RETRY_LADDER_MS.length + 5; i++) {
      assert.ok(
        retryDelay(i) < ALARM_FLOOR_MS,
        `attempt ${i} waits ${retryDelay(i)}ms, which the alarm floor (${ALARM_FLOOR_MS}ms) swallows`,
      );
    }
  });

  test('the first attempt is fast enough to be worth making', () => {
    // A ladder starting in whole seconds is a ladder nobody notices working.
    assert.ok(retryDelay(0) <= 500);
  });

  test('nonsense attempts fall back to the first rung rather than throwing', () => {
    for (const bad of [-1, 1.5, NaN, undefined, null, 'two']) {
      assert.equal(retryDelay(bad), RETRY_LADDER_MS[0], String(bad));
    }
  });
});

describe('resolvePort — a bad setting costs the default, not the bridge', () => {
  test('takes a usable port', () => {
    assert.equal(resolvePort(7933), 7933);
    assert.equal(resolvePort('7933'), 7933);
  });

  test('refuses what is not one', () => {
    for (const bad of [0, -1, 65536, 99999, 'abc', '', null, undefined, {}]) {
      assert.equal(resolvePort(bad), DEFAULT_PORT, String(bad));
    }
  });

  test('the address is 127.0.0.1, never localhost', () => {
    // `localhost` resolves ::1 first on this machine and the server binds IPv4
    // only. The refused attempt is cheap, but the literal says what it means.
    assert.equal(socketUrlFor(7933), 'ws://127.0.0.1:7933');
    assert.equal(socketUrlFor(undefined), `ws://127.0.0.1:${DEFAULT_PORT}`);
    assert.doesNotMatch(socketUrlFor(1), /localhost/);
  });
});
