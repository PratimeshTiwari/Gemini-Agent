/**
 * The decisions the socket makes, separated from the socket.
 *
 * `src/background/` is where every connectivity bug in this project has lived,
 * and it had no tests — not because it needs a browser, but because the logic
 * was tangled into code that does. Reconnect timing and port resolution are
 * arithmetic and validation; they run under `node --test` with nothing mocked.
 *
 * The bug this exists to make impossible again: `RECONNECT_MAX` was 30000 and
 * `chrome.alarms` clamps to a 30-second floor, so the whole 1s→2s→4s→8s→16s
 * ladder collapsed to a constant. Every retry was 30 seconds and the arithmetic
 * above it was decorative. Nothing failed, nothing logged, and the symptom was
 * "the extension takes half a minute to notice the agent is running".
 */

/** How long to wait before each successive attempt, then this cadence forever. */
export const RETRY_LADDER_MS = [250, 500, 1000, 2000, 4000, 8000];
export const RETRY_STEADY_MS = 5000;

/**
 * `chrome.alarms` will not schedule anything shorter than this, whatever it is
 * asked for. Any retry delay at or above it is indistinguishable from the
 * backstop alarm, which is what made the old ladder invisible.
 */
export const ALARM_FLOOR_MS = 30000;

export const DEFAULT_PORT = 7777;

/**
 * The delay before attempt `n` (zero-based), while the worker is alive.
 *
 * @param {number} attempt
 * @returns {number} milliseconds
 */
export function retryDelay(attempt) {
  const n = Number.isInteger(attempt) && attempt >= 0 ? attempt : 0;
  return RETRY_LADDER_MS[n] ?? RETRY_STEADY_MS;
}

/**
 * The port to dial, from whatever was in storage.
 *
 * `--port` is a documented server flag, so this cannot be a constant — and it
 * cannot be discovered either, so it is a setting with the same default the
 * server uses. Anything that is not a usable port falls back rather than
 * throwing: a bad value in storage should cost you the default, not the bridge.
 */
export function resolvePort(stored) {
  const n = parseInt(stored, 10);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_PORT;
}

/** The address, which is deliberately not `localhost`. */
export function socketUrlFor(port) {
  return `ws://127.0.0.1:${resolvePort(port)}`;
}
