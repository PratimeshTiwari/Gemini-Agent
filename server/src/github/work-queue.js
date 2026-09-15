/**
 * What to analyse, and when — with nothing in it that knows about GitHub.
 *
 * Extracted from `github-event-handler.js`, which did four jobs and called
 * itself glue. This is the first: one item at a time, never the same item
 * twice, and a pause between them.
 *
 * Each of those three rules is paid for by something real:
 *
 * - **One at a time**, because every item drives a browser tab. Two at once is
 *   two Gemini conversations for one repo, and the extension would put them in
 *   different tabs whether or not anyone meant that.
 * - **Never twice**, because the poller re-reports a comment whenever its
 *   watermark overlaps a poll. Without dedup a re-poll writes a second copy of
 *   a review that is already on disk.
 * - **A pause**, because consecutive analyses inside a few seconds is what a
 *   rate limit looks like from the other side.
 *
 * Deliberately not an EventEmitter and deliberately not aware of what an item
 * *is*: the caller says how to run one and what its identity is. That is what
 * makes it testable in milliseconds rather than through a browser.
 */

/** How long to wait after one item before starting the next. */
export const DEFAULT_COOLDOWN_MS = 30_000;

export class WorkQueue {
  /**
   * @param {object} options
   * @param {(item: any) => Promise<void>} options.run - do one item
   * @param {(item: any) => string|number} options.identify - its dedup key
   * @param {number} [options.cooldownMs]
   * @param {(item: any) => void} [options.onStart]
   * @param {(item: any) => void} [options.onFinish]
   * @param {(err: Error, item: any) => void} [options.onError]
   * @param {(ms: number, fn: Function) => any} [options.schedule] - test seam
   */
  constructor({ run, identify, cooldownMs = DEFAULT_COOLDOWN_MS, onStart, onFinish, onError, schedule }) {
    this.run = run;
    this.identify = identify;
    this.cooldownMs = cooldownMs;
    this.onStart = onStart;
    this.onFinish = onFinish;
    this.onError = onError;
    this.schedule = schedule || ((ms, fn) => setTimeout(fn, ms).unref?.());

    this.items = [];
    this.busy = false;
    /** What is being worked on right now, for the UI to report. */
    this.current = null;
    this.done = new Set();
  }

  /**
   * Offer an item. Ignored if it has been seen, unless forced.
   *
   * @returns {boolean} whether it was accepted
   */
  add(item, { force = false } = {}) {
    const key = this.identify(item);
    if (!force) {
      if (this.done.has(key)) return false;
      if (this.items.some((queued) => this.identify(queued) === key)) return false;
    }
    this.items.push(item);
    this._drain();
    return true;
  }

  /** How many are waiting, not counting the one in flight. */
  get length() {
    return this.items.length;
  }

  async _drain() {
    if (this.busy || this.items.length === 0) return;

    this.busy = true;
    const item = this.items.shift();
    this.done.add(this.identify(item));
    this.current = item;
    this.onStart?.(item);

    try {
      await this.run(item);
    } catch (err) {
      // Caught, not just released. `_drain` is started without being awaited —
      // it has to be, or `add` would block on a browser turn — so a throw here
      // becomes an **unhandled rejection**, which Node may answer by taking the
      // process down. A background analysis failing must not stop the CLI.
      //
      // The extracted original got away with it because `_analyzeComment`
      // happened to catch its own errors; nothing made that a requirement, and
      // a queue that only works when its work never throws is a trap for the
      // next caller.
      this.onError?.(err, item);
    } finally {
      // The lock is released whatever happened, or every later item queues
      // behind one that already failed, for the rest of the session.
      this.current = null;
      this.busy = false;
      this.onFinish?.(item);
      if (this.items.length > 0) this.schedule(this.cooldownMs, () => this._drain());
    }
  }
}
